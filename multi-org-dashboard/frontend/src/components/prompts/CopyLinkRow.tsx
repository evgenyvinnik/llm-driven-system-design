import { useState } from 'react'

/** The raw link is shown once, right after it's created: only its hash is stored. */
export function CopyLinkRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="mb-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 text-xs">
      <p className="mb-1 text-emerald-900">Copy this link now. It won't be shown again.</p>
      <div className="flex gap-2">
        <input className="input font-mono text-xs" readOnly value={url} onFocus={(e) => e.target.select()} aria-label="New share link" />
        <button
          className="btn-secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(url)
            setCopied(true)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
