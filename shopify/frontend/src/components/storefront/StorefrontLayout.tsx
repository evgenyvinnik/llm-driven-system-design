import { Link } from '@tanstack/react-router';
import { CartIcon } from '../icons';

/**
 * Props for StorefrontHeader component.
 */
interface StorefrontHeaderProps {
  /** Store name to display */
  storeName: string;
  /** Primary theme color for branding */
  primaryColor: string;
  /** Number of items in cart for badge display */
  cartItemCount: number;
  /** Callback when store name/logo is clicked */
  onLogoClick: () => void;
  /** Callback when cart button is clicked */
  onCartClick: () => void;
}

/**
 * Storefront header component.
 * Displays store branding, navigation to admin, and cart button with item count badge.
 *
 * @param props - Header configuration including store info and callbacks
 * @returns Sticky header element with store name and cart navigation
 */
export function StorefrontHeader({
  storeName,
  primaryColor,
  cartItemCount,
  onLogoClick,
  onCartClick,
}: StorefrontHeaderProps) {
  return (
    <header className="bg-white shadow-sm sticky top-0 z-40">
      <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <button
          onClick={onLogoClick}
          className="text-2xl font-bold"
          style={{ color: primaryColor }}
        >
          {storeName}
        </button>

        <div className="flex items-center gap-4">
          <Link to="/" className="text-gray-500 hover:text-gray-700 text-sm">
            Admin
          </Link>
          <button
            onClick={onCartClick}
            className="relative p-2 hover:bg-gray-100 rounded-full"
          >
            <CartIcon />
            {cartItemCount > 0 && (
              <span
                className="absolute -top-1 -right-1 w-5 h-5 text-white text-xs rounded-full flex items-center justify-center"
                style={{ backgroundColor: primaryColor }}
              >
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * Props for StorefrontFooter component.
 */
interface StorefrontFooterProps {
  /** Store name for copyright notice */
  storeName: string;
}

/**
 * Storefront footer component.
 * Displays copyright information and platform attribution.
 *
 * @param props - Footer configuration
 * @returns Footer element with copyright notice
 */
export function StorefrontFooter({ storeName }: StorefrontFooterProps) {
  return (
    <footer className="bg-white border-t mt-12">
      <div className="max-w-7xl mx-auto px-4 py-8 text-center text-gray-500 text-sm">
        <p>&copy; {new Date().getFullYear()} {storeName}. Powered by Shopify Clone.</p>
      </div>
    </footer>
  );
}
