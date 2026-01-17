import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useState } from 'react';

export const Route = createFileRoute('/become-host')({
  component: BecomeHostPage,
});

function BecomeHostPage() {
  const { user, isAuthenticated, becomeHost } = useAuthStore();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);

  const handleBecomeHost = async () => {
    if (!isAuthenticated) {
      navigate({ to: '/login', search: { redirect: '/become-host' } });
      return;
    }

    setIsLoading(true);
    try {
      await becomeHost();
      navigate({ to: '/host/listings/new' });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to become host');
    } finally {
      setIsLoading(false);
    }
  };

  if (user?.is_host) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-16 text-center">
        <h1 className="text-3xl font-bold mb-4">You're already a host!</h1>
        <p className="text-gray-500 mb-8">Start creating your first listing</p>
        <a href="/host/listings/new" className="btn-primary">
          Create a listing
        </a>
      </div>
    );
  }

  return (
    <div className="min-h-[80vh]">
      {/* Hero */}
      <div className="bg-gradient-to-r from-rose-500 to-pink-500 text-white py-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h1 className="text-5xl font-bold mb-6">
            Earn money as a host
          </h1>
          <p className="text-xl mb-8 max-w-2xl mx-auto">
            Join millions of hosts on Airbnb. Share your space, earn extra income, and meet travelers from around the world.
          </p>
          <button
            onClick={handleBecomeHost}
            disabled={isLoading}
            className="bg-white text-gray-900 px-8 py-4 rounded-lg font-semibold text-lg hover:bg-gray-100 transition-colors"
          >
            {isLoading ? 'Processing...' : 'Get started'}
          </button>
        </div>
      </div>

      {/* Benefits */}
      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <h2 className="text-3xl font-bold text-center mb-12">Why host on Airbnb?</h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-airbnb" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Earn extra income</h3>
            <p className="text-gray-600">
              Turn your extra space into extra income. Hosts on Airbnb earn an average of $X per month.
            </p>
          </div>

          <div className="text-center">
            <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-airbnb" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Host with confidence</h3>
            <p className="text-gray-600">
              Every booking comes with Host Protection Insurance and 24/7 support.
            </p>
          </div>

          <div className="text-center">
            <div className="w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-airbnb" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">You're in control</h3>
            <p className="text-gray-600">
              Set your own prices, availability, and house rules. Accept bookings that work for you.
            </p>
          </div>
        </div>
      </div>

      {/* How it works */}
      <div className="bg-gray-50 py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-center mb-12">How it works</h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <div className="text-4xl font-bold text-airbnb mb-4">1</div>
              <h3 className="text-xl font-semibold mb-2">Create your listing</h3>
              <p className="text-gray-600">
                Tell us about your space, add photos, and set your price. It only takes a few minutes.
              </p>
            </div>

            <div>
              <div className="text-4xl font-bold text-airbnb mb-4">2</div>
              <h3 className="text-xl font-semibold mb-2">Welcome your guests</h3>
              <p className="text-gray-600">
                Once your listing is live, qualified guests can reach out. You decide who to host.
              </p>
            </div>

            <div>
              <div className="text-4xl font-bold text-airbnb mb-4">3</div>
              <h3 className="text-xl font-semibold mb-2">Get paid</h3>
              <p className="text-gray-600">
                Receive secure payments 24 hours after your guest checks in.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* CTA */}
      <div className="py-20 text-center">
        <h2 className="text-3xl font-bold mb-4">Ready to become a host?</h2>
        <p className="text-gray-600 mb-8">Join our community of hosts today</p>
        <button
          onClick={handleBecomeHost}
          disabled={isLoading}
          className="btn-primary text-lg px-8 py-4"
        >
          {isLoading ? 'Processing...' : 'Get started'}
        </button>
      </div>
    </div>
  );
}
