/**
 * Comment Input Component
 *
 * Text input and submit button for posting new comments.
 * Handles form submission and input state.
 *
 * @module components/CommentInput
 */

import { useState, FormEvent } from 'react';

/** Props for the CommentInput component */
interface CommentInputProps {
  /** Callback when a comment is submitted */
  onSubmit: (content: string) => void;
  /** Whether input is disabled (e.g., not connected) */
  disabled?: boolean;
}

/**
 * Renders the comment input form.
 * Clears input after successful submission.
 *
 * @param props - Component props with onSubmit handler
 * @returns Comment input form JSX
 */
export function CommentInput({ onSubmit, disabled }: CommentInputProps) {
  const [content, setContent] = useState('');

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = content.trim();
    if (trimmed && !disabled) {
      onSubmit(trimmed);
      setContent('');
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 p-2 border-t border-white/10">
      <input
        type="text"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={disabled ? 'Connecting...' : 'Write a comment...'}
        disabled={disabled}
        maxLength={500}
        className="flex-1 bg-white/10 text-white rounded-full px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={disabled || !content.trim()}
        className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-full px-4 py-2 text-sm font-semibold transition-colors"
      >
        Send
      </button>
    </form>
  );
}
