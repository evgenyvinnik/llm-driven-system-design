import React from 'react';
import { AdminDashboard } from '../components/AdminDashboard';

/**
 * Admin page component for system administration.
 *
 * Wraps the AdminDashboard component in a page layout.
 * This route is protected and only accessible to users with admin role.
 *
 * @returns Admin page with dashboard
 */
export const AdminPage: React.FC = () => {
  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-white">
      <AdminDashboard />
    </div>
  );
};
