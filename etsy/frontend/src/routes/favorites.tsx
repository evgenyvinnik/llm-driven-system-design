import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import api from '../services/api';
import type { Favorite } from '../types';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/favorites')({
  component: FavoritesPage,
});

function FavoritesPage() {
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'product' | 'shop'>('product');
  const { isAuthenticated } = useAuthStore();

  useEffect(() => {
    async function fetchFavorites() {
      try {
        const response = await api.get<{ favorites: Favorite[] }>(`/favorites?type=${activeTab}`);
        setFavorites(response.favorites);
      } catch (error) {
        console.error('Error fetching favorites:', error);
      } finally {
        setIsLoading(false);
      }
    }

    if (isAuthenticated) {
      setIsLoading(true);
      fetchFavorites();
    } else {
      setIsLoading(false);
    }
  }, [isAuthenticated, activeTab]);

  const removeFavorite = async (type: string, id: number) => {
    try {
      await api.delete(`/favorites/${type}/${id}`);
      setFavorites(favorites.filter((f) => !(f.favoritable_type === type && f.favoritable_id === id)));
    } catch (error) {
      console.error('Error removing favorite:', error);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-12 text-center">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Please sign in to view your favorites</h1>
        <Link to="/login" className="btn btn-primary">
          Sign In
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-3xl font-display font-bold text-gray-900 mb-8">My Favorites</h1>

      {/* Tabs */}
      <div className="flex border-b border-gray-200 mb-8">
        <button
          onClick={() => setActiveTab('product')}
          className={`px-6 py-3 text-sm font-medium border-b-2 ${
            activeTab === 'product'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Products
        </button>
        <button
          onClick={() => setActiveTab('shop')}
          className={`px-6 py-3 text-sm font-medium border-b-2 ${
            activeTab === 'shop'
              ? 'border-primary-600 text-primary-600'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Shops
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center min-h-96">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
        </div>
      ) : favorites.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-600 mb-4">
            No favorite {activeTab === 'product' ? 'products' : 'shops'} yet
          </p>
          <Link to="/" className="btn btn-primary">
            Start Exploring
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
          {favorites.map((favorite) => (
            <div key={favorite.id} className="card group">
              <Link
                to={activeTab === 'product' ? `/product/${favorite.favoritable_id}` : `/shop/${favorite.slug}`}
              >
                <div className="aspect-square overflow-hidden">
                  <img
                    src={favorite.image || 'https://via.placeholder.com/400x400?text=No+Image'}
                    alt={favorite.name || ''}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                </div>
              </Link>
              <div className="p-4">
                <Link
                  to={activeTab === 'product' ? `/product/${favorite.favoritable_id}` : `/shop/${favorite.slug}`}
                >
                  <h3 className="font-medium text-gray-900 group-hover:text-primary-600">
                    {favorite.name}
                  </h3>
                </Link>
                {favorite.price && (
                  <p className="text-lg font-semibold text-gray-900 mt-1">
                    ${parseFloat(favorite.price).toFixed(2)}
                  </p>
                )}
                <button
                  onClick={() => removeFavorite(favorite.favoritable_type, favorite.favoritable_id)}
                  className="text-sm text-red-600 hover:text-red-700 mt-2"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
