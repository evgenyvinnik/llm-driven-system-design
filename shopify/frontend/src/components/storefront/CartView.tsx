import { Cart, CartLineItem } from '../../types';
import { CartIconLarge } from '../icons';

/**
 * Props for CartView component.
 */
interface CartViewProps {
  /** Cart data with line items */
  cart: Cart | null;
  /** Callback to update item quantity */
  onUpdateItem: (variantId: number, quantity: number) => void;
  /** Callback to proceed to checkout */
  onCheckout: () => void;
  /** Callback to continue shopping */
  onContinueShopping: () => void;
  /** Primary theme color */
  primaryColor: string;
}

/**
 * Shopping cart view component.
 * Displays cart items with quantity controls and checkout button.
 *
 * @param props - Cart view configuration
 * @returns Cart display with items, subtotal, and action buttons
 */
export function CartView({
  cart,
  onUpdateItem,
  onCheckout,
  onContinueShopping,
  primaryColor,
}: CartViewProps) {
  const lineItems = cart?.line_items || [];

  if (lineItems.length === 0) {
    return <EmptyCartState onContinueShopping={onContinueShopping} primaryColor={primaryColor} />;
  }

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Your Cart</h1>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
        {lineItems.map((item: CartLineItem) => (
          <CartItem key={item.variant_id} item={item} onUpdateQuantity={onUpdateItem} />
        ))}
      </div>

      <CartSummary
        subtotal={cart?.subtotal || 0}
        onCheckout={onCheckout}
        onContinueShopping={onContinueShopping}
        primaryColor={primaryColor}
      />
    </div>
  );
}

/**
 * Empty cart state component.
 */
interface EmptyCartStateProps {
  onContinueShopping: () => void;
  primaryColor: string;
}

function EmptyCartState({ onContinueShopping, primaryColor }: EmptyCartStateProps) {
  return (
    <div className="text-center py-12">
      <CartIconLarge className="mb-4" />
      <h2 className="text-2xl font-bold text-gray-900 mb-4">Your cart is empty</h2>
      <button
        onClick={onContinueShopping}
        className="px-6 py-2 rounded-lg font-medium text-white"
        style={{ backgroundColor: primaryColor }}
      >
        Continue Shopping
      </button>
    </div>
  );
}

/**
 * Individual cart item row component.
 */
interface CartItemProps {
  item: CartLineItem;
  onUpdateQuantity: (variantId: number, quantity: number) => void;
}

function CartItem({ item, onUpdateQuantity }: CartItemProps) {
  return (
    <div className="p-4 flex gap-4 border-b last:border-0">
      <div className="w-20 h-20 bg-gray-100 rounded-lg flex-shrink-0">
        {item.image && (
          <img
            src={item.image}
            alt={item.product_title}
            className="w-full h-full object-cover rounded-lg"
          />
        )}
      </div>
      <div className="flex-1">
        <h3 className="font-medium text-gray-900">{item.product_title}</h3>
        <p className="text-sm text-gray-500">{item.variant_title}</p>
        <p className="font-medium mt-1">${item.price.toFixed(2)}</p>
      </div>
      <QuantityControls
        quantity={item.quantity}
        onDecrease={() => onUpdateQuantity(item.variant_id, item.quantity - 1)}
        onIncrease={() => onUpdateQuantity(item.variant_id, item.quantity + 1)}
      />
    </div>
  );
}

/**
 * Quantity control buttons component.
 */
interface QuantityControlsProps {
  quantity: number;
  onDecrease: () => void;
  onIncrease: () => void;
}

function QuantityControls({ quantity, onDecrease, onIncrease }: QuantityControlsProps) {
  return (
    <div className="flex items-center gap-2">
      <button
        onClick={onDecrease}
        className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-100"
      >
        -
      </button>
      <span className="w-8 text-center">{quantity}</span>
      <button
        onClick={onIncrease}
        className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-100"
      >
        +
      </button>
    </div>
  );
}

/**
 * Cart summary component with subtotal and action buttons.
 */
interface CartSummaryProps {
  subtotal: number;
  onCheckout: () => void;
  onContinueShopping: () => void;
  primaryColor: string;
}

function CartSummary({ subtotal, onCheckout, onContinueShopping, primaryColor }: CartSummaryProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-6">
      <div className="flex justify-between items-center mb-4">
        <span className="text-lg font-medium text-gray-900">Subtotal</span>
        <span className="text-2xl font-bold">${subtotal.toFixed(2)}</span>
      </div>
      <p className="text-sm text-gray-500 mb-6">Shipping and taxes calculated at checkout</p>
      <button
        onClick={onCheckout}
        className="w-full py-3 rounded-lg font-medium text-white text-lg"
        style={{ backgroundColor: primaryColor }}
      >
        Proceed to Checkout
      </button>
      <button
        onClick={onContinueShopping}
        className="w-full py-3 rounded-lg font-medium text-gray-700 mt-2 hover:bg-gray-100"
      >
        Continue Shopping
      </button>
    </div>
  );
}
