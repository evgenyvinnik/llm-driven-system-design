import { useState } from 'react';
import { useStore } from '../stores/useStore';

const deviceTypes = [
  { type: 'airtag', name: 'AirTag', emoji: '&#9898;' },
  { type: 'iphone', name: 'iPhone', emoji: '&#128241;' },
  { type: 'macbook', name: 'MacBook', emoji: '&#128187;' },
  { type: 'ipad', name: 'iPad', emoji: '&#128241;' },
  { type: 'airpods', name: 'AirPods', emoji: '&#127911;' },
];

interface AddDeviceModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function AddDeviceModal({ isOpen, onClose }: AddDeviceModalProps) {
  const [step, setStep] = useState(1);
  const [selectedType, setSelectedType] = useState('');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { createDevice } = useStore();

  const handleSubmit = async () => {
    if (!selectedType || !name) return;

    setIsLoading(true);
    try {
      await createDevice({
        device_type: selectedType,
        name,
        emoji: emoji || undefined,
      });
      handleClose();
    } catch (error) {
      console.error('Failed to create device:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setStep(1);
    setSelectedType('');
    setName('');
    setEmoji('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold">Add New Device</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 text-2xl"
          >
            &times;
          </button>
        </div>

        {step === 1 && (
          <div>
            <p className="text-gray-500 mb-4">Select device type:</p>
            <div className="grid grid-cols-2 gap-3">
              {deviceTypes.map((device) => (
                <button
                  key={device.type}
                  onClick={() => {
                    setSelectedType(device.type);
                    setEmoji(device.emoji);
                    setStep(2);
                  }}
                  className="flex items-center space-x-3 p-4 rounded-xl border-2 border-gray-200 hover:border-apple-blue hover:bg-blue-50 transition"
                >
                  <span
                    className="text-2xl"
                    dangerouslySetInnerHTML={{ __html: device.emoji }}
                  />
                  <span className="font-medium">{device.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Device Name
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`My ${deviceTypes.find((d) => d.type === selectedType)?.name}`}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apple-blue focus:border-transparent outline-none"
                autoFocus
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Custom Emoji (optional)
              </label>
              <input
                type="text"
                value={emoji}
                onChange={(e) => setEmoji(e.target.value)}
                placeholder="e.g., &#128188;"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-apple-blue focus:border-transparent outline-none"
              />
            </div>

            <div className="flex space-x-3 pt-4">
              <button
                onClick={() => setStep(1)}
                className="flex-1 px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50 transition"
              >
                Back
              </button>
              <button
                onClick={handleSubmit}
                disabled={!name || isLoading}
                className="flex-1 bg-apple-blue text-white px-4 py-2 rounded-lg hover:bg-blue-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Adding...' : 'Add Device'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
