/*
 * OQIM Business — postMessage bridge for parent frame communication.
 *
 * This module bridges the Telegram Web K fork with the OQIM parent app
 * via the postMessage API. It provides:
 *
 * 1. Incoming message events → parent (for AI draft generation)
 * 2. Dialog list updates → parent (for unified chat list)
 * 3. Chat navigation ← parent (open specific chat)
 * 4. Send-on-behalf ← parent (send approved AI drafts)
 * 5. Auth state → parent (login status)
 */

import rootScope from '@lib/rootScope';
import type {Dialog} from '@appManagers/appMessagesManager';

let initialized = false;

/** Serialized message payload sent to parent */
interface OqimMessageEvent {
  peerId: string;
  fromId: string;
  mid: number;
  text: string;
  date: number;
  isOutgoing: boolean;
}

/** Serialized dialog payload sent to parent */
interface OqimDialogEvent {
  peerId: string;
  topMessage: number;
  unreadCount: number;
  unreadMentionsCount: number;
  folderId: number;
}

/** Commands the parent can send to the fork */
type OqimCommand =
  | {type: 'oqim:openChat'; payload: {peerId: string}}
  | {type: 'oqim:sendMessage'; payload: {peerId: string; text: string}}
  | {type: 'oqim:getDialogs'; payload?: {limit?: number}}
  | {type: 'oqim:ping'};

function serializeDialog(peerId: PeerId, dialog: Dialog): OqimDialogEvent {
  return {
    peerId: String(peerId),
    topMessage: dialog.top_message,
    unreadCount: dialog.unread_count ?? 0,
    unreadMentionsCount: dialog.unread_mentions_count ?? 0,
    folderId: dialog.folder_id ?? 0
  };
}

function postToParent(type: string, payload: unknown) {
  if(window.parent === window) return; // not in iframe
  window.parent.postMessage({type, payload}, '*');
}

/** Handle commands from the OQIM parent frame */
async function handleParentCommand(event: MessageEvent) {
  const data = event.data as OqimCommand;
  if(!data?.type?.startsWith('oqim:')) return;

  const managers = rootScope.managers;
  if(!managers) return;

  switch(data.type) {
    case 'oqim:openChat': {
      const {peerId} = data.payload;
      // Use dynamic import to avoid circular dependency
      const {default: appImManager} = await import('@lib/appImManager');
      appImManager.setInnerPeer({peerId: peerId.toPeerId()});
      break;
    }

    case 'oqim:sendMessage': {
      const {peerId, text} = data.payload;
      managers.appMessagesManager.sendText({
        peerId: peerId.toPeerId(),
        text
      });
      break;
    }

    case 'oqim:getDialogs': {
      const limit = data.payload?.limit ?? 100;
      const result = await managers.dialogsStorage.getDialogs({
        filterId: 0,
        limit
      });
      const dialogs = result.dialogs
      .filter((d): d is Dialog => d._ === 'dialog')
      .map((d) => serializeDialog(d.peerId, d));
      postToParent('tg:dialogs', dialogs);
      break;
    }

    case 'oqim:ping': {
      postToParent('tg:pong', {ts: Date.now()});
      break;
    }
  }
}

/** Initialize the bridge — call after auth */
export function initOqimBridge() {
  if(initialized) return;
  initialized = true;

  // Skip if not embedded in an iframe
  if(window.parent === window) {
    console.log('[OQIM Bridge] Not in iframe, bridge disabled');
    return;
  }

  console.log('[OQIM Bridge] Initializing...');

  // 0. Apply OQIM theme (Minimal White palette, Geist font, hide sidebar)
  document.documentElement.classList.add('oqim-embed');

  // 1. Listen for commands from parent
  window.addEventListener('message', handleParentCommand);

  // 2. Forward new incoming messages to parent
  rootScope.addEventListener('history_multiappend', (message) => {
    const msg = message as any;
    const event: OqimMessageEvent = {
      peerId: String(msg.peerId),
      fromId: String(msg.fromId ?? msg.peerId),
      mid: msg.mid,
      text: msg.message ?? '',
      date: msg.date,
      isOutgoing: !!msg.pFlags?.out
    };
    postToParent('tg:newMessage', event);
  });

  // 3. Forward dialog list changes to parent
  rootScope.addEventListener('dialogs_multiupdate', (updates) => {
    const dialogs: OqimDialogEvent[] = [];
    for(const [peerId, data] of updates) {
      if(data.dialog) {
        dialogs.push(serializeDialog(peerId, data.dialog));
      }
    }
    if(dialogs.length) {
      postToParent('tg:dialogsUpdate', dialogs);
    }
  });

  // 4. Forward read state changes
  rootScope.addEventListener('dialog_unread', ({peerId, dialog}) => {
    postToParent('tg:dialogUnread', {
      peerId: String(peerId),
      unreadCount: (dialog as Dialog).unread_count ?? 0
    });
  });

  // 5. Notify parent that bridge is ready
  postToParent('tg:bridgeReady', {ts: Date.now()});

  console.log('[OQIM Bridge] Ready');
}

export default initOqimBridge;
