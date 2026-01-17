/**
 * Admin layout page component.
 * Main entry point for merchant admin dashboard.
 * Provides navigation between dashboard, products, orders, customers, and settings tabs.
 */

import { createFileRoute, useParams } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore, useStoreStore } from '../../stores/auth';
import { storesApi } from '../../services/api';
import { Store, Analytics } from '../../types';
import { PageLoadingSpinner, ErrorState } from '../../components/common';
import {
  AdminSidebar,
  AdminHeader,
  defaultNavItems,
  DashboardTab,
  ProductsTab,
  OrdersTab,
  CustomersTab,
  SettingsTab,
} from '../../components/admin';
import { Link } from '@tanstack/react-router';

export const Route = createFileRoute('/admin/$storeId')({
  component: AdminLayout,
});

/**
 * Admin layout component.
 * Manages the merchant admin experience with sidebar navigation
 * and tabbed content areas for store management.
 *
 * @returns Complete admin dashboard interface
 */
function AdminLayout() {
  const { storeId } = useParams({ from: '/admin/$storeId' });
  const { user, logout } = useAuthStore();
  const { setCurrentStore } = useStoreStore();
  const [store, setStore] = useState<Store | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('dashboard');

  /**
   * Loads store and analytics data on mount.
   */
  useEffect(() => {
    const loadStore = async () => {
      try {
        const [storeRes, analyticsRes] = await Promise.all([
          storesApi.get(parseInt(storeId)),
          storesApi.analytics(parseInt(storeId)),
        ]);
        setStore(storeRes.store);
        setAnalytics(analyticsRes.analytics);
        setCurrentStore(storeRes.store);
      } catch (error) {
        console.error('Failed to load store:', error);
      } finally {
        setLoading(false);
      }
    };
    loadStore();
  }, [storeId, setCurrentStore]);

  if (loading) {
    return <PageLoadingSpinner />;
  }

  if (!store) {
    return (
      <ErrorState
        title="Store not found"
        message="The store you're looking for doesn't exist."
        action={
          <Link to="/" className="text-indigo-600 hover:text-indigo-700">
            Go back home
          </Link>
        }
      />
    );
  }

  /**
   * Gets the current tab title for the header.
   */
  const getCurrentTabTitle = () => {
    return defaultNavItems.find((item) => item.id === activeTab)?.label || 'Dashboard';
  };

  return (
    <div className="min-h-screen bg-gray-100 flex">
      <AdminSidebar
        store={store}
        navItems={defaultNavItems}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="flex-1 flex flex-col">
        <AdminHeader
          title={getCurrentTabTitle()}
          user={user}
          onLogout={logout}
        />

        <main className="flex-1 p-6 overflow-auto">
          {activeTab === 'dashboard' && (
            <DashboardTab analytics={analytics} store={store} />
          )}
          {activeTab === 'products' && (
            <ProductsTab storeId={parseInt(storeId)} />
          )}
          {activeTab === 'orders' && (
            <OrdersTab storeId={parseInt(storeId)} />
          )}
          {activeTab === 'customers' && (
            <CustomersTab storeId={parseInt(storeId)} />
          )}
          {activeTab === 'settings' && (
            <SettingsTab store={store} setStore={setStore} />
          )}
        </main>
      </div>
    </div>
  );
}
