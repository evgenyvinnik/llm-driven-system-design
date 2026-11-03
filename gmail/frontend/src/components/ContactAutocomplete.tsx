import { useState, useRef, useEffect } from 'react';
import { contactApi } from '../services/api';
import type { Contact } from '../types';

interface ContactAutocompleteProps {
  selected: string[];
  onChange: (emails: string[]) => void;
  placeholder?: string;
}

/** Renders an autocomplete input for email contacts with frequency-ranked suggestions. */
export function ContactAutocomplete({
  selected,
  onChange,
  placeholder = 'Enter email address',
}: ContactAutocompleteProps) {
  const [inputValue, setInputValue] = useState('');
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (inputValue.length < 1) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(async () => {
      try {
        const result = await contactApi.search(inputValue);
        const filtered = result.contacts.filter(
          (c) => !selected.includes(c.email)
        );
        setSuggestions(filtered);
        setShowSuggestions(filtered.length > 0);
      } catch {
        setSuggestions([]);
      }
    }, 200);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [inputValue, selected]);

  const addEmail = (email: string) => {
    if (email && !selected.includes(email)) {
      onChange([...selected, email]);
    }
    setInputValue('');
    setShowSuggestions(false);
    inputRef.current?.focus();
  };

  const removeEmail = (email: string) => {
    onChange(selected.filter((e) => e !== email));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      e.preventDefault();
      const trimmed = inputValue.trim().replace(/,+$/, '');
      if (trimmed && trimmed.includes('@')) {
        addEmail(trimmed);
      }
    }

    if (e.key === 'Backspace' && inputValue === '' && selected.length > 0) {
      removeEmail(selected[selected.length - 1]);
    }
  };

  return (
    <div className="relative flex flex-wrap items-center gap-1 min-h-[32px]">
      {selected.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 bg-gray-100 text-sm text-gmail-text rounded-full px-2 py-0.5"
        >
          {email}
          <button
            onClick={() => removeEmail(email)}
            className="text-gmail-text-secondary hover:text-gmail-text"
          >
            <svg width="14" height="14" viewBox="0 0 24 24">
              <path
                fill="currentColor"
                d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"
              />
            </svg>
          </button>
        </span>
      ))}

      <input
        ref={inputRef}
        type="text"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setTimeout(() => setShowSuggestions(false), 200);
        }}
        placeholder={selected.length === 0 ? placeholder : ''}
        className="flex-1 min-w-[100px] text-sm text-gmail-text outline-none py-1"
      />

      {showSuggestions && (
        <div className="absolute top-full left-0 right-0 bg-white shadow-lg rounded-lg mt-1 z-50 max-h-48 overflow-y-auto border border-gmail-border">
          {suggestions.map((contact) => (
            <button
              key={contact.id}
              onClick={() => addEmail(contact.email)}
              className="w-full text-left px-4 py-2 hover:bg-gmail-hover text-sm"
            >
              <div className="font-medium text-gmail-text">
                {contact.name || contact.email}
              </div>
              {contact.name && (
                <div className="text-xs text-gmail-text-secondary">
                  {contact.email}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
