import { Link } from '@tanstack/react-router';
import { Product } from '../types';
import { formatDistanceToNow } from 'date-fns';

interface ProductCardProps {
  product: Product;
  onDelete?: (id: string) => void;
}

export function ProductCard({ product, onDelete }: ProductCardProps) {
  const formatPrice = (price: number | null, currency: string = 'USD') => {
    if (price === null) return 'N/A';
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(price);
  };

  const getStatusBadge = (status: string) => {
    const classes: Record<string, string> = {
      active: 'badge-green',
      error: 'badge-red',
      unavailable: 'badge-yellow',
      paused: 'badge-blue',
    };
    return classes[status] || 'badge-blue';
  };

  return (
    <div className="card hover:shadow-lg transition-shadow">
      <div className="flex gap-4">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.title || 'Product'}
            className="w-24 h-24 object-contain rounded-lg bg-gray-100"
          />
        ) : (
          <div className="w-24 h-24 bg-gray-100 rounded-lg flex items-center justify-center">
            <span className="text-gray-400 text-xs">No image</span>
          </div>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between">
            <div className="flex-1 min-w-0">
              <h3 className="font-medium text-gray-900 truncate">
                {product.title || 'Loading...'}
              </h3>
              <p className="text-sm text-gray-500 truncate">{product.domain}</p>
            </div>
            <span className={`badge ${getStatusBadge(product.status)} ml-2`}>
              {product.status}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-4">
            <span className="text-2xl font-bold text-gray-900">
              {formatPrice(product.current_price, product.currency)}
            </span>
            {product.target_price && (
              <span className="text-sm text-gray-500">
                Target: {formatPrice(product.target_price, product.currency)}
              </span>
            )}
          </div>

          <div className="mt-2 flex items-center justify-between text-sm text-gray-500">
            <span>
              {product.last_scraped
                ? `Updated ${formatDistanceToNow(new Date(product.last_scraped), { addSuffix: true })}`
                : 'Not yet updated'}
            </span>
            {product.watcher_count !== undefined && (
              <span>{product.watcher_count} watchers</span>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <Link
              to="/products/$productId"
              params={{ productId: product.id }}
              className="btn btn-secondary text-sm py-1"
            >
              View Details
            </Link>
            <a
              href={product.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-secondary text-sm py-1"
            >
              Visit Store
            </a>
            {onDelete && (
              <button
                onClick={() => onDelete(product.id)}
                className="btn btn-danger text-sm py-1"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
