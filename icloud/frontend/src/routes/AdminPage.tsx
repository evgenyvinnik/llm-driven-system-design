import React from 'react';
import { AdminDashboard } from '../components/AdminDashboard';

export const AdminPage: React.FC = () => {
  return (
    <div className="min-h-[calc(100vh-3.5rem)] bg-white">
      <AdminDashboard />
    </div>
  );
};
