import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { RequestMoneyForm } from '../components/RequestMoneyForm';
import { OutgoingRequests } from '../components/OutgoingRequests';

function RequestPage() {
  const user = useAuthStore((s) => s.user);
  const loading = useAuthStore((s) => s.loading);
  const navigate = useNavigate();
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!loading && !user) {
      navigate({ to: '/login' });
    }
  }, [user, loading, navigate]);

  if (loading || !user) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-paypal-secondary">Loading...</div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="max-w-xl mx-auto px-4 py-8">
        <div className="bg-white rounded-xl shadow-sm border border-paypal-border p-8 text-center">
          <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-paypal-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-paypal-text mb-2">Request Sent!</h2>
          <p className="text-paypal-secondary mb-6">Your money request has been sent.</p>
          <div className="flex justify-center space-x-4">
            <button
              onClick={() => setSuccess(false)}
              className="px-6 py-2 bg-paypal-primary text-white rounded-lg hover:bg-paypal-hover"
            >
              Request More
            </button>
            <button
              onClick={() => navigate({ to: '/' })}
              className="px-6 py-2 border border-paypal-border text-paypal-text rounded-lg hover:bg-gray-50"
            >
              Back to Dashboard
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-paypal-text mb-6">Request Money</h1>
      <RequestMoneyForm onSuccess={() => setSuccess(true)} />
      <OutgoingRequests currentUserId={user.id} />
    </div>
  );
}

export const Route = createFileRoute('/request')({
  component: RequestPage,
});
