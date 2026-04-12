/*
 * OQIM Business — postMessage bridge for parent frame communication.
 * Issue #37: https://github.com/habiboffdev/oqim-business/issues/37
 *
 * Event schema follows the PRD contract:
 *   Fork → Parent: message:new, message:edit, message:delete,
 *                   dialog:list, dialog:update, history:batch, bridge:ready,
 *                   auth:completed
 *   Parent → Fork: navigate:chat, send:message, request:dialogs,
 *                   request:history, ping
 */

import rootScope from '@lib/rootScope';
import type {Dialog, MyMessage} from '@appManagers/appMessagesManager';

let initialized = false;

// ── Serialization helpers ─────────────────────────────────

function serializeMessage(msg: MyMessage) {
  const m = msg as any;
  return {
    chatId: String(m.peerId),
    senderId: String(m.fromId ?? m.peerId),
    messageId: m.mid,
    text: m.message ?? '',
    date: m.date,
    isOutgoing: !!m.pFlags?.out,
    mediaType: m.media?._ ?? null,
    replyToMsgId: m.reply_to?.reply_to_msg_id ?? null
  };
}

function serializeDialog(peerId: PeerId, dialog: Dialog, displayName?: string) {
  return {
    chatId: String(peerId),
    topMessage: dialog.top_message,
    unreadCount: dialog.unread_count ?? 0,
    unreadMentionsCount: dialog.unread_mentions_count ?? 0,
    folderId: dialog.folder_id ?? 0,
    isUser: peerId.isUser(),
    displayName: displayName || String(peerId)
  };
}

function postToParent(type: string, payload: unknown) {
  if(window.parent === window) return;
  window.parent.postMessage({type, payload}, '*');
}

// ── Inbound commands from parent ──────────────────────────

async function handleParentCommand(event: MessageEvent) {
  const data = event.data;
  if(!data?.type || typeof data.type !== 'string') return;
  const validPrefixes = ['navigate:', 'send:', 'request:', 'mark:', 'set:', 'ping'];
  if(!validPrefixes.some((p) => data.type.startsWith(p))) return;

  const managers = rootScope.managers;
  if(!managers) return;

  switch(data.type) {
    case 'navigate:chat': {
      const {chatId} = data.payload;
      const {default: appImManager} = await import('@lib/appImManager');
      appImManager.setInnerPeer({peerId: chatId.toPeerId()});
      break;
    }

    case 'send:message': {
      const {chatId, text} = data.payload;
      managers.appMessagesManager.sendText({
        peerId: chatId.toPeerId(),
        text
      });
      break;
    }

    case 'request:dialogs': {
      const limit = data.payload?.limit ?? 100;
      const result = await managers.dialogsStorage.getDialogs({
        filterId: 0,
        limit
      });
      const dialogs = result.dialogs
      .filter((d): d is Dialog => d._ === 'dialog')
      .map((d) => serializeDialog(d.peerId, d));
      postToParent('dialog:list', dialogs);
      break;
    }

    case 'request:history': {
      const {chatId, limit = 500, outgoingOnly = false} = data.payload ?? {};
      await fetchAndSendHistory(chatId, limit, outgoingOnly);
      break;
    }

    case 'mark:read': {
      const {chatId} = data.payload ?? {};
      if(chatId) {
        managers.appMessagesManager.readHistory({peerId: chatId.toPeerId()});
      }
      break;
    }

    case 'set:typing': {
      const {chatId, active = true} = data.payload ?? {};
      if(chatId) {
        if(active) {
          managers.appMessagesManager.setTyping(chatId.toPeerId(), {_: 'sendMessageTypingAction'});
        }
        // Typing indicator auto-clears after 5s on Telegram's side
      }
      break;
    }

    case 'ping': {
      postToParent('pong', {ts: Date.now()});
      break;
    }
  }
}

// ── History batch reader ──────────────────────────────────

async function fetchAndSendHistory(
  chatId?: string,
  limit: number = 500,
  outgoingOnly: boolean = false
) {
  const managers = rootScope.managers;
  if(!managers) return;

  // If no chatId, send outgoing messages across all DMs (for voice profile)
  if(!chatId) {
    const dialogResult = await managers.dialogsStorage.getDialogs({filterId: 0, limit: 50});
    const allMessages: ReturnType<typeof serializeMessage>[] = [];

    for(const d of dialogResult.dialogs) {
      if(d._ !== 'dialog') continue;
      try {
        const history = await managers.appMessagesManager.getHistory({
          peerId: d.peerId,
          limit: Math.min(limit, 100),
          offsetId: 0
        });
        for(const msg of history.messages) {
          const m = msg as any;
          if(outgoingOnly && !m.pFlags?.out) continue;
          allMessages.push(serializeMessage(msg));
          if(allMessages.length >= limit) break;
        }
      } catch{
        // Skip chats that fail to load
      }
      if(allMessages.length >= limit) break;
    }

    postToParent('history:batch', {messages: allMessages, total: allMessages.length});
    return;
  }

  // Specific chat history
  try {
    const peerId = String(chatId).toPeerId();
    const history = await managers.appMessagesManager.getHistory({
      peerId,
      limit,
      offsetId: 0
    });
    // history.messages may be undefined if not cached — load from IDs
    let rawMessages = history?.messages;
    if(!rawMessages && history?.history?.length) {
      rawMessages = await Promise.all(
        history.history.map((mid: number) =>
          managers.appMessagesManager.getMessageByPeer(peerId, mid)
        )
      );
    }
    const messages = (rawMessages || [])
    .filter((m: any) => m && (!outgoingOnly || m.pFlags?.out))
    .map(serializeMessage);
    postToParent('history:batch', {chatId, messages, total: messages.length});
  } catch(e: any) {
    postToParent('history:batch', {chatId, messages: [], total: 0, error: String(e?.message || e)});
  }
}

// ── Auto-send dialog list on load ─────────────────────────

async function sendInitialDialogList() {
  const managers = rootScope.managers;
  if(!managers) return;

  try {
    // Fetch all loaded dialogs — Web K caches them from Telegram on login.
    // filterId: 0 = "All Chats". We fetch a large batch then filter to human DMs.
    const result = await managers.dialogsStorage.getDialogs({filterId: 0, limit: 500});
    const dialogs: ReturnType<typeof serializeDialog>[] = [];
    for(const d of result.dialogs) {
      if(d._ !== 'dialog') continue;
      if(!d.peerId.isUser()) continue;
      try { if(await managers.appUsersManager.isBot(d.peerId.toUserId())) continue; } catch{}

      let name = String(d.peerId);
      try {
        const user = await managers.appUsersManager.getUser(d.peerId.toUserId());
        if(user) name = [user.first_name, user.last_name].filter(Boolean).join(' ') || name;
      } catch{ /* use chatId as fallback */ }
      dialogs.push(serializeDialog(d.peerId, d, name));
    }
    console.log(`[OQIM Bridge] dialog:list — ${dialogs.length} human DMs from ${result.dialogs.length} total`);
    postToParent('dialog:list', dialogs);
  } catch(e) {
    console.error('[OQIM Bridge] sendInitialDialogList failed:', e);
  }
}

// ── Initialize ────────────────────────────────────────────

export function initOqimBridge() {
  if(initialized) return;
  initialized = true;

  if(window.parent === window) {
    console.log('[OQIM Bridge] Not in iframe, bridge disabled');
    return;
  }

  console.log('[OQIM Bridge] Initializing...');

  // Apply OQIM theme
  document.documentElement.classList.add('oqim-embed');

  // Listen for commands from parent
  window.addEventListener('message', handleParentCommand);

  // Batch message forwarding: collect messages for 500ms then send as one batch.
  // This prevents flooding the parent with hundreds of individual postMessages
  // when Web K syncs on reconnect. The backend deduplicates by telegram_message_id.
  let pendingMessages: ReturnType<typeof serializeMessage>[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | null = null;
  const forwardedMids = new Set<number>();

  function flushBatch() {
    if(pendingMessages.length === 0) return;
    if(pendingMessages.length === 1) {
      postToParent('message:new', pendingMessages[0]);
    } else {
      postToParent('message:batch', {messages: pendingMessages, count: pendingMessages.length});
    }
    pendingMessages = [];
    batchTimer = null;
  }

  rootScope.addEventListener('history_multiappend', (message) => {
    const m = message as any;
    // Dedup within session
    if(forwardedMids.has(m.mid)) return;
    forwardedMids.add(m.mid);
    if(forwardedMids.size > 10000) {
      const first = forwardedMids.values().next().value;
      if(first !== undefined) forwardedMids.delete(first);
    }

    pendingMessages.push(serializeMessage(message));

    // Flush after 500ms of quiet, or immediately if batch gets large
    if(batchTimer) clearTimeout(batchTimer);
    if(pendingMessages.length >= 50) {
      flushBatch();
    } else {
      batchTimer = setTimeout(flushBatch, 500);
    }
  });

  // message:edit — edited messages
  rootScope.addEventListener('message_edit', ({message}) => {
    postToParent('message:edit', serializeMessage(message));
  });

  // message:delete — deleted messages
  rootScope.addEventListener('history_delete', ({peerId, msgs}) => {
    postToParent('message:delete', {
      chatId: String(peerId),
      messageIds: [...msgs]
    });
  });

  // send:confirmed — delivery confirmation after sendText
  rootScope.addEventListener('message_sent', ({tempId, mid, message}) => {
    const m = message as any;
    postToParent('send:confirmed', {
      chatId: String(m.peerId),
      messageId: mid,
      tempId
    });
  });

  // dialog:update — dialog changes (new message, read state, etc.)
  rootScope.addEventListener('dialogs_multiupdate', (updates) => {
    const dialogs: ReturnType<typeof serializeDialog>[] = [];
    for(const [peerId, data] of updates) {
      if(data.dialog && peerId.isUser()) {
        dialogs.push(serializeDialog(peerId, data.dialog));
      }
    }
    if(dialogs.length) {
      postToParent('dialog:update', dialogs);
    }
  });

  rootScope.addEventListener('dialog_unread', ({peerId, dialog}) => {
    if(!peerId.isUser()) return;
    postToParent('dialog:update', [{
      chatId: String(peerId),
      unreadCount: (dialog as Dialog).unread_count ?? 0
    }]);
  });

  // chat:opened — detect when user opens a chat in Web K
  // Hook into appImManager's peer_changed event (reliable, works with all navigation methods)
  import('@lib/appImManager').then(({default: appImManager}) => {
    appImManager.addEventListener('peer_changed', (chat: any) => {
      const peerId = chat?.peerId;
      if(peerId && peerId.isUser()) {
        postToParent('chat:opened', {chatId: String(peerId)});
      }
    });
  }).catch(() => {});

  // Send initial dialog list
  sendInitialDialogList();

  // auth:completed — emit user data on init (bridge only loads after auth)
  const emitAuthCompleted = async() => {
    try {
      const self = await rootScope.managers.appUsersManager.getSelf();
      if(self) {
        postToParent('auth:completed', {
          userId: String(self.id),
          phone: self.phone ? `+${self.phone}` : '',
          firstName: self.first_name || '',
          lastName: self.last_name || ''
        });
      }
    } catch(e) {
      console.warn('[OQIM Bridge] Failed to get self user:', e);
    }
  };
  emitAuthCompleted();

  // Also emit on account switch
  rootScope.addEventListener('account_logged_in', () => {
    emitAuthCompleted();
  });

  // Notify parent that bridge is ready
  postToParent('bridge:ready', {ts: Date.now()});

  console.log('[OQIM Bridge] Ready');
}

export default initOqimBridge;
