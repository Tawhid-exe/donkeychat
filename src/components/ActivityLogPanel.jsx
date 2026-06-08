import React, { useState, useEffect, useRef } from 'react';
import { activityLog } from '../utils/activityLog';

const LEVEL_STYLES = {
  info: { icon: 'ℹ️', bg: 'bg-blue-500/10', border: 'border-blue-500/30', text: 'text-blue-300' },
  warn: { icon: '⚠️', bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-300' },
  error: { icon: '❌', bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-300' },
  success: { icon: '✅', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300' },
  upgrade: { icon: '⬆️', bg: 'bg-purple-500/10', border: 'border-purple-500/30', text: 'text-purple-300' },
  fallback: { icon: '⬇️', bg: 'bg-orange-500/10', border: 'border-orange-500/30', text: 'text-orange-300' },
};

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 1000) return 'just now';
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

export function ActivityLogPanel() {
  const [isOpen, setIsOpen] = useState(false);
  const [entries, setEntries] = useState([]);
  const [onlineCount, setOnlineCount] = useState(0);
  const panelRef = useRef(null);

  useEffect(() => {
    const unsub1 = activityLog.subscribe(setEntries);
    const unsub2 = activityLog.subscribeOnlineCount(setOnlineCount);
    setEntries(activityLog.getEntries());
    setOnlineCount(activityLog.getOnlineCount());
    return () => { unsub1(); unsub2(); };
  }, []);

  // Close on click outside
  useEffect(() => {
    const handler = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hasErrors = entries.some(e => e.level === 'error');
  const hasWarnings = entries.some(e => e.level === 'warn');

  return (
    <div ref={panelRef} className="fixed top-3 left-3 z-50" id="activity-log-panel">
      {/* Online Users Meter + Activity Toggle */}
      <div className="flex items-center gap-2">
        {/* Online count badge */}
        <div
          className="flex items-center gap-2 px-3 py-1.5 bg-[#1c1c24]/95 backdrop-blur-xl border border-gray-700/50 rounded-full shadow-lg cursor-default select-none"
          title="Users currently online on this network"
        >
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <span className="text-xs font-medium text-emerald-300">
            {onlineCount} online
          </span>
        </div>

        {/* Activity log toggle */}
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`flex items-center gap-1.5 px-3 py-1.5 bg-[#1c1c24]/95 backdrop-blur-xl border rounded-full shadow-lg transition-all hover:bg-[#2a2a35]/95 ${
            hasErrors ? 'border-red-500/50' :
            hasWarnings ? 'border-yellow-500/50' :
            'border-gray-700/50'
          }`}
          title="Activity Log"
        >
          <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="text-xs font-medium text-gray-400">Log</span>
          {entries.length > 0 && (
            <span className={`text-[10px] font-bold px-1.5 rounded-full ${
              hasErrors ? 'bg-red-500/20 text-red-400' :
              hasWarnings ? 'bg-yellow-500/20 text-yellow-400' :
              'bg-gray-600/30 text-gray-400'
            }`}>
              {entries.length}
            </span>
          )}
        </button>
      </div>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="mt-2 w-96 max-h-[60vh] bg-[#14141c]/98 backdrop-blur-xl border border-gray-700/50 rounded-xl shadow-2xl overflow-hidden animate-slideDown">
          <div className="px-4 py-3 border-b border-gray-700/50 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-200">Activity Log</h3>
            <span className="text-[10px] text-gray-500">{entries.length} entries</span>
          </div>
          <div className="overflow-y-auto max-h-[calc(60vh-48px)] custom-scrollbar">
            {entries.length === 0 ? (
              <div className="px-4 py-8 text-center text-gray-500 text-sm">
                No activity yet
              </div>
            ) : (
              entries.map(entry => {
                const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
                return (
                  <div
                    key={entry.id}
                    className={`px-4 py-2.5 border-b border-gray-800/50 ${style.bg} hover:bg-white/[0.02] transition-colors`}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-sm flex-shrink-0 mt-0.5">{style.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={`text-xs font-medium ${style.text}`}>{entry.title}</span>
                          <span className="text-[10px] text-gray-600 flex-shrink-0">{timeAgo(entry.timestamp)}</span>
                        </div>
                        {entry.detail && (
                          <p className="text-[11px] text-gray-500 mt-0.5 truncate">{entry.detail}</p>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
