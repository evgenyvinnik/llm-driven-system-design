/**
 * Home page route showing the user's tracked products.
 * Displays product list and form to add new products.
 * Requires authentication.
 * @module routes/index
 */
import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useProductStore } from '../stores/productStore';
import { useEffect, useState } from 'react';
import { AddProductForm } from '../components/AddProductForm';
import { ProductCard } from '../components/ProductCard';

/**
 * Home page component.
 * Shows tracked products and add product form.
 * Redirects to login if not authenticated.
 */
function HomePage() {
  const { isAuthenticated } = useAuthStore();
  const { products, isLoading, fetchProducts, addProduct, deleteProduct } = useProductStore();
  const [isAdding, setIsAdding] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      fetchProducts();
    }
  }, [isAuthenticated, fetchProducts]);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const handleAddProduct = async (url: string, targetPrice?: number, notifyAnyDrop?: boolean) => {
    setIsAdding(true);
    try {
      await addProduct(url, targetPrice, notifyAnyDrop);
    } finally {
      setIsAdding(false);
    }
  };

  const handleDelete = async (productId: string) => {
    if (confirm('Are you sure you want to stop tracking this product?')) {
      await deleteProduct(productId);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Your Tracked Products</h1>
        <p className="text-gray-600 mt-1">Monitor prices and get notified when they drop</p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        <div className="md:col-span-1">
          <AddProductForm onSubmit={handleAddProduct} isLoading={isAdding} />
        </div>

        <div className="md:col-span-2">
          {isLoading ? (
            <div className="flex justify-center py-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
            </div>
          ) : products.length === 0 ? (
            <div className="card text-center py-12">
              <h3 className="text-lg font-medium text-gray-900">No products tracked yet</h3>
              <p className="text-gray-500 mt-1">Add a product URL to start tracking prices</p>
            </div>
          ) : (
            <div className="space-y-4">
              {products.map((product) => (
                <ProductCard key={product.id} product={product} onDelete={handleDelete} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: HomePage,
});
