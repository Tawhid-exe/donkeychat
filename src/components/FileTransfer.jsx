import React from 'react';
import { useTransferProgress } from '../hooks/useTransferProgress';
import { formatFileSize } from '../chat/messages';

export function FileTransfer({ meta, onCancel, onAccept, status }) {
  const { barRef, textRef } = useTransferProgress();

  const isPending = status === 'pending_accept';

  return (
    <div className="bg-gray-800 rounded-lg p-4 max-w-sm w-full shadow-lg border border-gray-700/50 backdrop-blur-md">
      <div className="flex items-center gap-3 mb-3">
        <div className="w-10 h-10 bg-blue-500/20 text-blue-400 rounded-full flex items-center justify-center flex-shrink-0">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{meta.fileName}</p>
          <span ref={textRef} className="text-xs text-gray-400">
            {isPending ? `${formatFileSize(meta.fileSize)} — waiting for accept` : `0.0 / ${formatFileSize(meta.fileSize)}`}
          </span>
        </div>
        {onCancel && (
          <button onClick={onCancel} className="p-1 text-gray-400 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* FIX #5: Accept button for FSA mode */}
      {isPending && onAccept ? (
        <button
          onClick={onAccept}
          className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors shadow-lg shadow-emerald-900/20"
        >
          Accept & Choose Save Location
        </button>
      ) : (
        <div className="relative h-1.5 w-full bg-gray-700 rounded-full overflow-hidden">
          <div
            ref={barRef}
            className="absolute top-0 left-0 h-full bg-blue-500 rounded-full"
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
