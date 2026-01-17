/**
 * Alert service functions for managing price drop notifications.
 * All operations require authentication.
 * @module services/alerts
 */
import api from './api';
import { Alert, AlertsResponse } from '../types';

/**
 * Retrieves all alerts for the current user.
 * @param unreadOnly - If true, only returns unread alerts
 * @returns Array of alert objects with embedded product data
 */
export async function getAlerts(unreadOnly: boolean = false): Promise<Alert[]> {
  const response = await api.get<AlertsResponse>('/alerts', {
    params: { unread_only: unreadOnly },
  });
  return response.data.alerts;
}

/**
 * Gets the count of unread alerts for badge display.
 * @returns Number of unread alerts
 */
export async function getUnreadCount(): Promise<number> {
  const response = await api.get<{ count: number }>('/alerts/count');
  return response.data.count;
}

/**
 * Marks a single alert as read.
 * @param alertId - The alert UUID to mark as read
 */
export async function markAsRead(alertId: string): Promise<void> {
  await api.patch(`/alerts/${alertId}/read`);
}

/**
 * Marks all of the user's alerts as read.
 */
export async function markAllAsRead(): Promise<void> {
  await api.post('/alerts/read-all');
}

/**
 * Permanently deletes an alert.
 * @param alertId - The alert UUID to delete
 */
export async function deleteAlert(alertId: string): Promise<void> {
  await api.delete(`/alerts/${alertId}`);
}
