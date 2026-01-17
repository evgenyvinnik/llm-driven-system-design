import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Header } from '../components';
import { useAuthStore } from '../stores/authStore';
import { subscriptionApi, watchProgressApi } from '../services/api';
import type { SubscriptionPlan } from '../types';
import { Check, CreditCard, History, User, Settings } from 'lucide-react';

function AccountPage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subscription, setSubscription] = useState<{
    tier: string;
    expiresAt: string | null;
    isActive: boolean;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'subscription' | 'history'>('overview');

  useEffect(() => {
    if (!user) {
      navigate({ to: '/login' });
      return;
    }

    const loadData = async () => {
      try {
        const [plansData, subData] = await Promise.all([
          subscriptionApi.getPlans(),
          subscriptionApi.getStatus(),
        ]);
        setPlans(plansData);
        setSubscription(subData);
      } catch (error) {
        console.error('Failed to load account data:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadData();
  }, [user, navigate]);

  const handleSubscribe = async (planId: string) => {
    try {
      const result = await subscriptionApi.subscribe(planId);
      setSubscription({
        tier: result.tier,
        expiresAt: result.expiresAt,
        isActive: true,
      });
    } catch (error) {
      console.error('Failed to subscribe:', error);
    }
  };

  if (!user) {
    return null;
  }

  return (
    <>
      <Header />
      <main className="pt-24 px-8 lg:px-16 pb-16 min-h-screen max-w-6xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Account</h1>

        {/* Tabs */}
        <div className="flex gap-4 mb-8 border-b border-white/10">
          <button
            onClick={() => setActiveTab('overview')}
            className={`pb-4 px-2 text-sm font-medium transition-colors ${
              activeTab === 'overview'
                ? 'text-white border-b-2 border-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <User className="w-4 h-4 inline-block mr-2" />
            Overview
          </button>
          <button
            onClick={() => setActiveTab('subscription')}
            className={`pb-4 px-2 text-sm font-medium transition-colors ${
              activeTab === 'subscription'
                ? 'text-white border-b-2 border-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <CreditCard className="w-4 h-4 inline-block mr-2" />
            Subscription
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={`pb-4 px-2 text-sm font-medium transition-colors ${
              activeTab === 'history'
                ? 'text-white border-b-2 border-white'
                : 'text-white/60 hover:text-white'
            }`}
          >
            <History className="w-4 h-4 inline-block mr-2" />
            Watch History
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-24">
            <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-white"></div>
          </div>
        ) : (
          <>
            {/* Overview Tab */}
            {activeTab === 'overview' && (
              <div className="space-y-8">
                <div className="bg-apple-gray-800 rounded-2xl p-6">
                  <h2 className="text-xl font-semibold mb-4">Account Details</h2>
                  <div className="space-y-4">
                    <div>
                      <label className="text-sm text-white/60">Name</label>
                      <p className="text-lg">{user.name}</p>
                    </div>
                    <div>
                      <label className="text-sm text-white/60">Email</label>
                      <p className="text-lg">{user.email}</p>
                    </div>
                    <div>
                      <label className="text-sm text-white/60">Subscription</label>
                      <p className="text-lg capitalize">
                        {subscription?.isActive
                          ? `${subscription.tier} (Active)`
                          : 'No active subscription'}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="bg-apple-gray-800 rounded-2xl p-6">
                  <h2 className="text-xl font-semibold mb-4">Quick Actions</h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Link
                      to="/profiles"
                      className="flex items-center gap-4 p-4 bg-apple-gray-700 rounded-xl hover:bg-apple-gray-600 transition-colors"
                    >
                      <User className="w-6 h-6" />
                      <div>
                        <p className="font-medium">Manage Profiles</p>
                        <p className="text-sm text-white/60">Add, edit, or remove profiles</p>
                      </div>
                    </Link>
                    <button
                      onClick={() => setActiveTab('subscription')}
                      className="flex items-center gap-4 p-4 bg-apple-gray-700 rounded-xl hover:bg-apple-gray-600 transition-colors text-left"
                    >
                      <CreditCard className="w-6 h-6" />
                      <div>
                        <p className="font-medium">Subscription</p>
                        <p className="text-sm text-white/60">Manage your plan</p>
                      </div>
                    </button>
                  </div>
                </div>

                <button
                  onClick={logout}
                  className="w-full py-4 bg-apple-red/20 text-apple-red font-semibold rounded-xl hover:bg-apple-red/30 transition-colors"
                >
                  Sign Out
                </button>
              </div>
            )}

            {/* Subscription Tab */}
            {activeTab === 'subscription' && (
              <div className="space-y-8">
                {/* Current subscription */}
                {subscription?.isActive && (
                  <div className="bg-apple-gray-800 rounded-2xl p-6">
                    <h2 className="text-xl font-semibold mb-4">Current Plan</h2>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-2xl font-bold capitalize">{subscription.tier}</p>
                        {subscription.expiresAt && (
                          <p className="text-sm text-white/60">
                            Renews on {new Date(subscription.expiresAt).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-apple-green">
                        <Check className="w-5 h-5" />
                        Active
                      </div>
                    </div>
                  </div>
                )}

                {/* Plans */}
                <div>
                  <h2 className="text-xl font-semibold mb-4">
                    {subscription?.isActive ? 'Change Plan' : 'Choose a Plan'}
                  </h2>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {plans.map((plan) => (
                      <div
                        key={plan.id}
                        className={`bg-apple-gray-800 rounded-2xl p-6 ${
                          subscription?.tier === plan.id ? 'ring-2 ring-apple-blue' : ''
                        }`}
                      >
                        <div className="flex items-center justify-between mb-4">
                          <h3 className="text-xl font-semibold">{plan.name}</h3>
                          {plan.savings && (
                            <span className="px-2 py-1 bg-apple-green/20 text-apple-green text-xs font-medium rounded">
                              Save {plan.savings}
                            </span>
                          )}
                        </div>
                        <p className="text-3xl font-bold mb-2">
                          ${plan.price}
                          <span className="text-sm font-normal text-white/60">
                            /{plan.interval}
                          </span>
                        </p>
                        <ul className="space-y-2 mb-6">
                          {plan.features.slice(0, 4).map((feature) => (
                            <li key={feature} className="flex items-center gap-2 text-sm text-white/80">
                              <Check className="w-4 h-4 text-apple-green" />
                              {feature}
                            </li>
                          ))}
                        </ul>
                        <button
                          onClick={() => handleSubscribe(plan.id)}
                          disabled={subscription?.tier === plan.id}
                          className={`w-full py-3 rounded-lg font-semibold transition-colors ${
                            subscription?.tier === plan.id
                              ? 'bg-white/10 text-white/40 cursor-not-allowed'
                              : 'bg-apple-blue text-white hover:bg-blue-600'
                          }`}
                        >
                          {subscription?.tier === plan.id ? 'Current Plan' : 'Subscribe'}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* History Tab */}
            {activeTab === 'history' && <WatchHistoryTab />}
          </>
        )}
      </main>
    </>
  );
}

function WatchHistoryTab() {
  const [history, setHistory] = useState<unknown[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const loadHistory = async () => {
      try {
        const data = await watchProgressApi.getHistory({ limit: 50 });
        setHistory(data as unknown[]);
      } catch (error) {
        console.error('Failed to load history:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadHistory();
  }, []);

  const handleClearHistory = async () => {
    if (confirm('Are you sure you want to clear your watch history?')) {
      try {
        await watchProgressApi.clearHistory();
        setHistory([]);
      } catch (error) {
        console.error('Failed to clear history:', error);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-white"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Watch History</h2>
        {history.length > 0 && (
          <button
            onClick={handleClearHistory}
            className="text-sm text-apple-red hover:underline"
          >
            Clear History
          </button>
        )}
      </div>

      {history.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-white/60">No watch history</p>
        </div>
      ) : (
        <div className="space-y-4">
          {history.map((item: unknown, index) => {
            const typedItem = item as {
              id: string;
              content_id: string;
              title: string;
              thumbnail_url: string;
              watched_at: string;
              series_title?: string;
            };
            return (
              <Link
                key={typedItem.id || index}
                to="/content/$contentId"
                params={{ contentId: typedItem.content_id }}
                className="flex gap-4 p-4 bg-apple-gray-800 rounded-xl hover:bg-apple-gray-700 transition-colors"
              >
                <img
                  src={typedItem.thumbnail_url}
                  alt={typedItem.title}
                  className="w-32 h-20 object-cover rounded-lg"
                />
                <div>
                  <h3 className="font-medium">{typedItem.title}</h3>
                  {typedItem.series_title && (
                    <p className="text-sm text-white/60">{typedItem.series_title}</p>
                  )}
                  <p className="text-sm text-white/40">
                    Watched {new Date(typedItem.watched_at).toLocaleDateString()}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/account')({
  component: AccountPage,
});
