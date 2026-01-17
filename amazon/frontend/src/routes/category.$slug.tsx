import { createFileRoute, Link } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { api } from '../services/api';
import type { Category, Product } from '../types';
import { ProductCard } from '../components/ProductCard';

export const Route = createFileRoute('/category/$slug')({
  component: CategoryPage,
});

function CategoryPage() {
  const { slug } = Route.useParams();
  const [category, setCategory] = useState<Category | null>(null);
  const [subcategories, setSubcategories] = useState<Category[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<{ name: string; slug: string }[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      setLoading(true);
      try {
        const [categoryRes, productsRes] = await Promise.all([
          api.getCategory(slug),
          api.getProducts({ category: slug, limit: 20 }),
        ]);
        setCategory(categoryRes.category);
        setSubcategories(categoryRes.subcategories);
        setBreadcrumbs(categoryRes.breadcrumbs);
        setProducts(productsRes.products);
      } catch (error) {
        console.error('Failed to fetch category:', error);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [slug]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-300 rounded w-1/3 mb-6" />
          <div className="grid grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-64 bg-gray-300 rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!category) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-8 text-center">
        <h1 className="text-2xl font-bold mb-4">Category Not Found</h1>
        <Link to="/" className="text-blue-600 hover:underline">
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Breadcrumbs */}
      <nav className="text-sm mb-4">
        <Link to="/" className="text-blue-600 hover:underline">Home</Link>
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.slug}>
            <span className="mx-2">/</span>
            {i === breadcrumbs.length - 1 ? (
              <span className="text-gray-500">{crumb.name}</span>
            ) : (
              <Link to="/category/$slug" params={{ slug: crumb.slug }} className="text-blue-600 hover:underline">
                {crumb.name}
              </Link>
            )}
          </span>
        ))}
      </nav>

      <h1 className="text-3xl font-bold mb-2">{category.name}</h1>
      {category.description && (
        <p className="text-gray-600 mb-6">{category.description}</p>
      )}

      {/* Subcategories */}
      {subcategories.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-bold mb-4">Subcategories</h2>
          <div className="flex gap-4 flex-wrap">
            {subcategories.map((sub) => (
              <Link
                key={sub.id}
                to="/category/$slug"
                params={{ slug: sub.slug }}
                className="px-4 py-2 bg-white rounded-full border hover:border-amber-400 hover:bg-amber-50 transition-colors"
              >
                {sub.name}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Products */}
      {products.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg">
          <p className="text-gray-500 text-lg">No products in this category yet</p>
          <Link to="/search" search={{ q: '' }} className="text-blue-600 hover:underline mt-2 inline-block">
            Browse all products
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
