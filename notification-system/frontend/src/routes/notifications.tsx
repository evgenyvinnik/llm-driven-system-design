import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useAdminStore } from '../stores/adminStore';
import type { Notification, Template } from '../types';

function NotificationsPage() {
  const { isAuthenticated } = useAuthStore();
  const { notifications, isLoading, fetchNotifications, sendNotification, cancelNotification } =
    useNotificationStore();
  const { templates, fetchTemplates } = useAdminStore();
  const navigate = useNavigate();
  const [showSendForm, setShowSendForm] = useState(false);
  const [formData, setFormData] = useState({
    templateId: '',
    channels: ['email'],
    priority: 'normal',
    title: '',
    body: '',
  });
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }
    fetchNotifications({ status: statusFilter || undefined });
    fetchTemplates();
  }, [isAuthenticated, navigate, fetchNotifications, fetchTemplates, statusFilter]);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await sendNotification({
        templateId: formData.templateId || undefined,
        channels: formData.channels,
        priority: formData.priority,
        data: formData.templateId
          ? {}
          : { title: formData.title, body: formData.body, content: { title: formData.title, body: formData.body } },
      });
      setShowSendForm(false);
      setFormData({ templateId: '', channels: ['email'], priority: 'normal', title: '', body: '' });
    } catch {
      // Error handled by store
    }
  };

  const handleCancel = async (id: string) => {
    if (confirm('Are you sure you want to cancel this notification?')) {
      await cancelNotification(id);
    }
  };

  const toggleChannel = (channel: string) => {
    setFormData((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((c) => c !== channel)
        : [...prev.channels, channel],
    }));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'delivered':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'failed':
        return 'bg-red-100 text-red-800';
      case 'cancelled':
        return 'bg-gray-100 text-gray-800';
      case 'scheduled':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-gray-900">Notifications</h1>
        <button
          onClick={() => setShowSendForm(!showSendForm)}
          className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700"
        >
          {showSendForm ? 'Cancel' : 'Send Notification'}
        </button>
      </div>

      {/* Send Notification Form */}
      {showSendForm && (
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Send New Notification</h2>
          <form onSubmit={handleSend} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Template (optional)</label>
              <select
                value={formData.templateId}
                onChange={(e) => setFormData((prev) => ({ ...prev, templateId: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="">No template (custom message)</option>
                {templates.map((template: Template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>

            {!formData.templateId && (
              <>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Title</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData((prev) => ({ ...prev, title: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Body</label>
                  <textarea
                    value={formData.body}
                    onChange={(e) => setFormData((prev) => ({ ...prev, body: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    rows={3}
                    required
                  />
                </div>
              </>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channels</label>
              <div className="flex space-x-4">
                {['push', 'email', 'sms'].map((channel) => (
                  <label key={channel} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.channels.includes(channel)}
                      onChange={() => toggleChannel(channel)}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700 capitalize">{channel}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select
                value={formData.priority}
                onChange={(e) => setFormData((prev) => ({ ...prev, priority: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {isLoading ? 'Sending...' : 'Send Notification'}
            </button>
          </form>
        </div>
      )}

      {/* Filters */}
      <div className="flex space-x-2">
        <button
          onClick={() => setStatusFilter('')}
          className={`px-3 py-1 rounded-full text-sm ${
            statusFilter === '' ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700'
          }`}
        >
          All
        </button>
        {['pending', 'delivered', 'failed', 'cancelled'].map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(status)}
            className={`px-3 py-1 rounded-full text-sm capitalize ${
              statusFilter === status ? 'bg-indigo-600 text-white' : 'bg-gray-200 text-gray-700'
            }`}
          >
            {status}
          </button>
        ))}
      </div>

      {/* Notifications List */}
      <div className="bg-white rounded-lg shadow">
        {isLoading ? (
          <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
        ) : notifications.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">No notifications found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {notifications.map((notification: Notification) => (
              <div key={notification.id} className="px-6 py-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(notification.status)}`}>
                        {notification.status}
                      </span>
                      <span className="text-xs text-gray-500 capitalize">{notification.priority}</span>
                    </div>
                    <div className="mt-1 text-sm font-medium text-gray-900">
                      {notification.template_id || 'Custom notification'}
                    </div>
                    <div className="mt-1 text-sm text-gray-500">
                      Channels: {notification.channels.join(', ')}
                    </div>
                    <div className="mt-1 text-xs text-gray-400">
                      Created: {new Date(notification.created_at).toLocaleString()}
                      {notification.delivered_at && (
                        <> | Delivered: {new Date(notification.delivered_at).toLocaleString()}</>
                      )}
                    </div>
                  </div>
                  {['pending', 'scheduled'].includes(notification.status) && (
                    <button
                      onClick={() => handleCancel(notification.id)}
                      className="text-sm text-red-600 hover:text-red-800"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/notifications')({
  component: NotificationsPage,
});
