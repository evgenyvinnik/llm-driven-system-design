import { Link } from '@tanstack/react-router';
import { Store, User } from '../../types';

/**
 * Navigation item configuration for admin sidebar.
 */
export interface NavItem {
  /** Unique identifier for the nav item */
  id: string;
  /** Display label */
  label: string;
  /** Emoji icon */
  icon: string;
}

/**
 * Default navigation items for admin panel.
 */
export const defaultNavItems: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'products', label: 'Products', icon: '📦' },
  { id: 'orders', label: 'Orders', icon: '🛒' },
  { id: 'customers', label: 'Customers', icon: '👥' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

/**
 * Props for AdminSidebar component.
 */
interface AdminSidebarProps {
  /** Current store data */
  store: Store;
  /** Navigation items to display */
  navItems: NavItem[];
  /** Currently active tab ID */
  activeTab: string;
  /** Callback when a nav item is clicked */
  onTabChange: (tabId: string) => void;
}

/**
 * Admin sidebar navigation component.
 * Displays store info, navigation links, and storefront link.
 *
 * @param props - Sidebar configuration
 * @returns Sidebar element with navigation
 */
export function AdminSidebar({ store, navItems, activeTab, onTabChange }: AdminSidebarProps) {
  return (
    <aside className="w-64 bg-gray-900 text-white flex flex-col">
      <SidebarHeader store={store} />

      <nav className="flex-1 p-4">
        <ul className="space-y-2">
          {navItems.map((item) => (
            <li key={item.id}>
              <button
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center gap-3 px-4 py-2 rounded-lg transition-colors ${
                  activeTab === item.id
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>

      <SidebarFooter subdomain={store.subdomain} />
    </aside>
  );
}

/**
 * Sidebar header with store info.
 */
interface SidebarHeaderProps {
  store: Store;
}

function SidebarHeader({ store }: SidebarHeaderProps) {
  return (
    <div className="p-4 border-b border-gray-800">
      <Link to="/" className="text-gray-400 text-sm hover:text-white">
        ← All Stores
      </Link>
      <h2 className="text-lg font-semibold mt-2 truncate">{store.name}</h2>
      <p className="text-gray-400 text-sm truncate">{store.subdomain}.shopify.local</p>
    </div>
  );
}

/**
 * Sidebar footer with storefront link.
 */
interface SidebarFooterProps {
  subdomain: string;
}

function SidebarFooter({ subdomain }: SidebarFooterProps) {
  return (
    <div className="p-4 border-t border-gray-800">
      <Link
        to="/store/$subdomain"
        params={{ subdomain }}
        className="block w-full text-center py-2 px-4 bg-gray-800 text-gray-300 rounded-lg hover:bg-gray-700 transition-colors text-sm"
      >
        View Storefront
      </Link>
    </div>
  );
}

/**
 * Props for AdminHeader component.
 */
interface AdminHeaderProps {
  /** Title to display (current tab label) */
  title: string;
  /** Current user */
  user: User | null;
  /** Logout callback */
  onLogout: () => void;
}

/**
 * Admin header component.
 * Displays current page title and user info with logout.
 *
 * @param props - Header configuration
 * @returns Header element with title and user actions
 */
export function AdminHeader({ title, user, onLogout }: AdminHeaderProps) {
  return (
    <header className="bg-white shadow-sm h-16 flex items-center px-6 justify-between">
      <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
      <div className="flex items-center gap-4">
        <span className="text-gray-600">{user?.name}</span>
        <button onClick={onLogout} className="text-gray-500 hover:text-gray-700">
          Sign Out
        </button>
      </div>
    </header>
  );
}
