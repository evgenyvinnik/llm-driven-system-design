import { useState, useRef, useEffect } from 'react';
import type { PropertySchema } from '@/types';
import { Check, ChevronDown } from 'lucide-react';

interface PropertyCellProps {
  property: PropertySchema;
  value: unknown;
  onChange: (value: unknown) => void;
}

export default function PropertyCell({ property, value, onChange }: PropertyCellProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  const handleBlur = () => {
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setIsEditing(false);
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  switch (property.type) {
    case 'title':
    case 'text':
      if (isEditing) {
        return (
          <input
            ref={inputRef}
            type="text"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent outline-none"
          />
        );
      }
      return (
        <div
          className="cursor-text min-h-6"
          onClick={() => setIsEditing(true)}
        >
          {String(value || '') || (
            <span className="text-notion-text-secondary">Empty</span>
          )}
        </div>
      );

    case 'number':
      if (isEditing) {
        return (
          <input
            ref={inputRef}
            type="number"
            value={value as number || ''}
            onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent outline-none"
          />
        );
      }
      return (
        <div
          className="cursor-text min-h-6"
          onClick={() => setIsEditing(true)}
        >
          {value !== null && value !== undefined ? String(value) : (
            <span className="text-notion-text-secondary">Empty</span>
          )}
        </div>
      );

    case 'select':
      const options = property.options || [];
      const selectedOption = options.find((o) => o.id === value);

      const colorClasses: Record<string, string> = {
        gray: 'property-tag-gray',
        blue: 'property-tag-blue',
        green: 'property-tag-green',
        yellow: 'property-tag-yellow',
        red: 'property-tag-red',
        purple: 'property-tag-purple',
      };

      return (
        <div className="relative">
          <button
            className="w-full text-left"
            onClick={() => setShowDropdown(!showDropdown)}
          >
            {selectedOption ? (
              <span className={`property-tag ${colorClasses[selectedOption.color] || colorClasses.gray}`}>
                {selectedOption.name}
              </span>
            ) : (
              <span className="text-notion-text-secondary text-sm">Empty</span>
            )}
          </button>

          {showDropdown && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowDropdown(false)} />
              <div className="absolute left-0 top-full z-50 bg-white border border-notion-border rounded-md shadow-lg py-1 min-w-40 mt-1">
                {/* Clear option */}
                <button
                  className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm text-notion-text-secondary"
                  onClick={() => {
                    onChange(null);
                    setShowDropdown(false);
                  }}
                >
                  Clear
                </button>

                {options.map((opt) => (
                  <button
                    key={opt.id}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-notion-hover text-sm"
                    onClick={() => {
                      onChange(opt.id);
                      setShowDropdown(false);
                    }}
                  >
                    <span className={`property-tag ${colorClasses[opt.color] || colorClasses.gray}`}>
                      {opt.name}
                    </span>
                    {opt.id === value && <Check className="w-4 h-4 ml-auto" />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      );

    case 'checkbox':
      return (
        <button
          className="w-5 h-5 border border-notion-border rounded flex items-center justify-center"
          onClick={() => onChange(!value)}
        >
          {value && <Check className="w-4 h-4" />}
        </button>
      );

    case 'date':
      if (isEditing) {
        return (
          <input
            ref={inputRef}
            type="date"
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            onBlur={handleBlur}
            className="w-full bg-transparent outline-none"
          />
        );
      }
      return (
        <div
          className="cursor-text min-h-6 text-sm"
          onClick={() => setIsEditing(true)}
        >
          {value ? String(value) : (
            <span className="text-notion-text-secondary">Empty</span>
          )}
        </div>
      );

    case 'url':
    case 'email':
    case 'phone':
      if (isEditing) {
        return (
          <input
            ref={inputRef}
            type={property.type === 'email' ? 'email' : property.type === 'url' ? 'url' : 'tel'}
            value={String(value || '')}
            onChange={(e) => onChange(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            className="w-full bg-transparent outline-none"
          />
        );
      }
      return (
        <div
          className="cursor-text min-h-6 text-sm"
          onClick={() => setIsEditing(true)}
        >
          {value ? (
            property.type === 'url' ? (
              <a href={String(value)} className="text-notion-accent hover:underline" target="_blank" rel="noopener noreferrer">
                {String(value)}
              </a>
            ) : property.type === 'email' ? (
              <a href={`mailto:${value}`} className="text-notion-accent hover:underline">
                {String(value)}
              </a>
            ) : (
              String(value)
            )
          ) : (
            <span className="text-notion-text-secondary">Empty</span>
          )}
        </div>
      );

    default:
      return (
        <div className="text-notion-text-secondary text-sm">
          {String(value || 'Empty')}
        </div>
      );
  }
}
