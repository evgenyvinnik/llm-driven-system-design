import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useHealthStore } from '../stores/healthStore';
import { api } from '../services/api';
import type { Device } from '../types';

const DEVICE_TYPES = [
  { value: 'apple_watch', label: 'Apple Watch', icon: 'watch' },
  { value: 'iphone', label: 'iPhone', icon: 'phone' },
  { value: 'ipad', label: 'iPad', icon: 'tablet' },
  { value: 'third_party_wearable', label: 'Third-party Wearable', icon: 'activity' },
  { value: 'third_party_scale', label: 'Smart Scale', icon: 'scale' },
  { value: 'manual_entry', label: 'Manual Entry', icon: 'edit' },
];

export function Devices() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();
  const { devices, fetchDevices } = useHealthStore();
  const [showAddModal, setShowAddModal] = useState(false);
  const [newDevice, setNewDevice] = useState({
    deviceType: 'apple_watch',
    deviceName: '',
    deviceIdentifier: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    fetchDevices();
  }, [isAuthenticated, navigate, fetchDevices]);

  const handleAddDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await api.devices.register(
        newDevice.deviceType,
        newDevice.deviceName,
        newDevice.deviceIdentifier || `device-${Date.now()}`
      );
      await fetchDevices();
      setShowAddModal(false);
      setNewDevice({ deviceType: 'apple_watch', deviceName: '', deviceIdentifier: '' });
    } catch (error) {
      console.error('Failed to add device:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getDeviceIcon = (type: string) => {
    const iconClass = 'w-8 h-8';
    switch (type) {
      case 'apple_watch':
        return (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        );
      case 'iphone':
      case 'ipad':
        return (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 18h.01M8 21h8a2 2 0 002-2V5a2 2 0 00-2-2H8a2 2 0 00-2 2v14a2 2 0 002 2z" />
          </svg>
        );
      case 'third_party_scale':
        return (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
          </svg>
        );
      default:
        return (
          <svg className={iconClass} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
          </svg>
        );
    }
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Connected Devices</h1>
          <p className="text-gray-600">Manage your health data sources</p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2 bg-health-600 text-white font-medium rounded-lg hover:bg-health-700"
        >
          Add Device
        </button>
      </div>

      {/* Device list */}
      {devices.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {devices.map((device: Device) => (
            <div
              key={device.id}
              className="bg-white rounded-xl border border-gray-200 p-4"
            >
              <div className="flex items-start gap-4">
                <div className="p-2 bg-gray-100 rounded-lg text-gray-600">
                  {getDeviceIcon(device.device_type)}
                </div>
                <div className="flex-1">
                  <h3 className="font-medium text-gray-900">
                    {device.device_name || device.device_type}
                  </h3>
                  <p className="text-sm text-gray-500 capitalize">
                    {device.device_type.replace(/_/g, ' ')}
                  </p>
                  <div className="mt-2 text-xs text-gray-400">
                    {device.last_sync ? (
                      <span>
                        Last sync: {new Date(device.last_sync).toLocaleString()}
                      </span>
                    ) : (
                      <span>Never synced</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-gray-400">
                  Priority: {device.priority}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"
            />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No devices connected</h3>
          <p className="mt-2 text-gray-500">
            Add a device to start syncing your health data.
          </p>
          <button
            onClick={() => setShowAddModal(true)}
            className="mt-4 px-4 py-2 bg-health-600 text-white font-medium rounded-lg hover:bg-health-700"
          >
            Add Your First Device
          </button>
        </div>
      )}

      {/* Add Device Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl p-6 max-w-md w-full mx-4">
            <h2 className="text-xl font-bold text-gray-900 mb-4">Add New Device</h2>
            <form onSubmit={handleAddDevice} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Device Type
                </label>
                <select
                  value={newDevice.deviceType}
                  onChange={(e) =>
                    setNewDevice({ ...newDevice, deviceType: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-health-500 focus:border-health-500"
                >
                  {DEVICE_TYPES.map((type) => (
                    <option key={type.value} value={type.value}>
                      {type.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Device Name
                </label>
                <input
                  type="text"
                  value={newDevice.deviceName}
                  onChange={(e) =>
                    setNewDevice({ ...newDevice, deviceName: e.target.value })
                  }
                  placeholder="My Apple Watch"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-health-500 focus:border-health-500"
                />
              </div>

              <div className="flex gap-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex-1 px-4 py-2 bg-health-600 text-white rounded-lg hover:bg-health-700 disabled:opacity-50"
                >
                  {isSubmitting ? 'Adding...' : 'Add Device'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
