import React from 'react';
import { useTransferProgress } from '../hooks/useTransferProgress';
import { formatFileSize } from '../chat/messages';

export function FileTransfer({ meta, onCancel, onAccept, onDecline, status, declined, error, completed }) {
  const { barRef, textRef } = useTransferProgress(meta.transferId);
  const isPending = status === 'pending_accept';
  const isMedia = meta.fileName && /\.(jpe?g|png|gif|webp|mp4|mov|webm|avi|mkv|heic)$/i.test(meta.fileName);

  return (
    <div className={`relative rounded-lg p-3 w-full ${declined ? 'opacity-50' : ''}`}>
      {isMedia && (
        <div className="absolute top-2 right-2 border border-white/30 text-white/90 text-[8px] font-bold px-1 py-0.5 rounded-sm bg-black/20 tracking-wider">
          HD
        </div>
      )}
      <div className="flex items-center gap-3 mb-2 pr-6">
        <div className={`w-9 h-9 ${completed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-[#ef4444]/20 text-[#ef4444]'} rounded-lg flex items-center justify-center flex-shrink-0`}>
          {completed ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
            </svg>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-[13px] font-medium truncate ${declined ? 'line-through' : ''}`}>{meta.fileName}</p>
          <span ref={textRef} className="text-[11px] opacity-70">
            {declined ? (error ? `Failed: ${error}` : 'Declined') : completed ? `${formatFileSize(meta.fileSize)} — Completed` : isPending ? `${formatFileSize(meta.fileSize)} — tap to accept` : `0 / ${formatFileSize(meta.fileSize)}`}
          </span>
        </div>
      </div>

      {declined || completed ? null : isPending && onAccept ? (
        <div className="flex gap-2 w-full">
          <button
            onClick={onAccept}
            className="flex-1 py-2 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 rounded-lg text-[12px] font-semibold transition-colors border border-emerald-500/20"
          >
            Accept
          </button>
          {onDecline && (
            <button
              onClick={onDecline}
              className="flex-1 py-2 bg-[#ef4444]/20 hover:bg-[#ef4444]/30 text-[#ef4444] rounded-lg text-[12px] font-semibold transition-colors border border-[#ef4444]/20"
            >
              Decline
            </button>
          )}
        </div>
      ) : status === 'active' && onCancel ? (
        <div className="flex gap-2 w-full mt-2">
          <button
            onClick={onCancel}
            className="flex-1 py-1 bg-[#ef4444]/10 hover:bg-[#ef4444]/20 text-[#ef4444] rounded-lg text-[11px] font-semibold transition-colors border border-[#ef4444]/20"
          >
            Cancel Transfer
          </button>
        </div>
      ) : (
        <div className="relative h-1 w-full bg-white/10 rounded-full overflow-hidden">
          <div
            ref={barRef}
            className="absolute top-0 left-0 h-full bg-white/60 rounded-full"
            style={{
              width: '100%',
              transformOrigin: 'left',
              transform: 'scaleX(0)',
              transition: 'transform 0.1s linear',
              willChange: 'transform'
            }}
          />
        </div>
      )}
    </div>
  );
}
