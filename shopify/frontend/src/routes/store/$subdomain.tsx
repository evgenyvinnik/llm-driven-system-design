/**
 * Storefront page component.
 * Main entry point for customer-facing store experience.
 * Handles routing between product browsing, cart, checkout, and order success views.
 */

import { createFileRoute, useParams, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useStorefrontStore } from '../../stores/storefront';
import { storefrontApi } from '../../services/api';
import { Product, Address } from '../../types';
import { PageLoadingSpinner, ErrorState } from '../../components/common';
import {
  StorefrontHeader,
  StorefrontFooter,
  ProductsView,
  ProductDetailView,
  CartView,
  CheckoutView,
  SuccessView,
  type CheckoutFormData,
} from '../../components/storefront';

export const Route = createFileRoute('/store/$subdomain')({
  component: StorefrontPage,
});

/**
 * View state type for storefront navigation.
 */
type StorefrontView = 'products' | 'product' | 'cart' | 'checkout' | 'success';

/**
 * Default checkout form data.
 */
const defaultCheckoutData: CheckoutFormData = {
  email: '',
  firstName: '',
  lastName: '',
  address1: '',
  city: '',
  province: '',
  country: 'US',
  zip: '',
};

/**
 * Storefront page component.
 * Manages the customer shopping experience including product browsing,
 * cart management, and checkout flow.
 *
 * @returns Complete storefront interface
 */
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
  const [view, setView] = useState<StorefrontView>('products');
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [selectedVariantId, setSelectedVariantId] = useState<number | null>(null);
  const [checkoutData, setCheckoutData] = useState<CheckoutFormData>(defaultCheckoutData);
  const [processing, setProcessing] = useState(false);

  /**
   * Loads store data on mount.
   */
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
    return <PageLoadingSpinner bgColor="bg-gray-50" />;
  }

  if (!store) {
    return (
      <ErrorState
        title="Store Not Found"
        message="The store you're looking for doesn't exist."
        action={
          <Link to="/" className="text-indigo-600 hover:text-indigo-700 font-medium">
            Go to homepage
          </Link>
        }
      />
    );
  }

  const theme = store.theme;
  const primaryColor = theme?.primaryColor || '#4F46E5';

  /**
   * Adds a variant to the cart.
   */
  const handleAddToCart = async (variantId: number) => {
    try {
      await addToCart(variantId, 1);
    } catch (error) {
      console.error('Failed to add to cart:', error);
    }
  };

  /**
   * Handles checkout form submission.
   */
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

  /**
   * Opens product detail view.
   */
  const openProduct = (product: Product) => {
    setSelectedProduct(product);
    setSelectedVariantId(product.variants?.[0]?.id || null);
    setView('product');
  };

  /**
   * Navigates back to products view.
   */
  const goToProducts = () => {
    setView('products');
    setSelectedProduct(null);
  };

  const cartItemCount = getCartItemCount();

  return (
    <div className="min-h-screen bg-gray-50">
      <StorefrontHeader
        storeName={store.name}
        primaryColor={primaryColor}
        cartItemCount={cartItemCount}
        onLogoClick={goToProducts}
        onCartClick={() => setView('cart')}
      />

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
            onBack={goToProducts}
            primaryColor={primaryColor}
          />
        )}

        {view === 'cart' && (
          <CartView
            cart={cart}
            onUpdateItem={updateCartItem}
            onCheckout={() => setView('checkout')}
            onContinueShopping={goToProducts}
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
            onContinueShopping={goToProducts}
            primaryColor={primaryColor}
          />
        )}
      </main>

      <StorefrontFooter storeName={store.name} />
    </div>
  );
}
