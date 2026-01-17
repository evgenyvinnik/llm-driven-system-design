import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { CreditCard, CreditCardSkeleton } from '../components/CreditCard';
import { AddCardForm } from '../components/AddCardForm';
import { useAuthStore, useWalletStore } from '../stores';

export const Route = createFileRoute('/')({
  component: WalletPage,
});

function WalletPage() {
  const { devices, loadDevices, registerDevice } = useAuthStore();
  const { cards, isLoading, loadCards, addCard, suspendCard, reactivateCard, removeCard, setDefaultCard } = useWalletStore();
  const [showAddCard, setShowAddCard] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null);
  const [showAddDevice, setShowAddDevice] = useState(false);
  const [newDeviceName, setNewDeviceName] = useState('');
  const [newDeviceType, setNewDeviceType] = useState<'iphone' | 'apple_watch' | 'ipad'>('iphone');

  useEffect(() => {
    loadCards();
    loadDevices();
  }, [loadCards, loadDevices]);

  const activeDevices = devices.filter((d) => d.status === 'active');

  const handleAddCard = async (data: Parameters<typeof addCard>[0]) => {
    await addCard(data);
    setShowAddCard(false);
    setSelectedDeviceId(null);
  };

  const handleAddDevice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDeviceName.trim()) return;

    await registerDevice(newDeviceName, newDeviceType);
    setShowAddDevice(false);
    setNewDeviceName('');
  };

  return (
    <Layout title="Wallet">
      {/* Devices section */}
      <section className="mb-6">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-apple-gray-500 uppercase tracking-wide">
            Devices
          </h2>
          <button
            onClick={() => setShowAddDevice(true)}
            className="text-apple-blue text-sm"
          >
            + Add Device
          </button>
        </div>

        {showAddDevice && (
          <div className="card mb-4">
            <form onSubmit={handleAddDevice} className="space-y-4">
              <input
                type="text"
                value={newDeviceName}
                onChange={(e) => setNewDeviceName(e.target.value)}
                placeholder="Device name (e.g., My iPhone 15)"
                className="input"
              />
              <select
                value={newDeviceType}
                onChange={(e) => setNewDeviceType(e.target.value as any)}
                className="input"
              >
                <option value="iphone">iPhone</option>
                <option value="apple_watch">Apple Watch</option>
                <option value="ipad">iPad</option>
              </select>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddDevice(false)}
                  className="btn-secondary flex-1"
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary flex-1">
                  Add
                </button>
              </div>
            </form>
          </div>
        )}

        <div className="flex gap-2 overflow-x-auto pb-2">
          {activeDevices.map((device) => (
            <div
              key={device.id}
              className="flex-shrink-0 bg-white rounded-xl px-4 py-3 flex items-center gap-3"
            >
              <div className="w-10 h-10 bg-apple-gray-100 rounded-full flex items-center justify-center">
                {device.device_type === 'iphone' && (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14z" />
                  </svg>
                )}
                {device.device_type === 'apple_watch' && (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M20 12c0-2.54-1.19-4.81-3.04-6.27L16 0H8l-.95 5.73C5.19 7.19 4 9.45 4 12s1.19 4.81 3.05 6.27L8 24h8l.96-5.73C18.81 16.81 20 14.54 20 12zM6 12c0-3.31 2.69-6 6-6s6 2.69 6 6-2.69 6-6 6-6-2.69-6-6z" />
                  </svg>
                )}
                {device.device_type === 'ipad' && (
                  <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M19 1H5c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H5V5h14v14z" />
                  </svg>
                )}
              </div>
              <div>
                <div className="font-medium text-sm">{device.device_name}</div>
                <div className="text-xs text-apple-gray-500">
                  {cards.filter((c) => c.device_id === device.id && c.status !== 'deleted').length} cards
                </div>
              </div>
            </div>
          ))}

          {activeDevices.length === 0 && (
            <div className="text-apple-gray-500 text-sm py-4">
              No devices registered. Add a device to get started.
            </div>
          )}
        </div>
      </section>

      {/* Cards section */}
      <section>
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-apple-gray-500 uppercase tracking-wide">
            Payment Cards
          </h2>
          {activeDevices.length > 0 && !showAddCard && (
            <button
              onClick={() => {
                if (activeDevices.length === 1) {
                  setSelectedDeviceId(activeDevices[0].id);
                  setShowAddCard(true);
                } else {
                  // Show device selection
                  setSelectedDeviceId(null);
                  setShowAddCard(true);
                }
              }}
              className="text-apple-blue text-sm"
            >
              + Add Card
            </button>
          )}
        </div>

        {showAddCard && (
          <div className="card mb-6">
            {!selectedDeviceId && activeDevices.length > 1 ? (
              <div className="space-y-4">
                <h3 className="font-semibold">Select Device</h3>
                {activeDevices.map((device) => (
                  <button
                    key={device.id}
                    onClick={() => setSelectedDeviceId(device.id)}
                    className="w-full p-4 border border-apple-gray-200 rounded-xl text-left hover:bg-apple-gray-50"
                  >
                    {device.device_name}
                  </button>
                ))}
                <button
                  onClick={() => setShowAddCard(false)}
                  className="btn-secondary w-full"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <AddCardForm
                deviceId={selectedDeviceId || activeDevices[0]?.id}
                onSubmit={handleAddCard}
                onCancel={() => {
                  setShowAddCard(false);
                  setSelectedDeviceId(null);
                }}
                isLoading={isLoading}
              />
            )}
          </div>
        )}

        {isLoading && cards.length === 0 ? (
          <div className="space-y-4">
            <CreditCardSkeleton />
            <CreditCardSkeleton />
          </div>
        ) : cards.length === 0 ? (
          <div className="text-center py-12 text-apple-gray-500">
            <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
            </svg>
            <p>No cards yet</p>
            <p className="text-sm">Add a card to start using Apple Pay</p>
          </div>
        ) : (
          <div className="space-y-6">
            {cards.filter((c) => c.status !== 'deleted').map((card) => (
              <CreditCard
                key={card.id}
                card={card}
                showActions
                onSuspend={() => suspendCard(card.id, 'user_request')}
                onReactivate={() => reactivateCard(card.id)}
                onRemove={() => {
                  if (confirm('Remove this card from your wallet?')) {
                    removeCard(card.id);
                  }
                }}
                onSetDefault={() => setDefaultCard(card.id)}
              />
            ))}
          </div>
        )}
      </section>
    </Layout>
  );
}
