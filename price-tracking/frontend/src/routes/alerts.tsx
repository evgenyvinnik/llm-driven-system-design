import { createFileRoute, Navigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useAlertStore } from '../stores/alertStore';
import { useEffect } from 'react';
import { AlertItem } from '../components/AlertItem';

function AlertsPage() {
  const { isAuthenticated } = useAuthStore();
  const { alerts, isLoading, fetchAlerts, markAsRead, markAllAsRead, deleteAlert } = useAlertStore();

  useEffect(() => {
    if (isAuthenticated) {
      fetchAlerts();
    }
  }, [isAuthenticated, fetchAlerts]);

  if (!isAuthenticated) {
    return <Navigate to="/login" />;
  }

  const unreadAlerts = alerts.filter((a) => !a.is_read);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Price Alerts</h1>
          <p className="text-gray-600 mt-1">
            {unreadAlerts.length > 0
              ? `You have ${unreadAlerts.length} unread alert${unreadAlerts.length === 1 ? '' : 's'}`
              : 'All caught up!'}
          </p>
        </div>
        {unreadAlerts.length > 0 && (
          <button onClick={() => markAllAsRead()} className="btn btn-secondary">
            Mark all as read
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
        </div>
      ) : alerts.length === 0 ? (
        <div className="card text-center py-12">
          <h3 className="text-lg font-medium text-gray-900">No alerts yet</h3>
          <p className="text-gray-500 mt-1">
            You'll receive alerts when prices drop on your tracked products
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map((alert) => (
            <AlertItem
              key={alert.id}
              alert={alert}
              onMarkRead={markAsRead}
              onDelete={deleteAlert}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute('/alerts')({
  component: AlertsPage,
});
