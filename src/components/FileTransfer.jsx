import React from 'react';
import { useTransferProgress } from '../hooks/useTransferProgress';
import { formatFileSize } from '../chat/messages';

export function FileTransfer({ meta, onCancel, onAccept, status }) {
  const { barRef, textRef } = useTransferProgress();
  const isPending = status === 'pending_accept';

  return (
    <div className="rounded-lg p-3 w-full">
      <div className="flex items-center gap-3 mb-2">
        <div className="w-9 h-9 bg-[#ef4444]/20 text-[#ef4444] rounded-lg flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[13px] font-medium truncate">{meta.fileName}</p>
          <span ref={textRef} className="text-[11px] opacity-70">
            {isPending ? `${formatFileSize(meta.fileSize)} — tap to accept` : `0 / ${formatFileSize(meta.fileSize)}`}
          </span>
        </div>
      </div>

      {isPending && onAccept ? (
        <button
          onClick={onAccept}
          className="w-full py-2 bg-white/20 hover:bg-white/30 text-white rounded-lg text-[12px] font-semibold transition-colors"
        >
          Accept & Save
        </button>
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
