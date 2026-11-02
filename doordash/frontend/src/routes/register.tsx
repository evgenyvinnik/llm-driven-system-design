import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import type { Driver } from '../types';

/**
 * Registration page route configuration.
 * Provides new user account creation.
 */
export const Route = createFileRoute('/register')({
  component: RegisterPage,
});

/**
 * Registration page component for new user sign-up.
 * Provides a form for creating customer, restaurant owner, or driver accounts.
 * The server always registers a customer; choosing Sell Food or Deliver Food
 * runs the matching onboarding call right after sign-up.
 *
 * Features:
 * - Role selection (Order Food, Sell Food, Deliver Food)
 * - Vehicle type and optional license plate for drivers
 * - Name, email, phone, and password inputs
 * - Error display with dismiss button
 * - Loading state during registration
 * - Redirect to home on successful registration
 *
 * @returns React component for the registration page
 */
function RegisterPage() {
  const navigate = useNavigate();
  const { register, isLoading, error, clearError } = useAuthStore();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'customer' | 'restaurant_owner' | 'driver'>('customer');
  const [vehicleType, setVehicleType] = useState<Driver['vehicle_type']>('car');
  const [licensePlate, setLicensePlate] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await register(
        { email, password, name, phone },
        role === 'driver'
          ? { as: 'driver', vehicleType, licensePlate: licensePlate || undefined }
          : role === 'restaurant_owner'
            ? { as: 'restaurant_owner' }
            : undefined
      );
      navigate({ to: '/' });
    } catch {
      // Error handled by store
    }
  };

  return (
    <div className="max-w-md mx-auto px-4 py-16">
      <div className="bg-white rounded-lg shadow-sm p-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Create an account</h1>

        {error && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4">
            {error}
            <button onClick={clearError} className="float-right text-red-400 hover:text-red-600">
              x
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">I want to</label>
            <div className="grid grid-cols-3 gap-2">
              {[
                { value: 'customer', label: 'Order Food' },
                { value: 'restaurant_owner', label: 'Sell Food' },
                { value: 'driver', label: 'Deliver Food' },
              ].map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setRole(option.value as typeof role)}
                  className={`p-3 rounded-lg border text-sm font-medium transition ${
                    role === option.value
                      ? 'border-doordash-red bg-red-50 text-doordash-red'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Phone (optional)</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
            />
          </div>

          {role === 'driver' && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Vehicle</label>
                <select
                  value={vehicleType}
                  onChange={(e) => setVehicleType(e.target.value as Driver['vehicle_type'])}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
                >
                  <option value="car">Car</option>
                  <option value="bike">Bike</option>
                  <option value="scooter">Scooter</option>
                  <option value="walk">On foot</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">License plate (optional)</label>
                <input
                  type="text"
                  value={licensePlate}
                  onChange={(e) => setLicensePlate(e.target.value)}
                  maxLength={20}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
                />
              </div>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-doordash-red focus:border-transparent"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-doordash-red text-white py-3 rounded-lg font-medium hover:bg-doordash-darkRed transition disabled:opacity-50"
          >
            {isLoading ? 'Creating account...' : 'Sign up'}
          </button>
        </form>
      </div>
    </div>
  );
}
