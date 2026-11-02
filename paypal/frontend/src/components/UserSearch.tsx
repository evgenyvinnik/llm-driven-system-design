import { useState, useEffect, useRef } from 'react';
import { usersApi } from '../services/api';
import type { User } from '../types';

interface UserSearchProps {
  onSelect: (user: User | null) => void;
  selected: User | null;
}

/** Debounced user search input with dropdown results for selecting a payment recipient. */
export function UserSearch({ onSelect, selected }: UserSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<User[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [searching, setSearching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (value: string) => {
    setQuery(value);

    if (selected) {
      onSelect(null);
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    if (value.length < 2) {
      setResults([]);
      setShowDropdown(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await usersApi.search(value);
        setResults(res.users);
        setShowDropdown(true);
      } catch {
        setResults([]);
      }
      setSearching(false);
    }, 300);
  };

  const handleSelect = (user: User) => {
    onSelect(user);
    setQuery(user.displayName || user.username);
    setShowDropdown(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <input
        type="text"
        value={query}
        onChange={(e) => handleSearch(e.target.value)}
        className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-paypal-primary ${
          selected ? 'border-paypal-success bg-green-50' : 'border-paypal-border'
        }`}
        placeholder="Search by name, username, or email..."
      />
      {searching && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-paypal-secondary">
          Searching...
        </div>
      )}
      {selected && (
        <button
          onClick={() => {
            onSelect(null);
            setQuery('');
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-paypal-secondary hover:text-paypal-text"
        >
          x
        </button>
      )}

      {showDropdown && results.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-paypal-border rounded-lg shadow-lg max-h-48 overflow-y-auto">
          {results.map((user) => (
            <button
              key={user.id}
              onClick={() => handleSelect(user)}
              className="w-full px-4 py-3 text-left hover:bg-paypal-bg transition-colors border-b border-paypal-border last:border-b-0"
            >
              <div className="font-medium text-sm text-paypal-text">
                {user.displayName || user.username}
              </div>
              <div className="text-xs text-paypal-secondary">@{user.username}</div>
            </button>
          ))}
        </div>
      )}

      {showDropdown && results.length === 0 && query.length >= 2 && !searching && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-paypal-border rounded-lg shadow-lg p-4 text-center text-sm text-paypal-secondary">
          No users found
        </div>
      )}
    </div>
  );
}
