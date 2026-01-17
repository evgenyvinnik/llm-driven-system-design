/**
 * @fileoverview Form component for adding URLs to the frontier.
 *
 * Provides a textarea for entering URLs (one per line) with:
 * - Priority selection dropdown (High/Medium/Low)
 * - Submit button with loading state
 * - Success feedback showing how many URLs were added
 *
 * URLs are validated to ensure they start with http/https.
 * Duplicates and invalid URLs are filtered server-side.
 *
 * @module components/AddUrlsForm
 */

import { useState } from 'react';

/**
 * Props for the AddUrlsForm component.
 */
interface AddUrlsFormProps {
  /** Callback when URLs are submitted */
  onSubmit: (urls: string[], priority?: number) => Promise<void>;
  /** Whether the form is in a loading state */
  loading?: boolean;
}

/**
 * Form for adding URLs to the crawler frontier.
 *
 * Accepts URLs (one per line) and a priority level.
 * Validates URLs client-side and provides feedback on submission.
 *
 * @param props - Component props
 * @returns React component rendering the form
 *
 * @example
 * ```tsx
 * <AddUrlsForm
 *   onSubmit={async (urls, priority) => {
 *     await frontierService.addUrls(urls, priority);
 *   }}
 *   loading={isSubmitting}
 * />
 * ```
 */
export function AddUrlsForm({ onSubmit, loading }: AddUrlsFormProps) {
  /** Textarea content (URLs separated by newlines) */
  const [urls, setUrls] = useState('');
  /** Selected priority level (1=low, 2=medium, 3=high) */
  const [priority, setPriority] = useState(2);
  /** Result of last submission for feedback */
  const [result, setResult] = useState<{ added: number; total: number } | null>(null);

  /**
   * Handles form submission.
   * Parses URLs from textarea, filters invalid ones, and calls onSubmit.
   *
   * @param e - Form submit event
   */
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Parse URLs from textarea, filter empty lines and non-HTTP URLs
    const urlList = urls
      .split('\n')
      .map((u) => u.trim())
      .filter((u) => u.length > 0 && u.startsWith('http'));

    if (urlList.length === 0) return;

    try {
      await onSubmit(urlList, priority);
      setResult({ added: urlList.length, total: urlList.length });
      setUrls('');
    } catch (error) {
      console.error('Failed to add URLs:', error);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="urls" className="block text-sm font-medium text-gray-700 mb-1">
          URLs to Add (one per line)
        </label>
        <textarea
          id="urls"
          value={urls}
          onChange={(e) => setUrls(e.target.value)}
          rows={5}
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
          placeholder="https://example.com&#10;https://another-site.com/page"
        />
      </div>

      <div>
        <label htmlFor="priority" className="block text-sm font-medium text-gray-700 mb-1">
          Priority
        </label>
        <select
          id="priority"
          value={priority}
          onChange={(e) => setPriority(Number(e.target.value))}
          className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
        >
          <option value={3}>High</option>
          <option value={2}>Medium</option>
          <option value={1}>Low</option>
        </select>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 bg-primary-600 text-white rounded-md text-sm font-medium hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading ? 'Adding...' : 'Add URLs'}
        </button>

        {result && (
          <span className="text-sm text-green-600">
            Added {result.added} of {result.total} URLs
          </span>
        )}
      </div>
    </form>
  );
}
