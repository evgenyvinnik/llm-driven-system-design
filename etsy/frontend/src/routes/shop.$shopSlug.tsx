import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { Product, Shop } from '../types';
import { ProductCard } from '../components/ProductCard';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/shop/$shopSlug')({
  component: ShopPage,
});

function ShopPage() {
  const { shopSlug } = Route.useParams();
  const [shop, setShop] = useState<Shop | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isFavorited, setIsFavorited] = useState(false);
  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const shopRes = await api.get<{ shop: Shop }>(`/shops/slug/${shopSlug}`);
        setShop(shopRes.shop);

        const productsRes = await api.get<{ products: Product[] }>(
          `/shops/${shopRes.shop.id}/products`
        );
        setProducts(productsRes.products);

        if (isAuthenticated) {
          const favRes = await api.get<{ isFavorited: boolean }>(
            `/favorites/check/shop/${shopRes.shop.id}`
          );
          setIsFavorited(favRes.isFavorited);
        }
      } catch (error) {
        console.error('Error fetching shop:', error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [shopSlug, isAuthenticated]);

  const toggleFavorite = async () => {
    if (!isAuthenticated || !shop) {
      window.location.href = '/login';
      return;
    }

    try {
      if (isFavorited) {
        await api.delete(`/favorites/shop/${shop.id}`);
        setIsFavorited(false);
      } else {
        await api.post('/favorites', { type: 'shop', id: shop.id });
        setIsFavorited(true);
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!shop) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Shop not found</h1>
        <Link to="/" className="btn btn-primary">
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div>
      {/* Shop Header */}
      <div
        className="h-48 bg-gradient-to-r from-primary-100 to-amber-100 bg-cover bg-center"
        style={shop.banner_image ? { backgroundImage: `url(${shop.banner_image})` } : {}}
      />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 -mt-16">
        <div className="card p-6 mb-8">
          <div className="flex items-start gap-6">
            <div className="w-24 h-24 rounded-full bg-gray-200 flex items-center justify-center text-4xl overflow-hidden flex-shrink-0">
              {shop.logo_image ? (
                <img src={shop.logo_image} alt={shop.name} className="w-full h-full object-cover" />
              ) : (
                shop.name.charAt(0).toUpperCase()
              )}
            </div>

            <div className="flex-1">
              <div className="flex justify-between items-start">
                <div>
                  <h1 className="text-2xl font-display font-bold text-gray-900">
                    {shop.name}
                  </h1>
                  {shop.location && (
                    <p className="text-gray-600">{shop.location}</p>
                  )}
                </div>

                <button
                  onClick={toggleFavorite}
                  className={`btn ${isFavorited ? 'btn-primary' : 'btn-secondary'}`}
                >
                  {isFavorited ? 'Following' : 'Follow Shop'}
                </button>
              </div>

              <div className="flex items-center gap-6 mt-4 text-sm text-gray-600">
                {shop.rating > 0 && (
                  <div className="flex items-center">
                    <svg className="h-5 w-5 text-yellow-400 mr-1" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                    </svg>
                    <span>{shop.rating} ({shop.review_count} reviews)</span>
                  </div>
                )}
                <span>{shop.sales_count} sales</span>
                <span>{shop.product_count} items</span>
              </div>

              {shop.description && (
                <p className="mt-4 text-gray-600">{shop.description}</p>
              )}
            </div>
          </div>
        </div>

        {/* Products */}
        <h2 className="text-xl font-display font-bold text-gray-900 mb-6">
          Items for Sale
        </h2>

        {products.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-gray-600">No products listed yet</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 mb-12">
            {products.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
