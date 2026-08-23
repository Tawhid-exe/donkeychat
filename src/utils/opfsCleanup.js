// OPFS orphan sweeper — removes leftover transfer files from previous sessions.
// Media previews intentionally skip immediate cleanup after finalize (the blob
// URL must stay valid while displayed), so stale entries are collected here at
// boot instead. Files written within the last hour are kept to protect
// transfers running in other tabs.

const MIN_AGE_MS = 60 * 60 * 1000;

export async function sweepOrphanedTransfers() {
  try {
    if (!navigator.storage?.getDirectory) return;
    const root = await navigator.storage.getDirectory();

    // OPFS supports async iteration over entries in Chromium
    if (!root.values || !root[Symbol.asyncIterator]) return;

    const now = Date.now();
    for await (const [name, handle] of root.entries()) {
      if (handle.kind !== 'file') continue;
      try {
        const file = await handle.getFile();
        if (now - file.lastModified > MIN_AGE_MS) {
          await root.removeEntry(name);
        }
      } catch {
        // Entry vanished or is unreadable — skip it
      }
    }
  } catch (e) {
    console.warn('OPFS sweep failed:', e);
  }
}
