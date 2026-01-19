/**
 * Represents a customer order in the e-commerce system.
 * Contains order totals, status information, and optionally the line items.
 */
export interface Order {
  /** Unique identifier for the order */
  id: number;
  /** ID of the store this order belongs to (tenant isolation) */
  store_id: number;
  /** Human-readable order number (e.g., "ORD-M1ABC2D3") */
  order_number: string;
  /** Customer's email address for order notifications */
  customer_email: string;
  /** Sum of all line item totals before shipping and tax */
  subtotal: number;
  /** Shipping cost applied to the order */
  shipping_cost: number;
  /** Tax amount calculated for the order */
  tax: number;
  /** Final order total (subtotal + shipping + tax) */
  total: number;
  /** Payment status: "pending", "paid", "failed", "refunded" */
  payment_status: string;
  /** Fulfillment status: "unfulfilled", "partial", "fulfilled" */
  fulfillment_status: string;
  /** Optional merchant notes about the order */
  notes?: string;
  /** Timestamp when the order was created */
  created_at: Date;
  /** Timestamp when the order was last updated */
  updated_at: Date;
  /** Array of order items (populated when fetching order details) */
  items?: OrderItem[];
}

/**
 * Represents a single line item within an order.
 * Captures the product variant, quantity, and pricing at time of purchase.
 */
export interface OrderItem {
  /** Unique identifier for the order item */
  id: number;
  /** ID of the parent order */
  order_id: number;
  /** ID of the store (for tenant isolation) */
  store_id: number;
  /** ID of the product variant purchased */
  variant_id: number;
  /** Product title at time of purchase */
  title: string;
  /** Variant title (e.g., "Large / Blue") */
  variant_title: string;
  /** Stock keeping unit for inventory tracking */
  sku: string | null;
  /** Number of units purchased */
  quantity: number;
  /** Unit price at time of purchase */
  price: number;
  /** Line item total (price * quantity) */
  total: number;
}

/**
 * Represents an item in a shopping cart.
 * Minimal structure stored in cart's JSONB items array.
 */
export interface CartItem {
  /** ID of the product variant in the cart */
  variant_id: number;
  /** Quantity of this variant in the cart */
  quantity: number;
}

/**
 * Represents a shopping cart for a customer session.
 * Carts are identified by session ID and belong to a specific store.
 */
export interface Cart {
  /** Unique identifier for the cart */
  id: number;
  /** ID of the store this cart belongs to */
  store_id: number;
  /** Session identifier used to track the cart (stored in cookie) */
  session_id: string;
  /** Array of cart items with variant IDs and quantities */
  items: CartItem[];
  /** Calculated subtotal based on current variant prices */
  subtotal: number;
}

/**
 * Represents a product variant with inventory and pricing information.
 * Used during checkout to validate availability and calculate totals.
 */
export interface Variant {
  /** Unique identifier for the variant */
  id: number;
  /** ID of the parent product */
  product_id: number;
  /** ID of the store (for tenant isolation) */
  store_id: number;
  /** Stock keeping unit for inventory tracking */
  sku: string | null;
  /** Variant title (e.g., "Small", "Red / Large") */
  title: string;
  /** Current selling price */
  price: number;
  /** Original price for comparison (strikethrough pricing) */
  compare_at_price: number | null;
  /** Available inventory quantity */
  inventory_quantity: number;
  /** Variant option values (e.g., { size: "Large", color: "Blue" }) */
  options: Record<string, unknown>;
  /** Parent product title (joined from products table) */
  product_title?: string;
}

/**
 * Represents a line item during checkout processing.
 * Contains the full variant data plus quantity and calculated totals.
 */
export interface LineItem {
  /** Full variant data including product information */
  variant: Variant;
  /** Quantity being purchased */
  quantity: number;
  /** Unit price from the variant */
  price: number;
  /** Line item total (price * quantity) */
  total: number;
  /** Original inventory quantity before reservation (for rollback) */
  oldQuantity: number;
}

/**
 * Represents a shipping or billing address.
 * All fields are optional to support partial address entry.
 */
export interface Address {
  /** Street address line 1 */
  address1?: string;
  /** Street address line 2 (apartment, suite, etc.) */
  address2?: string;
  /** City name */
  city?: string;
  /** State or province */
  province?: string;
  /** Country name or code */
  country?: string;
  /** Postal or ZIP code */
  zip?: string;
}
