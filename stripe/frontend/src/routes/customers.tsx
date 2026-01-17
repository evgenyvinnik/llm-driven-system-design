/**
 * Customers Route
 *
 * Customer management page for viewing and managing customer records.
 * Provides customer creation, deletion, and displays associated payment methods.
 * Implements a master-detail layout similar to the payments page.
 *
 * @module routes/customers
 */

import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { listCustomers, createCustomer, deleteCustomer, listPaymentMethods } from '@/services/api';
import { formatDate } from '@/utils';
import { CardDisplay } from '@/components';
import type { Customer, PaymentMethod } from '@/types';

/**
 * Route definition for the customers page (/customers).
 */
export const Route = createFileRoute('/customers')({
  component: CustomersPage,
});

/**
 * Customers page component.
 * Lists all customers with ability to view details, associated payment methods,
 * create new customers, and delete existing ones.
 *
 * @returns The customers management page
 */
function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);

  useEffect(() => {
    loadCustomers();
  }, []);

  useEffect(() => {
    if (selectedCustomer) {
      loadPaymentMethods(selectedCustomer.id);
    }
  }, [selectedCustomer]);

  /**
   * Fetches the list of customers from the API.
   */
  async function loadCustomers() {
    try {
      setLoading(true);
      const result = await listCustomers({ limit: 50 });
      setCustomers(result.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  }

  /**
   * Fetches payment methods for a specific customer.
   * @param customerId - The customer ID to load payment methods for
   */
  async function loadPaymentMethods(customerId: string) {
    try {
      const result = await listPaymentMethods({ customer: customerId });
      setPaymentMethods(result.data);
    } catch (err) {
      console.error('Failed to load payment methods:', err);
      setPaymentMethods([]);
    }
  }

  /**
   * Creates a new customer with the provided data.
   * @param data - Customer creation data
   */
  async function handleCreate(data: { name: string; email: string; phone: string }) {
    try {
      await createCustomer(data);
      setShowCreateModal(false);
      loadCustomers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create customer');
    }
  }

  /**
   * Deletes a customer after user confirmation.
   * @param id - Customer ID to delete
   */
  async function handleDelete(id: string) {
    if (!confirm('Are you sure you want to delete this customer?')) return;

    try {
      await deleteCustomer(id);
      setSelectedCustomer(null);
      loadCustomers();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete customer');
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-stripe-gray-900">Customers</h1>
          <p className="text-stripe-gray-500 mt-1">Manage your customer records</p>
        </div>
        <button onClick={() => setShowCreateModal(true)} className="btn-primary">
          Add Customer
        </button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 p-4 rounded-lg">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Customer List */}
        <div className="lg:col-span-2">
          <div className="card">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={3} className="text-center py-8">
                      Loading...
                    </td>
                  </tr>
                ) : customers.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="text-center py-8 text-stripe-gray-500">
                      No customers found
                    </td>
                  </tr>
                ) : (
                  customers.map((customer) => (
                    <tr
                      key={customer.id}
                      className={`cursor-pointer ${selectedCustomer?.id === customer.id ? 'bg-stripe-purple/5' : ''}`}
                      onClick={() => setSelectedCustomer(customer)}
                    >
                      <td className="font-medium">
                        {customer.name || <span className="text-stripe-gray-400">No name</span>}
                      </td>
                      <td>{customer.email || '-'}</td>
                      <td className="text-stripe-gray-500">
                        {formatDate(customer.created)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Detail Panel */}
        <div className="lg:col-span-1">
          {selectedCustomer ? (
            <div className="card">
              <div className="card-header">
                <h3 className="font-semibold">Customer Details</h3>
              </div>
              <div className="card-body space-y-4">
                <div>
                  <div className="text-sm text-stripe-gray-500">Name</div>
                  <div className="font-medium">{selectedCustomer.name || 'Not provided'}</div>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Email</div>
                  <div>{selectedCustomer.email || 'Not provided'}</div>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Phone</div>
                  <div>{selectedCustomer.phone || 'Not provided'}</div>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Customer ID</div>
                  <code className="text-xs bg-stripe-gray-100 px-2 py-1 rounded break-all">
                    {selectedCustomer.id}
                  </code>
                </div>

                <div>
                  <div className="text-sm text-stripe-gray-500">Created</div>
                  <div>{formatDate(selectedCustomer.created)}</div>
                </div>

                {/* Payment Methods */}
                <div>
                  <div className="text-sm text-stripe-gray-500 mb-2">Payment Methods</div>
                  {paymentMethods.length === 0 ? (
                    <div className="text-stripe-gray-400 text-sm">No payment methods</div>
                  ) : (
                    <div className="space-y-2">
                      {paymentMethods.map((pm) => (
                        <div key={pm.id} className="flex items-center gap-2 p-2 bg-stripe-gray-50 rounded">
                          <CardDisplay
                            brand={pm.card.brand}
                            last4={pm.card.last4}
                            expMonth={pm.card.exp_month}
                            expYear={pm.card.exp_year}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="pt-4">
                  <button
                    onClick={() => handleDelete(selectedCustomer.id)}
                    className="btn-danger w-full"
                  >
                    Delete Customer
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="card card-body text-center text-stripe-gray-500">
              Select a customer to view details
            </div>
          )}
        </div>
      </div>

      {/* Create Modal */}
      {showCreateModal && (
        <CreateCustomerModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}
    </div>
  );
}

/**
 * Modal dialog for creating a new customer.
 * Collects name, email, and phone information via a form.
 *
 * @param props - Modal props
 * @param props.onClose - Callback to close the modal
 * @param props.onCreate - Callback with customer data when form is submitted
 */
function CreateCustomerModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (data: { name: string; email: string; phone: string }) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);

  /**
   * Handles form submission and calls onCreate callback.
   */
  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    await onCreate({ name, email, phone });
    setLoading(false);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg w-full max-w-md p-6">
        <h2 className="text-xl font-bold mb-4">Create Customer</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">Name</label>
            <input
              type="text"
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="John Doe"
            />
          </div>
          <div>
            <label className="label">Email</label>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
            />
          </div>
          <div>
            <label className="label">Phone</label>
            <input
              type="tel"
              className="input"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 555 123 4567"
            />
          </div>
          <div className="flex gap-3 pt-4">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">
              Cancel
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={loading}>
              {loading ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
