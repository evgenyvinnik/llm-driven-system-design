import { Link } from '@tanstack/react-router';
import type { Product } from '../types';
import { useCartStore } from '../stores/cartStore';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';

interface ProductCardProps {
  product: Product;
}

export function ProductCard({ product }: ProductCardProps) {
  const { addToCart } = useCartStore();
  const { user } = useAuthStore();
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddToCart = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (!user) {
      window.location.href = '/login';
      return;
    }

    setIsAdding(true);
    setError(null);
    try {
      await addToCart(product.id);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsAdding(false);
    }
  };

  const inStock = product.stock_quantity > 0;
  const hasDiscount = product.compare_at_price && parseFloat(product.compare_at_price) > parseFloat(product.price);

  return (
    <Link
      to="/product/$id"
      params={{ id: product.id.toString() }}
      className="block bg-white rounded-lg shadow hover:shadow-lg transition-shadow"
    >
      <div className="aspect-square bg-gray-100 rounded-t-lg overflow-hidden">
        {product.images[0] ? (
          <img
            src={product.images[0]}
            alt={product.title}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400">
            No Image
          </div>
        )}
      </div>

      <div className="p-4">
        <h3 className="font-medium text-gray-900 line-clamp-2 min-h-[3rem]">
          {product.title}
        </h3>

        {product.rating && (
          <div className="flex items-center gap-1 mt-1">
            <div className="flex text-amber-400">
              {[1, 2, 3, 4, 5].map((star) => (
                <svg
                  key={star}
                  className={`w-4 h-4 ${
                    star <= Math.round(parseFloat(product.rating!))
                      ? 'fill-current'
                      : 'fill-gray-300'
                  }`}
                  viewBox="0 0 20 20"
                >
                  <path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z" />
                </svg>
              ))}
            </div>
            <span className="text-sm text-gray-500">({product.review_count})</span>
          </div>
        )}

        <div className="mt-2">
          <span className="text-lg font-bold text-gray-900">${product.price}</span>
          {hasDiscount && (
            <>
              <span className="ml-2 text-sm text-gray-500 line-through">
                ${product.compare_at_price}
              </span>
              <span className="ml-2 text-sm text-red-600">
                {Math.round((1 - parseFloat(product.price) / parseFloat(product.compare_at_price!)) * 100)}% off
              </span>
            </>
          )}
        </div>

        <div className="mt-2">
          {inStock ? (
            <span className="text-sm text-green-600">In Stock</span>
          ) : (
            <span className="text-sm text-red-600">Out of Stock</span>
          )}
        </div>

        {error && (
          <div className="mt-2 text-sm text-red-600">{error}</div>
        )}

        <button
          onClick={handleAddToCart}
          disabled={!inStock || isAdding}
          className={`mt-3 w-full py-2 px-4 rounded-full font-medium text-sm transition-colors ${
            inStock
              ? 'bg-amber-400 hover:bg-amber-500 text-black'
              : 'bg-gray-200 text-gray-500 cursor-not-allowed'
          }`}
        >
          {isAdding ? 'Adding...' : 'Add to Cart'}
        </button>
      </div>
    </Link>
  );
}
