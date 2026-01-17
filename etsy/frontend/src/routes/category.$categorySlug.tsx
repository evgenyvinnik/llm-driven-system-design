import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { Product, Shop, Category } from '../types';
import { ProductCard } from '../components/ProductCard';

export const Route = createFileRoute('/category/$categorySlug')({
  component: CategoryPage,
});

function CategoryPage() {
  const { categorySlug } = Route.useParams();
  const [category, setCategory] = useState<Category | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [sort, setSort] = useState('newest');

  useEffect(() => {
    async function fetchData() {
      setIsLoading(true);
      try {
        const categoryRes = await api.get<{ category: Category }>(
          `/categories/slug/${categorySlug}`
        );
        setCategory(categoryRes.category);

        const productsRes = await api.get<{ products: Product[]; total: number }>(
          `/categories/${categoryRes.category.id}/products?sort=${sort}`
        );
        setProducts(productsRes.products);
        setTotal(productsRes.total);
      } catch (error) {
        console.error('Error fetching category:', error);
      } finally {
        setIsLoading(false);
      }
    }
    fetchData();
  }, [categorySlug, sort]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center min-h-96">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!category) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Category not found</h1>
        <Link to="/" className="btn btn-primary">
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold text-gray-900">
            {category.name}
          </h1>
          <p className="text-gray-600">{total} items</p>
        </div>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value)}
          className="input w-48"
        >
          <option value="newest">Newest</option>
          <option value="price_asc">Price: Low to High</option>
          <option value="price_desc">Price: High to Low</option>
          <option value="popular">Most Popular</option>
        </select>
      </div>

      {products.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600 mb-4">No products in this category yet</p>
          <Link to="/" className="btn btn-secondary">
            Back to Home
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {products.map((product) => (
            <ProductCard key={product.id} product={product} />
          ))}
        </div>
      )}
    </div>
  );
}
