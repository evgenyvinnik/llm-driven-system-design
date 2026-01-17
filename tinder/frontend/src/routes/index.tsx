import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useDiscoveryStore } from '../stores/discoveryStore';
import { useMatchStore } from '../stores/matchStore';
import { useEffect, useState, useCallback } from 'react';
import SwipeCard from '../components/SwipeCard';
import MatchModal from '../components/MatchModal';
import BottomNav from '../components/BottomNav';

function HomePage() {
  const { isAuthenticated, user, updateLocation } = useAuthStore();
  const { deck, currentIndex, isLoading, loadDeck, swipe, lastMatch, clearMatch } =
    useDiscoveryStore();
  const { subscribeToMessages, loadUnreadCount } = useMatchStore();
  const [swipeAnimation, setSwipeAnimation] = useState<'left' | 'right' | null>(null);

  useEffect(() => {
    if (isAuthenticated) {
      loadDeck();
      loadUnreadCount();
      const unsubscribe = subscribeToMessages();

      // Request location
      if (navigator.geolocation && !user?.latitude) {
        navigator.geolocation.getCurrentPosition(
          (position) => {
            updateLocation(position.coords.latitude, position.coords.longitude);
          },
          (error) => {
            console.log('Location permission denied:', error);
          }
        );
      }

      return unsubscribe;
    }
  }, [isAuthenticated]);

  const handleSwipe = useCallback(
    async (direction: 'like' | 'pass') => {
      if (swipeAnimation) return;

      setSwipeAnimation(direction === 'like' ? 'right' : 'left');

      setTimeout(async () => {
        await swipe(direction);
        setSwipeAnimation(null);
      }, 300);
    },
    [swipe, swipeAnimation]
  );

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const currentCard = deck[currentIndex];
  const nextCard = deck[currentIndex + 1];

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm px-4 py-3 flex items-center justify-between">
        <h1 className="text-2xl font-bold bg-tinder-gradient bg-clip-text text-transparent">
          tinder
        </h1>
        <div className="flex items-center gap-2">
          <span className="text-gray-600 text-sm">{user?.name}</span>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center p-4">
        <div className="relative w-full max-w-sm h-[500px]">
          {isLoading && deck.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-12 h-12 border-4 border-gradient-start border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !currentCard ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-24 h-24 bg-gray-200 rounded-full flex items-center justify-center mb-4">
                <svg
                  className="w-12 h-12 text-gray-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </div>
              <h2 className="text-xl font-semibold text-gray-700 mb-2">No more profiles</h2>
              <p className="text-gray-500 mb-4">Check back later for more matches!</p>
              <button
                onClick={loadDeck}
                className="btn btn-primary"
              >
                Refresh
              </button>
            </div>
          ) : (
            <>
              {/* Next card (behind) */}
              {nextCard && (
                <div className="swipe-card scale-95 opacity-80">
                  <SwipeCard card={nextCard} isActive={false} />
                </div>
              )}

              {/* Current card */}
              <div
                className={`swipe-card ${
                  swipeAnimation === 'right'
                    ? 'animate-swipe-right'
                    : swipeAnimation === 'left'
                      ? 'animate-swipe-left'
                      : ''
                }`}
              >
                <SwipeCard
                  card={currentCard}
                  isActive={!swipeAnimation}
                  onSwipe={handleSwipe}
                />
              </div>
            </>
          )}
        </div>
      </main>

      {/* Swipe buttons */}
      {currentCard && !isLoading && (
        <div className="flex justify-center gap-6 pb-4">
          <button
            onClick={() => handleSwipe('pass')}
            disabled={!!swipeAnimation}
            className="swipe-button bg-white border-2 border-red-400 text-red-400 hover:bg-red-50"
          >
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={3}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
          <button
            onClick={() => handleSwipe('like')}
            disabled={!!swipeAnimation}
            className="swipe-button bg-tinder-gradient text-white shadow-lg shadow-pink-500/30"
          >
            <svg className="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
            </svg>
          </button>
        </div>
      )}

      {/* Bottom Navigation */}
      <BottomNav />

      {/* Match Modal */}
      {lastMatch && (
        <MatchModal match={lastMatch} onClose={clearMatch} />
      )}
    </div>
  );
}

export const Route = createFileRoute('/')({
  component: HomePage,
});
