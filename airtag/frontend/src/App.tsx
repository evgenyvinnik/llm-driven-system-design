/**
 * Main application component for the Find My frontend.
 * Handles authentication state, device management, and renders the primary UI.
 * Shows login form when unauthenticated, or the device list and map when logged in.
 */

import { useEffect, useState } from 'react';
import { useStore } from './stores/useStore';
import { LoginForm } from './components/LoginForm';
import { Header } from './components/Header';
import { DeviceCard } from './components/DeviceCard';
import { DeviceDetails } from './components/DeviceDetails';
import { AddDeviceModal } from './components/AddDeviceModal';
import { MapView } from './components/MapView';
import { NotificationsPanel } from './components/NotificationsPanel';
import { AdminDashboard } from './components/AdminDashboard';

/**
 * Root application component.
 * Manages authentication check on load and periodic location refresh.
 * Provides tab switching between device view and admin dashboard for admin users.
 *
 * @returns The main application layout or login form
 */
function App() {
  const {
    user,
    isLoading,
    checkAuth,
    devices,
    selectedDevice,
    locations,
    selectDevice,
    simulateLocation,
    fetchLocations,
  } = useStore();

  const [showAddDevice, setShowAddDevice] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [activeTab, setActiveTab] = useState<'devices' | 'admin'>('devices');

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Refresh locations periodically
  useEffect(() => {
    if (selectedDevice) {
      const interval = setInterval(() => {
        fetchLocations(selectedDevice.id);
      }, 30000);
      return () => clearInterval(interval);
    }
  }, [selectedDevice, fetchLocations]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="spinner"></div>
      </div>
    );
  }

  if (!user) {
    return <LoginForm />;
  }

  const handleMapClick = async (lat: number, lng: number) => {
    if (selectedDevice) {
      await simulateLocation(selectedDevice.id, { latitude: lat, longitude: lng });
    }
  };

  // Get latest location for each device
  const deviceLocations = new Map<string, { latitude: number; longitude: number; timestamp: string }>();
  locations.forEach((loc) => {
    if (!deviceLocations.has(loc.device_id)) {
      deviceLocations.set(loc.device_id, {
        latitude: loc.latitude,
        longitude: loc.longitude,
        timestamp: loc.timestamp,
      });
    }
  });

  return (
    <div className="min-h-screen bg-gray-100">
      <Header onNotificationsClick={() => setShowNotifications(!showNotifications)} />

      <NotificationsPanel
        isOpen={showNotifications}
        onClose={() => setShowNotifications(false)}
      />

      {user.role === 'admin' && (
        <div className="max-w-7xl mx-auto px-4 py-2">
          <div className="flex space-x-2">
            <button
              onClick={() => setActiveTab('devices')}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                activeTab === 'devices'
                  ? 'bg-apple-blue text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              My Devices
            </button>
            <button
              onClick={() => setActiveTab('admin')}
              className={`px-4 py-2 rounded-lg font-medium transition ${
                activeTab === 'admin'
                  ? 'bg-apple-blue text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              Admin Dashboard
            </button>
          </div>
        </div>
      )}

      {activeTab === 'admin' && user.role === 'admin' ? (
        <div className="max-w-7xl mx-auto">
          <AdminDashboard />
        </div>
      ) : (
        <main className="max-w-7xl mx-auto px-4 py-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Device List */}
            <div className="lg:col-span-1 space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold text-gray-800">
                  My Devices ({devices.length})
                </h2>
                <button
                  onClick={() => setShowAddDevice(true)}
                  className="bg-apple-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition flex items-center space-x-2"
                >
                  <svg
                    className="w-5 h-5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M12 4v16m8-8H4"
                    />
                  </svg>
                  <span>Add</span>
                </button>
              </div>

              {devices.length === 0 ? (
                <div className="bg-white rounded-xl p-8 text-center shadow">
                  <div className="text-5xl mb-4">&#128205;</div>
                  <h3 className="text-lg font-medium text-gray-800 mb-2">
                    No devices yet
                  </h3>
                  <p className="text-gray-500 mb-4">
                    Add your first device to start tracking
                  </p>
                  <button
                    onClick={() => setShowAddDevice(true)}
                    className="bg-apple-blue text-white px-6 py-2 rounded-lg hover:bg-blue-600 transition"
                  >
                    Add Device
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {devices.map((device) => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      isSelected={selectedDevice?.id === device.id}
                      lastLocation={deviceLocations.get(device.id) || null}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Map and Details */}
            <div className="lg:col-span-2 space-y-4">
              {/* Map */}
              <div className="bg-white rounded-xl shadow overflow-hidden h-[400px]">
                {selectedDevice ? (
                  <MapView
                    locations={locations}
                    device={selectedDevice}
                    onMapClick={handleMapClick}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center bg-gray-50">
                    <div className="text-center text-gray-500">
                      <div className="text-5xl mb-3">&#127758;</div>
                      <p>Select a device to view its location</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Device Details */}
              {selectedDevice && (
                <DeviceDetails
                  device={selectedDevice}
                  onClose={() => selectDevice(null)}
                />
              )}
            </div>
          </div>
        </main>
      )}

      <AddDeviceModal
        isOpen={showAddDevice}
        onClose={() => setShowAddDevice(false)}
      />
    </div>
  );
}

export default App;
