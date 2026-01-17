import { createFileRoute, useParams, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useStorefrontStore } from '../../stores/storefront';
import { storefrontApi } from '../../services/api';
import { Product, Address } from '../../types';

export const Route = createFileRoute('/store/$subdomain')({
  component: StorefrontPage,
});

function StorefrontPage() {
  const { subdomain } = useParams({ from: '/store/$subdomain' });
  const {
    store,
    products,
    cart,
    fetchStore,
    fetchProducts,
    fetchCart,
    addToCart,
    updateCartItem,
    setSubdomain,
    getCartItemCount,
  } = useStorefrontStore();

  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'products' | 'product' | 'cart' | 'checkout' | 'success'>('products');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [checkoutData, setCheckoutData] = useState({
    email: '',
    firstName: '',
    lastName: '',
    address1: '',
    city: '',
    province: '',
    country: 'US',
    zip: '',
  });
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    const loadStore = async () => {
      setSubdomain(subdomain);
      await Promise.all([
        fetchStore(subdomain),
        fetchProducts(subdomain),
        fetchCart(subdomain),
      ]);
      setLoading(false);
    };
    loadStore();
  }, [subdomain, fetchStore, fetchProducts, fetchCart, setSubdomain]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-gray-900 mb-4">Store Not Found</h1>
          <p className="text-gray-600 mb-6">The store you're looking for doesn't exist.</p>
          <Link to="/" className="text-indigo-600 hover:text-indigo-700 font-medium">
            Go to homepage
          </Link>
        </div>
      </div>
    );
  }

  const theme = store.theme;
  const primaryColor = theme?.primaryColor || '#4F46E5';

  const handleAddToCart = async (variantId: number) => {
    try {
      await addToCart(variantId, 1);
    } catch (error) {
      console.error('Failed to add to cart:', error);
    }
  };

  const handleCheckout = async (e: React.FormEvent) => {
    e.preventDefault();
    setProcessing(true);

    try {
      const shippingAddress: Address = {
        first_name: checkoutData.firstName,
        last_name: checkoutData.lastName,
        address1: checkoutData.address1,
        city: checkoutData.city,
        province: checkoutData.province,
        country: checkoutData.country,
        zip: checkoutData.zip,
      };

      await storefrontApi.checkout(subdomain, {
        email: checkoutData.email,
        shippingAddress,
      });

      setView('success');
    } catch (error) {
      console.error('Checkout failed:', error);
      alert('Checkout failed. Please try again.');
    } finally {
      setProcessing(false);
    }
  };

  const openProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariantId(product.variants?.[0]?.id || null);
    setView('product');
  };

  const cartItemCount = getCartItemCount();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow-sm sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
          <button
            onClick={() => { setView('products'); setSelectedProduct(null); }}
            className="text-2xl font-bold"
            style={{ color: primaryColor }}
          >
            {store.name}
          </button>

          <div className="flex items-center gap-4">
            <Link to="/" className="text-gray-500 hover:text-gray-700 text-sm">
              Admin
            </Link>
            <button
              onClick={() => setView('cart')}
              className="relative p-2 hover:bg-gray-100 rounded-full"
            >
              <svg className="w-6 h-6 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
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

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-8">
        {view === 'products' && (
          <ProductsView
            products={products}
            onSelectProduct={openProduct}
            onAddToCart={handleAddToCart}
            primaryColor={primaryColor}
          />
        )}

        {view === 'product' && selectedProduct && (
          <ProductDetailView
            product={selectedProduct}
            selectedVariantId={selectedVariantId}
            setSelectedVariantId={setSelectedVariantId}
            onAddToCart={handleAddToCart}
            onBack={() => setView('products')}
            primaryColor={primaryColor}
          />
        )}

        {view === 'cart' && (
          <CartView
            cart={cart}
            onUpdateItem={updateCartItem}
            onCheckout={() => setView('checkout')}
            onContinueShopping={() => setView('products')}
            primaryColor={primaryColor}
          />
        )}

        {view === 'checkout' && (
          <CheckoutView
            cart={cart}
            checkoutData={checkoutData}
            setCheckoutData={setCheckoutData}
            onSubmit={handleCheckout}
            processing={processing}
            onBack={() => setView('cart')}
            primaryColor={primaryColor}
          />
        )}

        {view === 'success' && (
          <SuccessView
            onContinueShopping={() => setView('products')}
            primaryColor={primaryColor}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t mt-12">
        <div className="max-w-7xl mx-auto px-4 py-8 text-center text-gray-500 text-sm">
          <p>&copy; {new Date().getFullYear()} {store.name}. Powered by Shopify Clone.</p>
        </div>
      </footer>
    </div>
  );
}

// Products Grid View
function ProductsView({
  products,
  onSelectProduct,
  onAddToCart,
  primaryColor,
}: {
  products: Product[];
  onSelectProduct: (product: Product) => void;
  onAddToCart: (variantId: number) => void;
  primaryColor: string;
}) {
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
        {products.map((product) => {
          const variant = product.variants?.[0];
          const price = variant?.price || 0;
          const comparePrice = variant?.compare_at_price;

          return (
            <div
              key={product.id}
              className="bg-white rounded-xl shadow-sm overflow-hidden group hover:shadow-md transition-shadow"
            >
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
                    <svg className="w-16 h-16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
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
                  style={{ backgroundColor: primaryColor }}
                >
                  {variant?.inventory_quantity === 0 ? 'Sold Out' : 'Add to Cart'}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Product Detail View
function ProductDetailView({
  product,
  selectedVariantId,
  setSelectedVariantId,
  onAddToCart,
  onBack,
  primaryColor,
}: {
  product: Product;
  selectedVariantId: number | null;
  setSelectedVariantId: (id: number) => void;
  onAddToCart: (variantId: number) => void;
  onBack: () => void;
  primaryColor: string;
}) {
  const selectedVariant = product.variants?.find((v) => v.id === selectedVariantId) || product.variants?.[0];

  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to products
      </button>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="aspect-square bg-gray-100 rounded-xl overflow-hidden">
          {product.images?.[0]?.url ? (
            <img
              src={product.images[0].url}
              alt={product.title}
              className="w-full h-full object-cover"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-400">
              <svg className="w-24 h-24" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
          )}
        </div>

        <div>
          <h1 className="text-3xl font-bold text-gray-900 mb-4">{product.title}</h1>

          <div className="flex items-center gap-3 mb-6">
            <span className="text-3xl font-bold" style={{ color: primaryColor }}>
              ${selectedVariant?.price?.toFixed(2) || '0.00'}
            </span>
            {selectedVariant?.compare_at_price && selectedVariant.compare_at_price > selectedVariant.price && (
              <span className="text-xl text-gray-400 line-through">
                ${selectedVariant.compare_at_price.toFixed(2)}
              </span>
            )}
          </div>

          {product.description && (
            <p className="text-gray-600 mb-6">{product.description}</p>
          )}

          {product.variants && product.variants.length > 1 && (
            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 mb-2">Variant</label>
              <div className="flex flex-wrap gap-2">
                {product.variants.map((variant) => (
                  <button
                    key={variant.id}
                    onClick={() => setSelectedVariantId(variant.id)}
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
          )}

          <div className="mb-6">
            <span className={`text-sm ${selectedVariant?.inventory_quantity && selectedVariant.inventory_quantity > 0 ? 'text-green-600' : 'text-red-600'}`}>
              {selectedVariant?.inventory_quantity && selectedVariant.inventory_quantity > 0
                ? `${selectedVariant.inventory_quantity} in stock`
                : 'Out of stock'}
            </span>
          </div>

          <button
            onClick={() => selectedVariantId && onAddToCart(selectedVariantId)}
            disabled={!selectedVariant || selectedVariant.inventory_quantity === 0}
            className="w-full py-3 px-6 rounded-lg font-medium text-white text-lg transition-colors disabled:bg-gray-300"
            style={{ backgroundColor: primaryColor }}
          >
            {selectedVariant?.inventory_quantity === 0 ? 'Sold Out' : 'Add to Cart'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Cart View
import { Cart, CartLineItem } from '../../types';

function CartView({
  cart,
  onUpdateItem,
  onCheckout,
  onContinueShopping,
  primaryColor,
}: {
  cart: Cart | null;
  onUpdateItem: (variantId: number, quantity: number) => void;
  onCheckout: () => void;
  onContinueShopping: () => void;
  primaryColor: string;
}) {
  const lineItems = cart?.line_items || [];

  if (lineItems.length === 0) {
    return (
      <div className="text-center py-12">
        <svg className="w-16 h-16 mx-auto text-gray-300 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
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

  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-3xl font-bold text-gray-900 mb-8">Your Cart</h1>

      <div className="bg-white rounded-xl shadow-sm overflow-hidden mb-6">
        {lineItems.map((item: CartLineItem) => (
          <div key={item.variant_id} className="p-4 flex gap-4 border-b last:border-0">
            <div className="w-20 h-20 bg-gray-100 rounded-lg flex-shrink-0">
              {item.image && (
                <img src={item.image} alt={item.product_title} className="w-full h-full object-cover rounded-lg" />
              )}
            </div>
            <div className="flex-1">
              <h3 className="font-medium text-gray-900">{item.product_title}</h3>
              <p className="text-sm text-gray-500">{item.variant_title}</p>
              <p className="font-medium mt-1">${item.price.toFixed(2)}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onUpdateItem(item.variant_id, item.quantity - 1)}
                className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-100"
              >
                -
              </button>
              <span className="w-8 text-center">{item.quantity}</span>
              <button
                onClick={() => onUpdateItem(item.variant_id, item.quantity + 1)}
                className="w-8 h-8 rounded-full border border-gray-300 flex items-center justify-center hover:bg-gray-100"
              >
                +
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-xl shadow-sm p-6">
        <div className="flex justify-between items-center mb-4">
          <span className="text-lg font-medium text-gray-900">Subtotal</span>
          <span className="text-2xl font-bold">${cart?.subtotal?.toFixed(2) || '0.00'}</span>
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
    </div>
  );
}

// Checkout View
function CheckoutView({
  cart,
  checkoutData,
  setCheckoutData,
  onSubmit,
  processing,
  onBack,
  primaryColor,
}: {
  cart: Cart | null;
  checkoutData: {
    email: string;
    firstName: string;
    lastName: string;
    address1: string;
    city: string;
    province: string;
    country: string;
    zip: string;
  };
  setCheckoutData: (data: typeof checkoutData) => void;
  onSubmit: (e: React.FormEvent) => void;
  processing: boolean;
  onBack: () => void;
  primaryColor: string;
}) {
  const subtotal = cart?.subtotal || 0;
  const shipping = 0; // Free shipping
  const tax = subtotal * 0.1; // 10% tax
  const total = subtotal + shipping + tax;

  return (
    <div className="max-w-4xl mx-auto">
      <button
        onClick={onBack}
        className="flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to cart
      </button>

      <h1 className="text-3xl font-bold text-gray-900 mb-8">Checkout</h1>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-xl shadow-sm p-6">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Shipping Information</h2>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
              <input
                type="email"
                value={checkoutData.email}
                onChange={(e) => setCheckoutData({ ...checkoutData, email: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">First Name</label>
                <input
                  type="text"
                  value={checkoutData.firstName}
                  onChange={(e) => setCheckoutData({ ...checkoutData, firstName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Last Name</label>
                <input
                  type="text"
                  value={checkoutData.lastName}
                  onChange={(e) => setCheckoutData({ ...checkoutData, lastName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
              <input
                type="text"
                value={checkoutData.address1}
                onChange={(e) => setCheckoutData({ ...checkoutData, address1: e.target.value })}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">City</label>
                <input
                  type="text"
                  value={checkoutData.city}
                  onChange={(e) => setCheckoutData({ ...checkoutData, city: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">State/Province</label>
                <input
                  type="text"
                  value={checkoutData.province}
                  onChange={(e) => setCheckoutData({ ...checkoutData, province: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Country</label>
                <select
                  value={checkoutData.country}
                  onChange={(e) => setCheckoutData({ ...checkoutData, country: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="US">United States</option>
                  <option value="CA">Canada</option>
                  <option value="GB">United Kingdom</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">ZIP Code</label>
                <input
                  type="text"
                  value={checkoutData.zip}
                  onChange={(e) => setCheckoutData({ ...checkoutData, zip: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={processing}
              className="w-full py-3 rounded-lg font-medium text-white text-lg mt-6 disabled:opacity-50"
              style={{ backgroundColor: primaryColor }}
            >
              {processing ? 'Processing...' : `Pay $${total.toFixed(2)}`}
            </button>
          </form>
        </div>

        <div className="bg-white rounded-xl shadow-sm p-6 h-fit">
          <h2 className="text-xl font-semibold text-gray-900 mb-6">Order Summary</h2>
          <div className="space-y-3 mb-6">
            {cart?.line_items?.map((item: CartLineItem) => (
              <div key={item.variant_id} className="flex justify-between text-sm">
                <span className="text-gray-600">{item.product_title} x {item.quantity}</span>
                <span>${(item.price * item.quantity).toFixed(2)}</span>
              </div>
            ))}
          </div>
          <div className="border-t pt-4 space-y-2">
            <div className="flex justify-between">
              <span className="text-gray-600">Subtotal</span>
              <span>${subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Shipping</span>
              <span>{shipping === 0 ? 'Free' : `$${shipping.toFixed(2)}`}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-600">Tax</span>
              <span>${tax.toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-lg pt-2 border-t">
              <span>Total</span>
              <span>${total.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Success View
function SuccessView({
  onContinueShopping,
  primaryColor,
}: {
  onContinueShopping: () => void;
  primaryColor: string;
}) {
  return (
    <div className="max-w-md mx-auto text-center py-12">
      <div
        className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-6"
        style={{ backgroundColor: primaryColor }}
      >
        <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h1 className="text-3xl font-bold text-gray-900 mb-4">Thank You!</h1>
      <p className="text-gray-600 mb-8">
        Your order has been placed successfully. You will receive a confirmation email shortly.
      </p>
      <button
        onClick={onContinueShopping}
        className="px-8 py-3 rounded-lg font-medium text-white"
        style={{ backgroundColor: primaryColor }}
      >
        Continue Shopping
      </button>
    </div>
  );
}
