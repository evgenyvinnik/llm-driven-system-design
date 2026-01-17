import { useState, useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useCartStore } from '../stores/cartStore';
import { api } from '../services/api';

export function Header() {
  const { user, logout } = useAuthStore();
  const { itemCount, fetchCart } = useCartStore();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);

  useEffect(() => {
    if (user) {
      fetchCart();
    }
  }, [user, fetchCart]);

  useEffect(() => {
    const fetchSuggestions = async () => {
      if (searchQuery.length < 2) {
        setSuggestions([]);
        return;
      }
      try {
        const { suggestions } = await api.getSuggestions(searchQuery);
        setSuggestions(suggestions);
      } catch {
        setSuggestions([]);
      }
    };

    const debounce = setTimeout(fetchSuggestions, 200);
    return () => clearTimeout(debounce);
  }, [searchQuery]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate({ to: '/search', search: { q: searchQuery } });
      setShowSuggestions(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate({ to: '/' });
  };

  return (
    <header className="bg-slate-900 text-white">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <div className="flex items-center gap-4">
          {/* Logo */}
          <Link to="/" className="text-2xl font-bold text-amber-400 hover:text-amber-300">
            amazon
          </Link>

          {/* Search */}
          <div className="flex-1 max-w-2xl relative">
            <form onSubmit={handleSearch} className="flex">
              <input
                type="text"
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onFocus={() => setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                className="flex-1 px-4 py-2 text-black rounded-l-md focus:outline-none"
              />
              <button
                type="submit"
                className="px-6 py-2 bg-amber-400 hover:bg-amber-500 text-black rounded-r-md font-medium"
              >
                Search
              </button>
            </form>
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute top-full left-0 right-0 bg-white text-black mt-1 rounded-md shadow-lg z-50">
                {suggestions.map((suggestion, i) => (
                  <button
                    key={i}
                    className="block w-full text-left px-4 py-2 hover:bg-gray-100"
                    onClick={() => {
                      setSearchQuery(suggestion);
                      navigate({ to: '/search', search: { q: suggestion } });
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* User Menu */}
          <div className="flex items-center gap-4">
            {user ? (
              <>
                <div className="text-sm">
                  <div className="text-gray-400">Hello, {user.name}</div>
                  <Link to="/orders" className="font-bold hover:text-amber-400">
                    Orders
                  </Link>
                </div>
                <button onClick={handleLogout} className="text-sm hover:text-amber-400">
                  Sign Out
                </button>
              </>
            ) : (
              <Link to="/login" className="text-sm hover:text-amber-400">
                <div className="text-gray-400">Hello, Sign in</div>
                <div className="font-bold">Account</div>
              </Link>
            )}

            {/* Cart */}
            <Link to="/cart" className="flex items-center gap-1 hover:text-amber-400">
              <div className="relative">
                <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                {itemCount > 0 && (
                  <span className="absolute -top-1 -right-1 bg-amber-400 text-black text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
                    {itemCount}
                  </span>
                )}
              </div>
              <span className="font-bold">Cart</span>
            </Link>
          </div>
        </div>
      </div>

      {/* Categories Nav */}
      <nav className="bg-slate-800 px-4 py-2">
        <div className="max-w-7xl mx-auto flex gap-6 text-sm">
          <Link to="/category/electronics" className="hover:text-amber-400">Electronics</Link>
          <Link to="/category/computers" className="hover:text-amber-400">Computers</Link>
          <Link to="/category/books" className="hover:text-amber-400">Books</Link>
          <Link to="/category/clothing" className="hover:text-amber-400">Clothing</Link>
          <Link to="/category/home-kitchen" className="hover:text-amber-400">Home & Kitchen</Link>
        </div>
      </nav>
    </header>
  );
}
