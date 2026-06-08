/**
 * Activity Log — tracks all method upgrades, fallbacks, errors,
 * and connection events across the app. Used by the UI dropdown
 * to show what's happening under the hood.
 */

const MAX_ENTRIES = 200;

class ActivityLog {
  constructor() {
    this.entries = [];
    this.listeners = new Set();
    this._onlineCount = 0;
    this._onlineListeners = new Set();
  }

  /**
   * @param {'info'|'warn'|'error'|'success'|'upgrade'|'fallback'} level
   * @param {string} title - Short summary (e.g., "Tier upgraded")
   * @param {string} detail - Longer explanation
   */
  log(level, title, detail = '') {
    const entry = {
      id: crypto.randomUUID(),
      level,
      title,
      detail,
      timestamp: Date.now()
    };

    this.entries.unshift(entry); // newest first
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }

    this._notify();

    // Also log to console for debugging
    const prefix = {
      info: 'ℹ️', warn: '⚠️', error: '❌',
      success: '✅', upgrade: '⬆️', fallback: '⬇️'
    }[level] || '📋';
    console.log(`${prefix} [DonkeyChat] ${title}${detail ? ': ' + detail : ''}`);
  }

  getEntries() {
    return [...this.entries];
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _notify() {
    for (const fn of this.listeners) {
      fn(this.getEntries());
    }
  }

  // Online user count management
  setOnlineCount(count) {
    this._onlineCount = count;
    for (const fn of this._onlineListeners) {
      fn(count);
    }
  }

  getOnlineCount() {
    return this._onlineCount;
  }

  subscribeOnlineCount(listener) {
    this._onlineListeners.add(listener);
    return () => this._onlineListeners.delete(listener);
  }
}

export const activityLog = new ActivityLog();
