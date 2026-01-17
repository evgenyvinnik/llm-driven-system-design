/**
 * Available tab options in the admin dashboard.
 */
export type AdminTabType = 'overview' | 'content' | 'users';

/**
 * Props for the AdminTabs component.
 */
interface AdminTabsProps {
  /** Currently active tab */
  activeTab: AdminTabType;
  /** Callback fired when a tab is selected */
  onTabChange: (tab: AdminTabType) => void;
}

/**
 * Tab configuration for rendering tab buttons.
 */
interface TabConfig {
  /** Tab identifier matching AdminTabType */
  id: AdminTabType;
  /** Display label for the tab */
  label: string;
}

/**
 * List of available tabs with their display labels.
 */
const tabs: TabConfig[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'content', label: 'Content' },
  { id: 'users', label: 'Users' },
];

/**
 * Admin dashboard tab navigation component.
 * Renders a horizontal tab bar for switching between admin sections.
 * Active tab is indicated with a white underline border.
 *
 * @example
 * ```tsx
 * const [activeTab, setActiveTab] = useState<AdminTabType>('overview');
 * <AdminTabs activeTab={activeTab} onTabChange={setActiveTab} />
 * ```
 *
 * @param props - AdminTabsProps with activeTab and onTabChange callback
 * @returns Horizontal tab navigation component
 */
export function AdminTabs({ activeTab, onTabChange }: AdminTabsProps) {
  return (
    <div className="flex gap-4 mb-8 border-b border-white/10">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={`pb-4 px-2 text-sm font-medium transition-colors ${
            activeTab === tab.id
              ? 'text-white border-b-2 border-white'
              : 'text-white/60 hover:text-white'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
