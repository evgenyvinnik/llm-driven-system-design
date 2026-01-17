/**
 * UserSearchDropdown component for searching and selecting users.
 * Displays search results in a dropdown as the user types.
 */

import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { Avatar } from '../Avatar';
import { Input } from '../Input';

/**
 * User search result type.
 */
export interface UserSearchResult {
  id: string;
  username: string;
  name: string;
  avatar_url: string;
}

/**
 * Props for the UserSearchDropdown component.
 */
interface UserSearchDropdownProps {
  /** Label for the input field */
  label: string;
  /** Current input value */
  value: string;
  /** Callback when input value changes */
  onChange: (value: string) => void;
  /** Callback when a user is selected from the dropdown */
  onSelect: (user: UserSearchResult) => void;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Whether the field is required */
  required?: boolean;
}

/**
 * Renders a user search input with auto-complete dropdown.
 * Searches for users as the user types and displays matching results.
 */
export function UserSearchDropdown({
  label,
  value,
  onChange,
  onSelect,
  placeholder = 'Enter username',
  required = false,
}: UserSearchDropdownProps) {
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);

  /**
   * Search for users when input value changes (debounced).
   */
  useEffect(() => {
    const searchUsers = async () => {
      if (value.length < 2) {
        setSearchResults([]);
        return;
      }

      try {
        const results = await api.searchUsers(value);
        setSearchResults(results);
        setShowDropdown(true);
      } catch {
        setSearchResults([]);
      }
    };

    const debounce = setTimeout(searchUsers, 300);
    return () => clearTimeout(debounce);
  }, [value]);

  /**
   * Handles selection of a user from the dropdown.
   */
  const handleSelect = (user: UserSearchResult) => {
    onSelect(user);
    onChange(user.username);
    setShowDropdown(false);
    setSearchResults([]);
  };

  return (
    <div className="relative">
      <Input
        label={label}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
      />

      {showDropdown && searchResults.length > 0 && (
        <div className="absolute z-10 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-60 overflow-auto">
          {searchResults.map((user) => (
            <button
              key={user.id}
              type="button"
              onClick={() => handleSelect(user)}
              className="w-full flex items-center gap-3 p-3 hover:bg-gray-50 transition-colors text-left"
            >
              <Avatar src={user.avatar_url} name={user.name} size="sm" />
              <div>
                <p className="font-medium">{user.name}</p>
                <p className="text-sm text-gray-500">@{user.username}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Props for the SelectedUserCard component.
 */
interface SelectedUserCardProps {
  /** The selected user to display */
  user: UserSearchResult;
}

/**
 * Displays a card showing the selected user's avatar and info.
 */
export function SelectedUserCard({ user }: SelectedUserCardProps) {
  return (
    <div className="mt-2 flex items-center gap-2 p-2 bg-blue-50 rounded-lg">
      <Avatar src={user.avatar_url} name={user.name} size="sm" />
      <div>
        <p className="font-medium">{user.name}</p>
        <p className="text-sm text-gray-500">@{user.username}</p>
      </div>
    </div>
  );
}
