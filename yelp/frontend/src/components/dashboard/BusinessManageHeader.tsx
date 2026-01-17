import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { StarRating } from '../StarRating';
import type { Business } from '../../types';

/**
 * Props for the BusinessManageHeader component.
 */
interface BusinessManageHeaderProps {
  /** The business being managed */
  business: Business;
}

/**
 * BusinessManageHeader displays the header section of the business management page
 * with a back button, business name, rating, and review count.
 *
 * @param props - Component properties
 * @returns Business management header component
 */
export function BusinessManageHeader({ business }: BusinessManageHeaderProps) {
  return (
    <div className="flex items-center gap-4 mb-8">
      <Link to="/dashboard" className="text-gray-600 hover:text-gray-900">
        <ArrowLeft className="w-6 h-6" />
      </Link>
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{business.name}</h1>
        <div className="flex items-center gap-2 mt-1">
          <StarRating rating={business.rating} size="sm" />
          <span className="text-gray-600">{business.review_count} reviews</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Props for the ManagementTabs component.
 */
interface ManagementTabsProps {
  /** Currently active tab */
  activeTab: 'info' | 'reviews';
  /** Callback when tab is changed */
  onTabChange: (tab: 'info' | 'reviews') => void;
  /** Number of reviews for display */
  reviewCount: number;
}

/**
 * ManagementTabs displays the tab navigation for switching between
 * business info editing and reviews management.
 *
 * @param props - Component properties
 * @returns Tab navigation component
 */
export function ManagementTabs({ activeTab, onTabChange, reviewCount }: ManagementTabsProps) {
  return (
    <div className="border-b mb-6">
      <div className="flex gap-4">
        <TabButton
          label="Business Info"
          isActive={activeTab === 'info'}
          onClick={() => onTabChange('info')}
        />
        <TabButton
          label={`Reviews (${reviewCount})`}
          isActive={activeTab === 'reviews'}
          onClick={() => onTabChange('reviews')}
        />
      </div>
    </div>
  );
}

/**
 * Props for the TabButton component.
 */
interface TabButtonProps {
  /** Tab label text */
  label: string;
  /** Whether this tab is currently active */
  isActive: boolean;
  /** Callback when tab is clicked */
  onClick: () => void;
}

/**
 * TabButton renders a single tab button with active state styling.
 *
 * @param props - Component properties
 * @returns Tab button component
 */
function TabButton({ label, isActive, onClick }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`pb-4 px-2 border-b-2 transition-colors ${
        isActive
          ? 'border-yelp-red text-yelp-red'
          : 'border-transparent text-gray-600 hover:text-gray-900'
      }`}
      aria-selected={isActive}
      role="tab"
    >
      {label}
    </button>
  );
}
