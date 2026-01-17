import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { Product, Review, ReviewSummary } from '../types';
import { useCartStore } from '../stores/cartStore';
import { useAuthStore } from '../stores/authStore';
import { ReviewSummaryCard } from '../components/ReviewSummary';
import { ReviewCard } from '../components/ReviewCard';

export const Route = createFileRoute('/product/$id')({
  component: ProductPage,
});

function ProductPage() {
  const { id } = Route.useParams();
  const { user } = useAuthStore();
  const { addToCart } = useCartStore();

  const [product, setProduct] = useState<Product | null>(null);
  const [recommendations, setRecommendations] = useState<Product[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [reviewSummary, setReviewSummary] = useState<ReviewSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [quantity, setQuantity] = useState(1);
  const [isAdding, setIsAdding] = useState(false);
  const [addedToCart, setAddedToCart] = useState(false);
  const [selectedImage, setSelectedImage] = useState(0);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const [productRes, recsRes] = await Promise.all([
          api.getProduct(id),
          api.getProductRecommendations(id),
        ]);
        setProduct(productRes.product);
        setRecommendations(recsRes.recommendations);

        // Fetch reviews
        const reviewsRes = await api.getProductReviews(productRes.product.id);
        setReviews(reviewsRes.reviews);
        setReviewSummary(reviewsRes.summary);
      } catch (error) {
        console.error('Failed to fetch product:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [id]);

  const handleAddToCart = async () => {
    if (!user) {
      window.location.href = '/login';
      return;
    }

    setIsAdding(true);
    try {
      await addToCart(product!.id, quantity);
      setAddedToCart(true);
      setTimeout(() => setAddedToCart(false), 3000);
    } catch (error) {
      console.error('Failed to add to cart:', error);
    } finally {
      setIsAdding(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="animate-pulse grid grid-cols-2 gap-8">
          <div className="aspect-square bg-gray-300 rounded-lg" />
          <div>
            <div className="h-8 bg-gray-300 rounded w-3/4 mb-4" />
            <div className="h-4 bg-gray-300 rounded w-1/4 mb-4" />
            <div className="h-6 bg-gray-300 rounded w-1/3 mb-4" />
            <div className="h-24 bg-gray-300 rounded mb-4" />
          </div>
        </div>
      </div>
    );
  }

  if (!product) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Product Not Found</h1>
        <Link to="/" className="text-blue-600 hover:underline">
          Back to Home
        </Link>
      </div>
    );
  }

  const inStock = product.stock_quantity > 0;
  const hasDiscount = product.compare_at_price && parseFloat(product.compare_at_price) > parseFloat(product.price);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Breadcrumbs */}
      <nav className="text-sm mb-4">
        <Link to="/" className="text-blue-600 hover:underline">Home</Link>
        {product.category_slug && (
          <>
            <span className="mx-2">/</span>
            <Link to="/category/$slug" params={{ slug: product.category_slug }} className="text-blue-600 hover:underline">
              {product.category_name}
            </Link>
          </>
        )}
        <span className="mx-2">/</span>
        <span className="text-gray-500">{product.title}</span>
      </nav>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-12">
        {/* Images */}
        <div>
          <div className="aspect-square bg-white rounded-lg overflow-hidden border mb-4">
            {product.images[selectedImage] ? (
              <img
                src={product.images[selectedImage]}
                alt={product.title}
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-400">
                No Image
              </div>
            )}
          </div>
          {product.images.length > 1 && (
            <div className="flex gap-2">
              {product.images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedImage(i)}
                  className={`w-16 h-16 border rounded overflow-hidden ${
                    i === selectedImage ? 'border-amber-400 border-2' : ''
                  }`}
                >
                  <img src={img} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Product Info */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900 mb-2">{product.title}</h1>

          {product.seller_name && (
            <p className="text-sm text-blue-600 mb-2">by {product.seller_name}</p>
          )}

          {product.rating && (
            <div className="flex items-center gap-2 mb-4">
              <div className="flex text-amber-400">
                {[1, 2, 3, 4, 5].map((star) => (
                  <svg
                    key={star}
                    className={`w-5 h-5 ${
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
              <span className="text-blue-600 hover:underline cursor-pointer">
                {product.review_count} ratings
              </span>
            </div>
          )}

          <div className="border-t border-b py-4 my-4">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold">${product.price}</span>
              {hasDiscount && (
                <>
                  <span className="text-lg text-gray-500 line-through">
                    ${product.compare_at_price}
                  </span>
                  <span className="text-lg text-red-600">
                    Save {Math.round((1 - parseFloat(product.price) / parseFloat(product.compare_at_price!)) * 100)}%
                  </span>
                </>
              )}
            </div>
          </div>

          <div className="mb-6">
            {inStock ? (
              <span className="text-lg text-green-600 font-medium">In Stock</span>
            ) : (
              <span className="text-lg text-red-600 font-medium">Out of Stock</span>
            )}
            {inStock && product.stock_quantity < 10 && (
              <span className="ml-2 text-orange-600">
                Only {product.stock_quantity} left - order soon!
              </span>
            )}
          </div>

          {product.description && (
            <div className="mb-6">
              <h3 className="font-bold mb-2">About this item</h3>
              <p className="text-gray-700 whitespace-pre-line">{product.description}</p>
            </div>
          )}

          {/* Attributes */}
          {product.attributes && Object.keys(product.attributes).length > 0 && (
            <div className="mb-6">
              <h3 className="font-bold mb-2">Product Details</h3>
              <dl className="grid grid-cols-2 gap-2 text-sm">
                {Object.entries(product.attributes).map(([key, value]) => (
                  <div key={key} className="flex">
                    <dt className="font-medium text-gray-600 w-24">{key}:</dt>
                    <dd className="text-gray-900">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {/* Add to Cart */}
          {inStock && (
            <div className="bg-gray-50 rounded-lg p-4 border">
              <div className="flex items-center gap-4 mb-4">
                <label className="text-sm font-medium">Qty:</label>
                <select
                  value={quantity}
                  onChange={(e) => setQuantity(Number(e.target.value))}
                  className="border rounded px-3 py-2"
                >
                  {Array.from({ length: Math.min(10, product.stock_quantity) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>

              <button
                onClick={handleAddToCart}
                disabled={isAdding}
                className="w-full py-3 px-6 bg-amber-400 hover:bg-amber-500 text-black font-bold rounded-full disabled:opacity-50"
              >
                {isAdding ? 'Adding...' : 'Add to Cart'}
              </button>

              {addedToCart && (
                <div className="mt-3 p-3 bg-green-50 text-green-700 rounded-lg flex items-center justify-between">
                  <span>Added to cart!</span>
                  <Link to="/cart" className="text-blue-600 hover:underline">
                    View Cart
                  </Link>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Recommendations */}
      {recommendations.length > 0 && (
        <section className="mb-12">
          <h2 className="text-xl font-bold mb-4">Customers also bought</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
            {recommendations.slice(0, 5).map((rec) => (
              <Link
                key={rec.id}
                to="/product/$id"
                params={{ id: rec.id.toString() }}
                className="bg-white rounded-lg p-3 shadow hover:shadow-lg transition-shadow"
              >
                <div className="aspect-square bg-gray-100 rounded overflow-hidden mb-2">
                  {rec.images?.[0] && (
                    <img src={rec.images[0]} alt={rec.title} className="w-full h-full object-cover" />
                  )}
                </div>
                <p className="text-sm line-clamp-2">{rec.title}</p>
                <p className="font-bold mt-1">${rec.price}</p>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Reviews */}
      <section>
        <h2 className="text-xl font-bold mb-4">Customer Reviews</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {reviewSummary && (
            <div>
              <ReviewSummaryCard summary={reviewSummary} />
            </div>
          )}

          <div className="lg:col-span-2">
            {reviews.length > 0 ? (
              <div>
                {reviews.map((review) => (
                  <ReviewCard key={review.id} review={review} />
                ))}
              </div>
            ) : (
              <p className="text-gray-500">No reviews yet. Be the first to review this product!</p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
