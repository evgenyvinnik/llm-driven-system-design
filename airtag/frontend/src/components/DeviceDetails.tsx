import { useState } from 'react';
import { useStore } from '../stores/useStore';
import { Device } from '../types';

interface DeviceDetailsProps {
  device: Device;
  onClose: () => void;
}

export function DeviceDetails({ device, onClose }: DeviceDetailsProps) {
  const {
    lostModeSettings,
    updateLostMode,
    playSound,
    deleteDevice,
    updateDevice,
  } = useStore();
  const lostMode = lostModeSettings[device.id];

  const [isEditingLostMode, setIsEditingLostMode] = useState(false);
  const [lostModeForm, setLostModeForm] = useState({
    contact_phone: lostMode?.contact_phone || '',
    contact_email: lostMode?.contact_email || '',
    message: lostMode?.message || '',
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const handlePlaySound = async () => {
    setIsPlaying(true);
    try {
      await playSound(device.id);
      setTimeout(() => setIsPlaying(false), 3000);
    } catch {
      setIsPlaying(false);
    }
  };

  const handleToggleLostMode = async () => {
    if (lostMode?.enabled) {
      await updateLostMode(device.id, { enabled: false });
    } else {
      setIsEditingLostMode(true);
    }
  };

  const handleSaveLostMode = async () => {
    await updateLostMode(device.id, {
      enabled: true,
      ...lostModeForm,
    });
    setIsEditingLostMode(false);
  };

  const handleDelete = async () => {
    await deleteDevice(device.id);
    onClose();
  };

  const handleToggleActive = async () => {
    await updateDevice(device.id, { is_active: !device.is_active });
  };

  return (
    <div className="bg-white rounded-xl shadow-lg p-6 space-y-6">
      <div className="flex justify-between items-start">
        <div className="flex items-center space-x-3">
          <span className="text-4xl">{device.emoji || '&#128205;'}</span>
          <div>
            <h2 className="text-xl font-semibold">{device.name}</h2>
            <p className="text-gray-500 capitalize">{device.device_type}</p>
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-600 text-2xl"
        >
          &times;
        </button>
      </div>

      {/* Status */}
      <div className="flex items-center justify-between py-3 border-t border-b">
        <span className="text-gray-600">Status</span>
        <div className="flex items-center space-x-2">
          <span
            className={`w-3 h-3 rounded-full ${
              device.is_active ? 'bg-apple-green' : 'bg-gray-300'
            }`}
          ></span>
          <span>{device.is_active ? 'Active' : 'Inactive'}</span>
          <button
            onClick={handleToggleActive}
            className="text-apple-blue text-sm hover:underline ml-2"
          >
            {device.is_active ? 'Disable' : 'Enable'}
          </button>
        </div>
      </div>

      {/* Actions */}
      <div className="grid grid-cols-2 gap-3">
        <button
          onClick={handlePlaySound}
          disabled={isPlaying}
          className="flex items-center justify-center space-x-2 bg-gray-100 hover:bg-gray-200 rounded-xl py-4 transition disabled:opacity-50"
        >
          <span className="text-xl">&#128266;</span>
          <span>{isPlaying ? 'Playing...' : 'Play Sound'}</span>
        </button>

        <button
          onClick={() => {
            // In a real app, this would open directions
            window.open(
              `https://www.google.com/maps/search/?api=1&query=${37.7749},${-122.4194}`,
              '_blank'
            );
          }}
          className="flex items-center justify-center space-x-2 bg-gray-100 hover:bg-gray-200 rounded-xl py-4 transition"
        >
          <span className="text-xl">&#128506;</span>
          <span>Directions</span>
        </button>
      </div>

      {/* Lost Mode */}
      <div className="bg-gray-50 rounded-xl p-4">
        <div className="flex justify-between items-center mb-3">
          <div>
            <h3 className="font-medium">Lost Mode</h3>
            <p className="text-sm text-gray-500">
              Get notified when found by the network
            </p>
          </div>
          <button
            onClick={handleToggleLostMode}
            className={`px-4 py-2 rounded-full font-medium transition ${
              lostMode?.enabled
                ? 'bg-apple-red text-white'
                : 'bg-apple-blue text-white'
            }`}
          >
            {lostMode?.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>

        {isEditingLostMode && (
          <div className="space-y-3 pt-3 border-t">
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Contact Phone
              </label>
              <input
                type="tel"
                value={lostModeForm.contact_phone}
                onChange={(e) =>
                  setLostModeForm((f) => ({ ...f, contact_phone: e.target.value }))
                }
                placeholder="+1 (555) 123-4567"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-apple-blue outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Contact Email
              </label>
              <input
                type="email"
                value={lostModeForm.contact_email}
                onChange={(e) =>
                  setLostModeForm((f) => ({ ...f, contact_email: e.target.value }))
                }
                placeholder="your@email.com"
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-apple-blue outline-none"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Message</label>
              <textarea
                value={lostModeForm.message}
                onChange={(e) =>
                  setLostModeForm((f) => ({ ...f, message: e.target.value }))
                }
                placeholder="This item has been lost. Please contact the owner."
                rows={2}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-apple-blue outline-none resize-none"
              />
            </div>
            <div className="flex space-x-3">
              <button
                onClick={() => setIsEditingLostMode(false)}
                className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-100 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveLostMode}
                className="flex-1 bg-apple-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition"
              >
                Enable Lost Mode
              </button>
            </div>
          </div>
        )}

        {lostMode?.enabled && !isEditingLostMode && (
          <div className="pt-3 border-t text-sm text-gray-600">
            {lostMode.contact_phone && (
              <p>Phone: {lostMode.contact_phone}</p>
            )}
            {lostMode.contact_email && (
              <p>Email: {lostMode.contact_email}</p>
            )}
            {lostMode.message && <p>Message: {lostMode.message}</p>}
            {lostMode.enabled_at && (
              <p className="text-gray-400 mt-2">
                Enabled: {new Date(lostMode.enabled_at).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>

      {/* Delete */}
      <div className="pt-3 border-t">
        {showDeleteConfirm ? (
          <div className="flex items-center justify-between bg-red-50 p-3 rounded-lg">
            <span className="text-apple-red">Delete this device?</span>
            <div className="flex space-x-2">
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="px-3 py-1 bg-gray-200 rounded hover:bg-gray-300 transition"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1 bg-apple-red text-white rounded hover:bg-red-600 transition"
              >
                Delete
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="text-apple-red hover:underline text-sm"
          >
            Remove Device
          </button>
        )}
      </div>
    </div>
  );
}
