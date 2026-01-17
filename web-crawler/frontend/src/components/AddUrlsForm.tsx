import { useState } from 'react';

interface AddUrlsFormProps {
  onSubmit: (urls: string[], priority?: number) => Promise<void>;
  loading?: boolean;
}

export function AddUrlsForm({ onSubmit, loading }: AddUrlsFormProps) {
  const [urls, setUrls] = useState('');
  const [priority, setPriority] = useState(2);
  const [result, setResult] = useState<{ added: number; total: number } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
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
