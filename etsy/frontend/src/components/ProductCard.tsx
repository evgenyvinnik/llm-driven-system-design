import { Link } from '@tanstack/react-router';
import type { Product } from '../types';

interface ProductCardProps {
  product: Product;
}

export function ProductCard({ product }: ProductCardProps) {
  const imageUrl = product.images?.[0] || 'https://via.placeholder.com/400x400?text=No+Image';

  return (
    <Link to={`/product/${product.id}`} className="group">
      <div className="card hover:shadow-md transition-shadow">
        <div className="aspect-square overflow-hidden">
          <img
            src={imageUrl}
            alt={product.title}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          />
        </div>
        <div className="p-4">
          <p className="text-xs text-gray-500 mb-1">
            {product.shop_name}
          </p>
          <h3 className="text-sm font-medium text-gray-900 line-clamp-2 mb-2 group-hover:text-primary-600">
            {product.title}
          </h3>
          <div className="flex items-center justify-between">
            <div>
              <span className="text-lg font-semibold text-gray-900">
                ${product.price.toFixed(2)}
              </span>
              {product.shipping_price === 0 && (
                <span className="ml-2 text-xs text-green-600">
                  Free shipping
                </span>
              )}
            </div>
            {product.shop_rating && product.shop_rating > 0 && (
              <div className="flex items-center text-xs text-gray-500">
                <svg
                  className="h-4 w-4 text-yellow-400 mr-1"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                {product.shop_rating}
              </div>
            )}
          </div>
          {(product.is_vintage || product.is_handmade) && (
            <div className="mt-2 flex gap-2">
              {product.is_handmade && (
                <span className="text-xs bg-primary-50 text-primary-700 px-2 py-0.5 rounded">
                  Handmade
                </span>
              )}
              {product.is_vintage && (
                <span className="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded">
                  Vintage
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}
