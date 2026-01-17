import { Link } from '@tanstack/react-router';
import { Search, CheckCircle, XCircle } from 'lucide-react';
import { SearchInput } from './AdminTabs';
import type { Business } from '../../types';

/**
 * Props for the BusinessesTab component.
 */
interface BusinessesTabProps {
  /** Array of businesses to display */
  businesses: Business[];
  /** Current search query */
  searchQuery: string;
  /** Callback when search query changes */
  onSearchChange: (query: string) => void;
  /** Callback when business verification status is toggled */
  onVerifyBusiness: (businessId: string, verified: boolean) => void;
}

/**
 * BusinessesTab displays a searchable table of businesses with verification management.
 *
 * @param props - Component properties
 * @returns Businesses tab content
 */
export function BusinessesTab({
  businesses,
  searchQuery,
  onSearchChange,
  onVerifyBusiness,
}: BusinessesTabProps) {
  /**
   * Filters businesses based on search query matching name.
   */
  const filteredBusinesses = businesses.filter(
    (b) => !searchQuery || b.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div>
      <SearchInput
        value={searchQuery}
        onChange={onSearchChange}
        placeholder="Search businesses..."
        icon={Search}
      />

      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Name</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Location</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Claimed</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Verified</th>
              <th className="px-6 py-3 text-left text-sm font-medium text-gray-600">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredBusinesses.map((business) => (
              <BusinessRow
                key={business.id}
                business={business}
                onVerify={(verified) => onVerifyBusiness(business.id, verified)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Props for the BusinessRow component.
 */
interface BusinessRowProps {
  /** Business data */
  business: Business;
  /** Callback when verification is toggled */
  onVerify: (verified: boolean) => void;
}

/**
 * BusinessRow displays a single business row in the businesses table.
 *
 * @param props - Component properties
 * @returns Table row for a business
 */
function BusinessRow({ business, onVerify }: BusinessRowProps) {
  return (
    <tr>
      <td className="px-6 py-4">
        <Link
          to="/business/$slug"
          params={{ slug: business.slug }}
          className="text-yelp-blue hover:underline"
        >
          {business.name}
        </Link>
      </td>
      <td className="px-6 py-4 text-gray-600">
        {business.city}, {business.state}
      </td>
      <td className="px-6 py-4">
        <StatusIcon isActive={business.is_claimed} />
      </td>
      <td className="px-6 py-4">
        <button
          onClick={() => onVerify(!business.is_verified)}
          className={`flex items-center gap-1 ${
            business.is_verified ? 'text-green-600' : 'text-gray-400'
          }`}
          aria-label={business.is_verified ? 'Unverify business' : 'Verify business'}
        >
          <StatusIcon isActive={business.is_verified} />
        </button>
      </td>
      <td className="px-6 py-4">
        <Link
          to="/business/$slug"
          params={{ slug: business.slug }}
          className="text-yelp-blue hover:underline"
        >
          View
        </Link>
      </td>
    </tr>
  );
}

/**
 * Props for StatusIcon component.
 */
interface StatusIconProps {
  /** Whether the status is active/positive */
  isActive: boolean;
}

/**
 * StatusIcon displays a check or X icon based on status.
 *
 * @param props - Component properties
 * @returns Status icon component
 */
function StatusIcon({ isActive }: StatusIconProps) {
  return isActive ? (
    <CheckCircle className="w-5 h-5 text-green-500" />
  ) : (
    <XCircle className="w-5 h-5 text-gray-300" />
  );
}
