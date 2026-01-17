import { useEffect, useState } from 'react';
import { customersApi } from '../../services/api';
import { Customer } from '../../types';
import { ContentLoadingSpinner } from '../common';

/**
 * Props for CustomersTab component.
 */
interface CustomersTabProps {
  /** Store ID to load customers for */
  storeId: number;
}

/**
 * Customers tab component.
 * Displays customer list with order history summary.
 *
 * @param props - Customers tab configuration
 * @returns Customers table interface
 */
export function CustomersTab({ storeId }: CustomersTabProps) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadCustomers = async () => {
      try {
        const { customers } = await customersApi.list(storeId);
        setCustomers(customers);
      } catch (error) {
        console.error('Failed to load customers:', error);
      } finally {
        setLoading(false);
      }
    };
    loadCustomers();
  }, [storeId]);

  if (loading) {
    return <ContentLoadingSpinner />;
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-medium text-gray-900">{customers.length} customers</h2>

      {customers.length === 0 ? (
        <EmptyCustomersState />
      ) : (
        <CustomersTable customers={customers} />
      )}
    </div>
  );
}

/**
 * Empty state when no customers exist.
 */
function EmptyCustomersState() {
  return (
    <div className="bg-white rounded-xl shadow-sm p-12 text-center">
      <p className="text-gray-500">No customers yet. Customer accounts will appear here after checkout.</p>
    </div>
  );
}

/**
 * Customers table component.
 */
interface CustomersTableProps {
  customers: Customer[];
}

function CustomersTable({ customers }: CustomersTableProps) {
  return (
    <div className="bg-white rounded-xl shadow-sm overflow-hidden">
      <table className="w-full">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Customer</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Email</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Orders</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Total Spent</th>
            <th className="text-left px-6 py-3 text-sm font-medium text-gray-500">Joined</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {customers.map((customer) => (
            <CustomerRow key={customer.id} customer={customer} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Individual customer row component.
 */
interface CustomerRowProps {
  customer: Customer;
}

function CustomerRow({ customer }: CustomerRowProps) {
  return (
    <tr className="hover:bg-gray-50">
      <td className="px-6 py-4 font-medium text-gray-900">
        {customer.first_name} {customer.last_name}
      </td>
      <td className="px-6 py-4 text-gray-600">{customer.email}</td>
      <td className="px-6 py-4 text-gray-600">{customer.order_count || 0}</td>
      <td className="px-6 py-4 font-medium">${customer.total_spent || 0}</td>
      <td className="px-6 py-4 text-gray-500 text-sm">
        {new Date(customer.created_at).toLocaleDateString()}
      </td>
    </tr>
  );
}
