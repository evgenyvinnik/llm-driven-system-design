import { Product } from '../../types';
import { BackArrowIcon, ImagePlaceholderIconLarge } from '../icons';

/**
 * Props for ProductDetailView component.
 */
interface ProductDetailViewProps {
  /** Product to display */
  product: Product;
  /** Currently selected variant ID */
  selectedVariantId: number | null;
  /** Callback to update selected variant */
  setSelectedVariantId: (id: number) => void;
  /** Callback when Add to Cart is clicked */
  onAddToCart: (variantId: number) => void;
  /** Callback to go back to products list */
  onBack: () => void;
  /** Primary theme color */
  primaryColor: string;
}

/**
 * Product detail view component.
 * Shows full product information with variant selection and add to cart functionality.
 *
 * @param props - Product detail configuration
 * @returns Full product detail layout with image, variants, and purchase options
 */
export function ProductDetailView({
  product,
  selectedVariantId,
  setSelectedVariantId,
  onAddToCart,
  onBack,
  primaryColor,
}: ProductDetailViewProps) {
  const selectedVariant = product.variants?.find((v) => v.id === selectedVariantId) || product.variants?.[0];

  return (
    <div>
      <BackButton onClick={onBack} label="Back to products" />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <ProductImage product={product} />

        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">{product.title}</h1>

          <PriceDisplay
            price={selectedVariant?.price}
            compareAtPrice={selectedVariant?.compare_at_price}
            primaryColor={primaryColor}
          />

          {product.description && (
            <p className="text-gray-600 mb-6">{product.description}</p>
          )}

          {product.variants && product.variants.length > 1 && (
            <VariantSelector
              variants={product.variants}
              selectedVariantId={selectedVariantId}
              onSelectVariant={setSelectedVariantId}
              primaryColor={primaryColor}
            />
          )}

          <InventoryStatus inventoryQuantity={selectedVariant?.inventory_quantity} />

          <button
            onClick={() => selectedVariantId && onAddToCart(selectedVariantId)}
            disabled={!selectedVariant || selectedVariant.inventory_quantity === 0}
            className="w-full py-3 px-6 rounded-lg font-medium text-white text-lg transition-colors disabled:bg-gray-300"
            style={{ backgroundColor: selectedVariant?.inventory_quantity === 0 ? undefined : primaryColor }}
          >
            {selectedVariant?.inventory_quantity === 0 ? 'Sold Out' : 'Add to Cart'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Back navigation button component.
 */
interface BackButtonProps {
  onClick: () => void;
  label: string;
}

function BackButton({ onClick, label }: BackButtonProps) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
    >
      <BackArrowIcon />
      {label}
    </button>
  );
}

/**
 * Product image display component.
 */
interface ProductImageProps {
  product: Product;
}

function ProductImage({ product }: ProductImageProps) {
  return (
    <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden">
      {product.images?.[0]?.url ? (
        <img
          src={product.images[0].url}
          alt={product.title}
          className="w-full h-full object-cover"
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-gray-400">
          <ImagePlaceholderIconLarge />
        </div>
      )}
    </div>
  );
}

/**
 * Price display component with optional compare-at price.
 */
interface PriceDisplayProps {
  price?: number;
  compareAtPrice?: number;
  primaryColor: string;
}

function PriceDisplay({ price, compareAtPrice, primaryColor }: PriceDisplayProps) {
  return (
    <div className="flex items-center gap-3 mb-6">
      <span className="text-3xl font-bold" style={{ color: primaryColor }}>
        ${price?.toFixed(2) || '0.00'}
      </span>
      {compareAtPrice && price && compareAtPrice > price && (
        <span className="text-xl text-gray-400 line-through">
          ${compareAtPrice.toFixed(2)}
        </span>
      )}
    </div>
  );
}

/**
 * Variant selector component for products with multiple variants.
 */
interface VariantSelectorProps {
  variants: Product['variants'];
  selectedVariantId: number | null;
  onSelectVariant: (id: number) => void;
  primaryColor: string;
}

function VariantSelector({
  variants,
  selectedVariantId,
  onSelectVariant,
  primaryColor,
}: VariantSelectorProps) {
  return (
    <div className="mb-6">
      <label className="block text-sm font-medium text-gray-700 mb-2">Variant</label>
      <div className="flex flex-wrap gap-2">
        {variants.map((variant) => (
          <button
            key={variant.id}
            onClick={() => onSelectVariant(variant.id)}
            className={`px-4 py-2 rounded-lg border-2 font-medium transition-colors ${
              selectedVariantId === variant.id
                ? 'border-current'
                : 'border-gray-200 hover:border-gray-300'
            }`}
            style={{ borderColor: selectedVariantId === variant.id ? primaryColor : undefined }}
          >
            {variant.title}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Inventory status indicator component.
 */
interface InventoryStatusProps {
  inventoryQuantity?: number;
}

function InventoryStatus({ inventoryQuantity }: InventoryStatusProps) {
  const inStock = inventoryQuantity && inventoryQuantity > 0;

  return (
    <div className="mb-6">
      <span className={`text-sm ${inStock ? 'text-green-600' : 'text-red-600'}`}>
        {inStock ? `${inventoryQuantity} in stock` : 'Out of stock'}
      </span>
    </div>
  );
}
