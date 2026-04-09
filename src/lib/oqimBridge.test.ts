/**
 * Contract tests for the OQIM postMessage bridge.
 * Verifies that every event sent to the parent frame matches the
 * schema defined in the PRD (Issue #37).
 *
 * These tests mock rootScope and managers — they verify event SHAPE,
 * not Web K internals.
 */

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// ── Mocks ─────────────────────────────────────────────────

// Capture rootScope event listeners so we can fire them manually
const listeners: Record<string, Function> = {};
const mockManagers = {
  dialogsStorage: {
    getDialogs: vi.fn()
  },
  appMessagesManager: {
    sendText: vi.fn(),
    getHistory: vi.fn()
  }
};

vi.mock('@lib/rootScope', () => ({
  default: {
    addEventListener: vi.fn((event: string, handler: Function) => {
      listeners[event] = handler;
    }),
    managers: mockManagers
  }
}));

vi.mock('@lib/appImManager', () => ({
  default: {
    setInnerPeer: vi.fn()
  }
}));

// Capture postMessage calls
const postMessageSpy = vi.fn();
const originalParent = window.parent;

// ── Setup / Teardown ──────────────────────────────────────

beforeEach(() => {
  // Make window think it's in an iframe
  Object.defineProperty(window, 'parent', {
    value: {postMessage: postMessageSpy},
    writable: true,
    configurable: true
  });

  // Reset
  postMessageSpy.mockClear();
  Object.keys(listeners).forEach((k) => delete listeners[k]);
  vi.clearAllMocks();

  // Mock getDialogs to return empty by default (prevents init errors)
  mockManagers.dialogsStorage.getDialogs.mockResolvedValue({
    dialogs: []
  });
});

afterEach(() => {
  Object.defineProperty(window, 'parent', {
    value: originalParent,
    writable: true,
    configurable: true
  });
});

// ── Helper ────────────────────────────────────────────────

function initBridge() {
  // Reset initialized flag by re-importing
  vi.resetModules();
  return import('./oqimBridge').then((m) => m.initOqimBridge());
}

function findPost(type: string) {
  const call = postMessageSpy.mock.calls.find(
    (args: any[]) => args[0]?.type === type
  );
  return call?.[0];
}

// ── Contract: bridge:ready ────────────────────────────────

describe('bridge:ready', () => {
  it('fires on init with ts number', async() => {
    await initBridge();
    const event = findPost('bridge:ready');
    expect(event).toBeDefined();
    expect(event.payload).toHaveProperty('ts');
    expect(typeof event.payload.ts).toBe('number');
  });
});

// ── Contract: dialog:list ─────────────────────────────────

describe('dialog:list', () => {
  it('fires on init with array of dialog objects', async() => {
    mockManagers.dialogsStorage.getDialogs.mockResolvedValue({
      dialogs: [
        {_: 'dialog', peerId: '123' as any, top_message: 42, unread_count: 3, unread_mentions_count: 0, folder_id: 0},
        {_: 'dialog', peerId: '456' as any, top_message: 99, unread_count: 0, unread_mentions_count: 1, folder_id: 0}
      ]
    });

    await initBridge();

    // Wait for async sendInitialDialogList
    await new Promise((r) => setTimeout(r, 50));

    const event = findPost('dialog:list');
    expect(event).toBeDefined();
    expect(Array.isArray(event.payload)).toBe(true);
    expect(event.payload.length).toBe(2);

    const d = event.payload[0];
    expect(d).toHaveProperty('chatId');
    expect(d).toHaveProperty('topMessage');
    expect(d).toHaveProperty('unreadCount');
    expect(d).toHaveProperty('unreadMentionsCount');
    expect(d).toHaveProperty('folderId');
    expect(typeof d.chatId).toBe('string');
    expect(typeof d.topMessage).toBe('number');
    expect(typeof d.unreadCount).toBe('number');
  });

  it('filters out non-dialog entries (forumTopic, savedDialog)', async() => {
    mockManagers.dialogsStorage.getDialogs.mockResolvedValue({
      dialogs: [
        {_: 'dialog', peerId: '123' as any, top_message: 1, unread_count: 0, unread_mentions_count: 0, folder_id: 0},
        {_: 'forumTopic', peerId: '789' as any}
      ]
    });

    await initBridge();
    await new Promise((r) => setTimeout(r, 50));

    const event = findPost('dialog:list');
    expect(event.payload.length).toBe(1);
    expect(event.payload[0].chatId).toBe('123');
  });
});

// ── Contract: message:new ─────────────────────────────────

describe('message:new', () => {
  it('has correct schema when history_multiappend fires', async() => {
    await initBridge();

    const handler = listeners['history_multiappend'];
    expect(handler).toBeDefined();

    handler({
      peerId: '12345',
      fromId: '67890',
      mid: 100,
      message: 'Salom, narxi qancha?',
      date: 1700000000,
      pFlags: {},
      media: null,
      reply_to: null
    });

    const event = findPost('message:new');
    expect(event).toBeDefined();
    expect(event.payload).toEqual({
      chatId: '12345',
      senderId: '67890',
      messageId: 100,
      text: 'Salom, narxi qancha?',
      date: 1700000000,
      isOutgoing: false,
      mediaType: null,
      replyToMsgId: null
    });
  });

  it('marks outgoing messages correctly', async() => {
    await initBridge();
    listeners['history_multiappend']({
      peerId: '12345',
      fromId: '12345',
      mid: 101,
      message: 'Ha, bor!',
      date: 1700000001,
      pFlags: {out: true},
      media: null,
      reply_to: null
    });

    const event = findPost('message:new');
    expect(event.payload.isOutgoing).toBe(true);
  });

  it('includes media type when present', async() => {
    await initBridge();
    listeners['history_multiappend']({
      peerId: '12345',
      fromId: '67890',
      mid: 102,
      message: '',
      date: 1700000002,
      pFlags: {},
      media: {_: 'messageMediaPhoto'},
      reply_to: null
    });

    const event = findPost('message:new');
    expect(event.payload.mediaType).toBe('messageMediaPhoto');
  });

  it('includes replyToMsgId when present', async() => {
    await initBridge();
    listeners['history_multiappend']({
      peerId: '12345',
      fromId: '67890',
      mid: 103,
      message: 'reply text',
      date: 1700000003,
      pFlags: {},
      media: null,
      reply_to: {reply_to_msg_id: 50}
    });

    const event = findPost('message:new');
    expect(event.payload.replyToMsgId).toBe(50);
  });
});

// ── Contract: message:edit ────────────────────────────────

describe('message:edit', () => {
  it('has correct schema when message_edit fires', async() => {
    await initBridge();

    const handler = listeners['message_edit'];
    expect(handler).toBeDefined();

    handler({
      message: {
        peerId: '12345',
        fromId: '67890',
        mid: 100,
        message: 'Edited text',
        date: 1700000010,
        pFlags: {},
        media: null,
        reply_to: null
      }
    });

    const event = findPost('message:edit');
    expect(event).toBeDefined();
    expect(event.payload.chatId).toBe('12345');
    expect(event.payload.messageId).toBe(100);
    expect(event.payload.text).toBe('Edited text');
  });
});

// ── Contract: message:delete ──────────────────────────────

describe('message:delete', () => {
  it('has correct schema when history_delete fires', async() => {
    await initBridge();

    const handler = listeners['history_delete'];
    expect(handler).toBeDefined();

    handler({
      peerId: '12345',
      msgs: new Set([100, 101, 102])
    });

    const event = findPost('message:delete');
    expect(event).toBeDefined();
    expect(event.payload.chatId).toBe('12345');
    expect(event.payload.messageIds).toEqual([100, 101, 102]);
  });
});

// ── Contract: dialog:update ───────────────────────────────

describe('dialog:update', () => {
  it('fires when dialogs_multiupdate triggers', async() => {
    await initBridge();

    const handler = listeners['dialogs_multiupdate'];
    expect(handler).toBeDefined();

    const updates = new Map();
    updates.set('12345', {
      dialog: {_: 'dialog', top_message: 200, unread_count: 5, unread_mentions_count: 0, folder_id: 0}
    });

    handler(updates);

    const event = findPost('dialog:update');
    expect(event).toBeDefined();
    expect(Array.isArray(event.payload)).toBe(true);
    expect(event.payload[0]).toHaveProperty('chatId');
    expect(event.payload[0]).toHaveProperty('unreadCount');
    expect(event.payload[0].unreadCount).toBe(5);
  });

  it('fires on dialog_unread with unread count', async() => {
    await initBridge();

    const handler = listeners['dialog_unread'];
    expect(handler).toBeDefined();

    handler({
      peerId: '12345',
      dialog: {_: 'dialog', unread_count: 3}
    });

    // dialog_unread also emits dialog:update
    const calls = postMessageSpy.mock.calls.filter(
      (args: any[]) => args[0]?.type === 'dialog:update'
    );
    expect(calls.length).toBeGreaterThan(0);
  });
});

// ── Contract: history:batch (via request:history) ─────────

describe('history:batch', () => {
  it('returns messages for a specific chat via request:history command', async() => {
    mockManagers.appMessagesManager.getHistory.mockResolvedValue({
      messages: [
        {peerId: '123', fromId: '123', mid: 1, message: 'Ha bor', date: 1700000000, pFlags: {out: true}, media: null, reply_to: null},
        {peerId: '123', fromId: '456', mid: 2, message: 'Rahmat', date: 1700000001, pFlags: {}, media: null, reply_to: null}
      ]
    });

    // Need to add a toPeerId mock for the string
    (String.prototype as any).toPeerId = function() { return this; };

    await initBridge();

    // Dispatch request:history command (same as parent would send)
    window.dispatchEvent(new MessageEvent('message', {
      data: {type: 'request:history', payload: {chatId: '123', limit: 10}}
    }));

    // Wait for async processing
    await new Promise((r) => setTimeout(r, 100));

    const event = findPost('history:batch');
    expect(event).toBeDefined();
    expect(event.payload.chatId).toBe('123');
    expect(Array.isArray(event.payload.messages)).toBe(true);
    expect(event.payload.messages.length).toBe(2);
    expect(event.payload.messages[0]).toHaveProperty('chatId');
    expect(event.payload.messages[0]).toHaveProperty('text');
    expect(event.payload.total).toBe(2);

    // Cleanup
    delete (String.prototype as any).toPeerId;
  });
});

// ── Contract: not in iframe → no events ───────────────────

describe('iframe detection', () => {
  it('does not post events when window.parent === window', async() => {
    // Restore parent to self
    Object.defineProperty(window, 'parent', {
      value: window,
      writable: true,
      configurable: true
    });

    await initBridge();

    // No postMessage calls should have been made
    expect(postMessageSpy).not.toHaveBeenCalled();
  });
});

// ── Contract: send:confirmed ──────────────────────────────

describe('send:confirmed', () => {
  it('fires when message_sent event triggers after a send', async() => {
    await initBridge();

    const handler = listeners['message_sent'];
    expect(handler).toBeDefined();

    handler({
      storageKey: 'test',
      tempId: 9999,
      tempMessage: {},
      mid: 12345,
      message: {
        peerId: '100',
        fromId: '100',
        mid: 12345,
        message: 'Ha bor aka',
        date: 1700000000,
        pFlags: {out: true},
        media: null,
        reply_to: null
      }
    });

    const event = findPost('send:confirmed');
    expect(event).toBeDefined();
    expect(event.payload.chatId).toBe('100');
    expect(event.payload.messageId).toBe(12345);
    expect(event.payload.tempId).toBe(9999);
  });
});

// ── Contract: navigate:chat ───────────────────────────────

describe('navigate:chat', () => {
  it('calls setInnerPeer when navigate:chat command received', async() => {
    (String.prototype as any).toPeerId = function() { return this; };

    await initBridge();

    window.dispatchEvent(new MessageEvent('message', {
      data: {type: 'navigate:chat', payload: {chatId: '555'}}
    }));

    await new Promise((r) => setTimeout(r, 50));

    const {default: appImManager} = await import('@lib/appImManager');
    expect(appImManager.setInnerPeer).toHaveBeenCalledWith({peerId: '555'});

    delete (String.prototype as any).toPeerId;
  });
});

// ── Contract: send:message ────────────────────────────────

describe('send:message', () => {
  it('calls sendText when send:message command received', async() => {
    (String.prototype as any).toPeerId = function() { return this; };

    await initBridge();

    window.dispatchEvent(new MessageEvent('message', {
      data: {type: 'send:message', payload: {chatId: '777', text: 'Draft approved!'}}
    }));

    await new Promise((r) => setTimeout(r, 50));

    expect(mockManagers.appMessagesManager.sendText).toHaveBeenCalledWith({
      peerId: '777',
      text: 'Draft approved!'
    });

    delete (String.prototype as any).toPeerId;
  });
});
