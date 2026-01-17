import { useState } from 'react';
import { api } from '../../services/api';

/**
 * ManagementTab - Admin management interface for system operations.
 * Provides controls for rebuilding the trie, clearing cache,
 * adding phrases, and filtering inappropriate content.
 */
export function ManagementTab() {
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [newPhrase, setNewPhrase] = useState('');
  const [newCount, setNewCount] = useState('1');
  const [filterPhrase, setFilterPhrase] = useState('');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  /**
   * Displays a temporary message to the user.
   * Message auto-dismisses after 3 seconds.
   */
  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 3000);
  };

  /**
   * Initiates a trie rebuild after user confirmation.
   */
  const handleRebuildTrie = async () => {
    if (!confirm('Are you sure you want to rebuild the trie? This may take a few seconds.')) {
      return;
    }

    setIsRebuilding(true);
    try {
      const result = await api.rebuildTrie();
      showMessage('success', result.message);
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to rebuild trie');
    } finally {
      setIsRebuilding(false);
    }
  };

  /**
   * Clears the suggestion cache.
   */
  const handleClearCache = async () => {
    setIsClearing(true);
    try {
      const result = await api.clearCache();
      showMessage('success', result.message);
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to clear cache');
    } finally {
      setIsClearing(false);
    }
  };

  /**
   * Adds a new phrase to the typeahead index.
   */
  const handleAddPhrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPhrase.trim()) return;

    try {
      await api.addPhrase(newPhrase.trim(), parseInt(newCount) || 1);
      showMessage('success', `Added phrase: ${newPhrase}`);
      setNewPhrase('');
      setNewCount('1');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to add phrase');
    }
  };

  /**
   * Adds a phrase to the filter list to prevent it from appearing in suggestions.
   */
  const handleFilterPhrase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!filterPhrase.trim()) return;

    try {
      await api.filterPhrase(filterPhrase.trim());
      showMessage('success', `Filtered phrase: ${filterPhrase}`);
      setFilterPhrase('');
    } catch (err) {
      showMessage('error', err instanceof Error ? err.message : 'Failed to filter phrase');
    }
  };

  return (
    <div className="space-y-6">
      <MessageBanner message={message} />
      <SystemActionsSection
        isRebuilding={isRebuilding}
        isClearing={isClearing}
        onRebuildTrie={handleRebuildTrie}
        onClearCache={handleClearCache}
      />
      <AddPhraseSection
        newPhrase={newPhrase}
        newCount={newCount}
        onPhraseChange={setNewPhrase}
        onCountChange={setNewCount}
        onSubmit={handleAddPhrase}
      />
      <FilterPhraseSection
        filterPhrase={filterPhrase}
        onFilterPhraseChange={setFilterPhrase}
        onSubmit={handleFilterPhrase}
      />
    </div>
  );
}

/**
 * MessageBanner - Displays success or error messages.
 */
interface MessageBannerProps {
  message: { type: 'success' | 'error'; text: string } | null;
}

function MessageBanner({ message }: MessageBannerProps) {
  if (!message) return null;

  return (
    <div
      className={`p-4 rounded-lg ${
        message.type === 'success' ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'
      }`}
    >
      {message.text}
    </div>
  );
}

/**
 * SystemActionsSection - Contains system management action buttons.
 */
interface SystemActionsSectionProps {
  isRebuilding: boolean;
  isClearing: boolean;
  onRebuildTrie: () => void;
  onClearCache: () => void;
}

function SystemActionsSection({
  isRebuilding,
  isClearing,
  onRebuildTrie,
  onClearCache,
}: SystemActionsSectionProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="font-semibold text-gray-900 mb-4">System Actions</h3>
      <div className="flex flex-wrap gap-4">
        <button
          onClick={onRebuildTrie}
          disabled={isRebuilding}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRebuilding ? 'Rebuilding...' : 'Rebuild Trie'}
        </button>
        <button
          onClick={onClearCache}
          disabled={isClearing}
          className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isClearing ? 'Clearing...' : 'Clear Cache'}
        </button>
      </div>
    </div>
  );
}

/**
 * AddPhraseSection - Form for adding new phrases to the typeahead index.
 */
interface AddPhraseSectionProps {
  newPhrase: string;
  newCount: string;
  onPhraseChange: (value: string) => void;
  onCountChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

function AddPhraseSection({
  newPhrase,
  newCount,
  onPhraseChange,
  onCountChange,
  onSubmit,
}: AddPhraseSectionProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="font-semibold text-gray-900 mb-4">Add Phrase</h3>
      <form onSubmit={onSubmit} className="flex flex-wrap gap-4">
        <input
          type="text"
          value={newPhrase}
          onChange={(e) => onPhraseChange(e.target.value)}
          placeholder="Phrase"
          className="flex-1 min-w-[200px] px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <input
          type="number"
          value={newCount}
          onChange={(e) => onCountChange(e.target.value)}
          placeholder="Count"
          className="w-24 px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
        >
          Add
        </button>
      </form>
    </div>
  );
}

/**
 * FilterPhraseSection - Form for filtering unwanted phrases from suggestions.
 */
interface FilterPhraseSectionProps {
  filterPhrase: string;
  onFilterPhraseChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
}

function FilterPhraseSection({
  filterPhrase,
  onFilterPhraseChange,
  onSubmit,
}: FilterPhraseSectionProps) {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="font-semibold text-gray-900 mb-4">Filter Phrase</h3>
      <p className="text-sm text-gray-500 mb-4">
        Remove inappropriate or unwanted phrases from suggestions
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap gap-4">
        <input
          type="text"
          value={filterPhrase}
          onChange={(e) => onFilterPhraseChange(e.target.value)}
          placeholder="Phrase to filter"
          className="flex-1 min-w-[200px] px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          type="submit"
          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
        >
          Filter
        </button>
      </form>
    </div>
  );
}
