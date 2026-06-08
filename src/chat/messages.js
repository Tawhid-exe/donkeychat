// FIX #7: Message factory helpers as specified in BLAZE_BUILD_DOCS Section 13

export class MessageStore {
  constructor() {
    this.messages = [];
    this.listeners = new Set();
  }

  addMessage(message) {
    this.messages.push({
      ...message,
      id: message.id || crypto.randomUUID(),
      timestamp: message.timestamp || Date.now()
    });
    this.notify();
  }

  getMessages() {
    return [...this.messages];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    for (const listener of this.listeners) {
      listener(this.getMessages());
    }
  }

  clear() {
    this.messages = [];
    this.notify();
  }

  updateMessageByTransferId(transferId, updates) {
    let updated = false;
    this.messages = this.messages.map(msg => {
      if (msg.meta?.transferId === transferId) {
        updated = true;
        return { ...msg, ...updates };
      }
      return msg;
    });
    if (updated) this.notify();
  }
}

// Factory helpers from BLAZE_BUILD_DOCS Section 13
export function createMessage(text, senderId, opts = {}) {
  return {
    text,
    senderId,
    type: 'text',
    ...opts
  };
}

export function createSystemMessage(text) {
  return {
    text,
    senderId: '__system__',
    type: 'system'
  };
}

export function createFileMessage(meta, senderId) {
  return {
    text: `File: ${meta.fileName}`,
    senderId,
    type: 'file',
    meta
  };
}

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export const globalMessageStore = new MessageStore();
