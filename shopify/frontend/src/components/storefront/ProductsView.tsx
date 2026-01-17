import { Product } from '../../types';
import { ImagePlaceholderIcon } from '../icons';

/**
 * Props for ProductCard component.
 */
interface ProductCardProps {
  /** Product data to display */
  product: Product;
  /** Primary theme color for pricing and buttons */
  primaryColor: string;
  /** Callback when product is clicked for details */
  onSelectProduct: (product: Product) => void;
  /** Callback when Add to Cart is clicked */
  onAddToCart: (variantId: number) => void;
}

/**
 * Product card component for grid display.
 * Shows product image, title, price, and add to cart button.
 *
 * @param props - Product card configuration
 * @returns Product card element with image, details, and actions
 */
export function ProductCard({
  product,
  primaryColor,
  onSelectProduct,
  onAddToCart,
}: ProductCardProps) {
  const variant = product.variants?.[0];
  const price = variant?.price || 0;
  const comparePrice = variant?.compare_at_price;

  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden group hover:shadow-md transition-shadow">
      <div
        className="aspect-square bg-gray-100 cursor-pointer"
        onClick={() => onSelectProduct(product)}
      >
        {product.images?.[0]?.url ? (
          <img
            src={product.images[0].url}
            alt={product.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400">
            <ImagePlaceholderIcon />
          </div>
        )}
      </div>
      <div className="p-4">
        <h3
          className="font-medium text-gray-900 mb-1 cursor-pointer hover:underline"
          onClick={() => onSelectProduct(product)}
        >
          {product.title}
        </h3>
        <div className="flex items-center gap-2 mb-3">
          <span className="font-bold" style={{ color: primaryColor }}>
            ${price.toFixed(2)}
          </span>
          {comparePrice && comparePrice > price && (
            <span className="text-gray-400 line-through text-sm">
              ${comparePrice.toFixed(2)}
            </span>
          )}
        </div>
        <button
          onClick={() => variant && onAddToCart(variant.id)}
          disabled={!variant || variant.inventory_quantity === 0}
          className="w-full py-2 px-4 rounded-lg font-medium transition-colors text-white disabled:bg-gray-300"
          style={{ backgroundColor: variant?.inventory_quantity === 0 ? undefined : primaryColor }}
        >
          {variant?.inventory_quantity === 0 ? 'Sold Out' : 'Add to Cart'}
        </button>
      </div>
    </div>
  );
}

/**
 * Props for ProductsView component.
 */
interface ProductsViewProps {
  /** Array of products to display */
  products: Product[];
  /** Primary theme color */
  primaryColor: string;
  /** Callback when a product is selected */
  onSelectProduct: (product: Product) => void;
  /** Callback when Add to Cart is clicked */
  onAddToCart: (variantId: number) => void;
}

/**
 * Products grid view component.
 * Displays a responsive grid of product cards with empty state handling.
 *
 * @param props - Products view configuration
 * @returns Products grid or empty state message
 */
export function ProductsView({
  products,
  onSelectProduct,
  onAddToCart,
  primaryColor,
}: ProductsViewProps) {
  if (products.length === 0) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">No Products Yet</h2>
        <p className="text-gray-600">Check back soon for new products!</p>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900 mb-8">All Products</h1>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            primaryColor={primaryColor}
            onSelectProduct={onSelectProduct}
            onAddToCart={onAddToCart}
          />
        ))}
      </div>
    </div>
  );
}
