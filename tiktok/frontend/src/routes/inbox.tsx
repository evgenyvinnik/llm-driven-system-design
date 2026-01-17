import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/inbox')({
  component: InboxPage,
});

function InboxPage() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center pb-14">
      <svg className="w-16 h-16 text-gray-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
      </svg>
      <h2 className="text-xl font-semibold text-gray-400">Inbox</h2>
      <p className="text-gray-500 mt-2">Messages coming soon!</p>
    </div>
  );
}
