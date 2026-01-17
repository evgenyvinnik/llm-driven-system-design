import api from './api';
import { Alert, AlertsResponse } from '../types';

export async function getAlerts(unreadOnly: boolean = false): Promise<Alert[]> {
  const response = await api.get<AlertsResponse>('/alerts', {
    params: { unread_only: unreadOnly },
  });
  return response.data.alerts;
}

export async function getUnreadCount(): Promise<number> {
  const response = await api.get<{ count: number }>('/alerts/count');
  return response.data.count;
}

export async function markAsRead(alertId: string): Promise<void> {
  await api.patch(`/alerts/${alertId}/read`);
}

export async function markAllAsRead(): Promise<void> {
  await api.post('/alerts/read-all');
}

export async function deleteAlert(alertId: string): Promise<void> {
  await api.delete(`/alerts/${alertId}`);
}
