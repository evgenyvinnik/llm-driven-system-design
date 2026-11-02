import { useState, useRef } from 'react';
import { fileApi } from '../services/api';
import type { FileAttachment } from '../types';

interface MessageInputProps {
  /** Resolves when the server accepted the message; rejects with a displayable error. */
  onSend: (content: string, fileIds?: string[]) => Promise<void>;
  channelId: string;
  placeholder?: string;
}

/** Message composition input with file attachments and enter-to-send. */
export function MessageInput({ onSend, channelId, placeholder }: MessageInputProps) {
  const [content, setContent] = useState('');
  const [pending, setPending] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = (content.trim().length > 0 || pending.length > 0) && !sending && !uploading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      // Uploaded files travel with the message as fileIds and are attached to
      // it server-side. Before, the upload produced an orphan file row and a
      // "[File: name]" text message with no way to open the file.
      await onSend(
        content.trim(),
        pending.map((f) => f.id),
      );
      setContent('');
      setPending([]);
    } catch (err) {
      // Keep the draft so nothing typed is lost (e.g. access was revoked).
      setError(err instanceof Error ? err.message : 'Message not sent');
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setError('');
    try {
      const { file: uploaded } = await fileApi.upload(channelId, file);
      setPending((p) => [...p, uploaded]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="px-4 pb-4">
      {error && (
        <p data-testid="send-error" className="text-xs text-teams-danger mb-1">
          {error}
        </p>
      )}
      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1">
          {pending.map((f) => (
            <span
              key={f.id}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-teams-chat rounded text-xs text-teams-text"
            >
              📎 {f.filename}
              <button
                type="button"
                onClick={() => setPending((p) => p.filter((x) => x.id !== f.id))}
                className="text-teams-secondary hover:text-teams-danger"
                title="Remove attachment"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        onSubmit={handleSubmit}
        className="bg-teams-surface border border-teams-border rounded-lg flex items-end"
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          className="p-3 text-teams-secondary hover:text-teams-text transition-colors disabled:opacity-50"
          title={uploading ? 'Uploading...' : 'Attach file'}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Type a message...'}
          rows={1}
          className="flex-1 py-3 px-1 resize-none bg-transparent text-sm text-teams-text placeholder-teams-secondary focus:outline-none max-h-32"
          style={{ minHeight: '44px' }}
        />

        <button
          type="submit"
          disabled={!canSend}
          className="p-3 text-teams-primary hover:text-teams-hover disabled:text-teams-border transition-colors"
          title="Send"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>

        <input
          ref={fileInputRef}
          type="file"
          data-testid="file-input"
          onChange={handleFileUpload}
          className="hidden"
        />
      </form>
    </div>
  );
}
