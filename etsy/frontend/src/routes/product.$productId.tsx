import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { Product } from '../types';
import { ProductCard } from '../components/ProductCard';
import { useAuthStore } from '../stores/authStore';
import { useCartStore } from '../stores/cartStore';

export const Route = createFileRoute('/product/$productId')({
  component: ProductPage,
});

function ProductPage() {
  const { productId } = Route.useParams();
  const [product, setProduct] = useState<Product | null>(null);
  const [similarProducts, setSimilarProducts] = useState<Product[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [isFavorited, setIsFavorited] = useState(false);
  const [selectedImage, setSelectedImage] = useState(0);
  const [addingToCart, setAddingToCart] = useState(false);
  const { isAuthenticated } = useAuthStore();
  const { addToCart } = useCartStore();

  useEffect(() => {
    async function fetchProduct() {
      setIsLoading(true);
      try {
        const response = await api.get<{ product: Product; similarProducts: Product[] }>(
          `/products/${productId}`
        );
        setProduct(response.product);
        setSimilarProducts(response.similarProducts);

        if (isAuthenticated) {
          const favResponse = await api.get<{ isFavorited: boolean }>(
            `/favorites/check/product/${productId}`
          );
          setIsFavorited(favResponse.isFavorited);
        }
      } catch (error) {
        console.error('Error fetching product:', error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchProduct();
  }, [productId, isAuthenticated]);

  const handleAddToCart = async () => {
    if (!isAuthenticated) {
      window.location.href = '/login';
      return;
    }

    setAddingToCart(true);
    try {
      await addToCart(parseInt(productId), quantity);
      alert('Added to cart!');
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to add to cart');
    } finally {
      setAddingToCart(false);
    }
  };

  const toggleFavorite = async () => {
    if (!isAuthenticated) {
      window.location.href = '/login';
      return;
    }

    try {
      if (isFavorited) {
        await api.delete(`/favorites/product/${productId}`);
        setIsFavorited(false);
      } else {
        await api.post('/favorites', { type: 'product', id: parseInt(productId) });
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

  if (!product) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Product not found</h1>
        <Link to="/" className="btn btn-primary">
          Back to Home
        </Link>
      </div>
    );
  }

  const images = product.images?.length > 0
    ? product.images
    : ['https://via.placeholder.com/600x600?text=No+Image'];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
        {/* Images */}
        <div>
          <div className="aspect-square overflow-hidden rounded-lg bg-gray-100 mb-4">
            <img
              src={images[selectedImage]}
              alt={product.title}
              className="w-full h-full object-cover"
            />
          </div>
          {images.length > 1 && (
            <div className="flex gap-2">
              {images.map((img, index) => (
                <button
                  key={index}
                  onClick={() => setSelectedImage(index)}
                  className={`w-20 h-20 rounded-md overflow-hidden border-2 ${
                    selectedImage === index ? 'border-primary-600' : 'border-gray-200'
                  }`}
                >
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          <Link
            to={`/shop/${product.shop_slug}`}
            className="text-sm text-primary-600 hover:text-primary-700 mb-2 block"
          >
            {product.shop_name}
          </Link>

          <h1 className="text-3xl font-display font-bold text-gray-900 mb-4">
            {product.title}
          </h1>

          <div className="flex items-center gap-4 mb-6">
            <span className="text-3xl font-bold text-gray-900">
              ${product.price.toFixed(2)}
            </span>
            {product.compare_at_price && product.compare_at_price > product.price && (
              <span className="text-lg text-gray-500 line-through">
                ${product.compare_at_price.toFixed(2)}
              </span>
            )}
          </div>

          {/* Tags */}
          <div className="flex gap-2 mb-6">
            {product.is_handmade && (
              <span className="bg-primary-50 text-primary-700 px-3 py-1 rounded-full text-sm">
                Handmade
              </span>
            )}
            {product.is_vintage && (
              <span className="bg-amber-50 text-amber-700 px-3 py-1 rounded-full text-sm">
                Vintage
              </span>
            )}
            {product.shipping_price === 0 && (
              <span className="bg-green-50 text-green-700 px-3 py-1 rounded-full text-sm">
                Free Shipping
              </span>
            )}
          </div>

          {/* Quantity & Add to Cart */}
          {product.quantity > 0 ? (
            <div className="space-y-4 mb-8">
              <div className="flex items-center gap-4">
                <label className="text-sm font-medium text-gray-700">Quantity:</label>
                <select
                  value={quantity}
                  onChange={(e) => setQuantity(parseInt(e.target.value))}
                  className="input w-20"
                >
                  {Array.from({ length: Math.min(product.quantity, 10) }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      {i + 1}
                    </option>
                  ))}
                </select>
                <span className="text-sm text-gray-500">
                  {product.quantity} available
                </span>
              </div>

              <div className="flex gap-4">
                <button
                  onClick={handleAddToCart}
                  disabled={addingToCart}
                  className="btn btn-primary flex-1 py-3"
                >
                  {addingToCart ? 'Adding...' : 'Add to Cart'}
                </button>
                <button
                  onClick={toggleFavorite}
                  className={`btn ${isFavorited ? 'btn-primary' : 'btn-secondary'} px-4`}
                >
                  <svg
                    className="h-6 w-6"
                    fill={isFavorited ? 'currentColor' : 'none'}
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
                    />
                  </svg>
                </button>
              </div>
            </div>
          ) : (
            <div className="bg-gray-100 p-4 rounded-lg mb-8">
              <p className="text-gray-600 font-medium">This item has sold</p>
            </div>
          )}

          {/* Shipping */}
          <div className="border-t border-gray-200 pt-6 mb-6">
            <h3 className="font-medium text-gray-900 mb-2">Shipping</h3>
            <p className="text-gray-600">
              {product.shipping_price === 0
                ? 'Free shipping'
                : `Shipping: $${product.shipping_price.toFixed(2)}`}
            </p>
            {product.processing_time && (
              <p className="text-gray-600">
                Processing time: {product.processing_time}
              </p>
            )}
          </div>

          {/* Description */}
          <div className="border-t border-gray-200 pt-6">
            <h3 className="font-medium text-gray-900 mb-2">Description</h3>
            <p className="text-gray-600 whitespace-pre-wrap">{product.description}</p>
          </div>

          {/* Tags */}
          {product.tags && product.tags.length > 0 && (
            <div className="border-t border-gray-200 pt-6 mt-6">
              <h3 className="font-medium text-gray-900 mb-2">Tags</h3>
              <div className="flex flex-wrap gap-2">
                {product.tags.map((tag) => (
                  <Link
                    key={tag}
                    to={`/search?q=${encodeURIComponent(tag)}`}
                    className="bg-gray-100 text-gray-700 px-3 py-1 rounded-full text-sm hover:bg-gray-200"
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Similar Products */}
      {similarProducts.length > 0 && (
        <section className="mt-16">
          <h2 className="text-2xl font-display font-bold text-gray-900 mb-6">
            You may also like
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-6">
            {similarProducts.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
