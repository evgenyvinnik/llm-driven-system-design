import { LucideIcon } from 'lucide-react';

/**
 * Tab configuration type.
 */
export interface TabConfig {
  /** Unique key for the tab */
  key: string;
  /** Display label */
  label: string;
  /** Icon component */
  icon: LucideIcon;
}

/**
 * Props for the AdminTabs component.
 */
interface AdminTabsProps {
  /** Array of tab configurations */
  tabs: TabConfig[];
  /** Currently active tab key */
  activeTab: string;
  /** Callback when a tab is selected */
  onTabChange: (tabKey: string) => void;
}

/**
 * AdminTabs renders a horizontal tab navigation bar for the admin dashboard.
 * Each tab displays an icon and label, with visual indication of the active tab.
 *
 * @param props - Component properties
 * @returns Tab navigation component
 */
export function AdminTabs({ tabs, activeTab, onTabChange }: AdminTabsProps) {
  return (
    <div className="border-b mb-6">
      <div className="flex gap-4">
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          const Icon = tab.icon;

          return (
            <button
              key={tab.key}
              onClick={() => onTabChange(tab.key)}
              className={`pb-4 px-2 border-b-2 transition-colors ${
                isActive
                  ? 'border-yelp-red text-yelp-red'
                  : 'border-transparent text-gray-600 hover:text-gray-900'
              }`}
              aria-selected={isActive}
              role="tab"
            >
              <span className="flex items-center gap-2">
                <Icon className="w-5 h-5" />
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Props for the SearchInput component.
 */
interface SearchInputProps {
  /** Current search query value */
  value: string;
  /** Callback when search query changes */
  onChange: (value: string) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Search icon component */
  icon: LucideIcon;
}

/**
 * SearchInput renders a search input field with an icon.
 *
 * @param props - Component properties
 * @returns Search input component
 */
export function SearchInput({ value, onChange, placeholder = 'Search...', icon: Icon }: SearchInputProps) {
  return (
    <div className="mb-4">
      <div className="relative">
        <Icon className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input-field pl-10"
        />
      </div>
    </div>
  );
}
