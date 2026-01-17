import { createFileRoute } from '@tanstack/react-router';
import { UrlShortener } from '../components/UrlShortener';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  return (
    <div className="space-y-8">
      <div className="text-center max-w-2xl mx-auto">
        <h1 className="text-4xl font-bold mb-4">Shorten Your URLs</h1>
        <p className="text-gray-600">
          Create short, memorable links that are easy to share. Track clicks and analyze
          your link performance.
        </p>
      </div>

      <UrlShortener />

      <div className="max-w-2xl mx-auto mt-12">
        <h2 className="text-2xl font-bold mb-4 text-center">Features</h2>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="card text-center">
            <div className="text-3xl mb-2">🔗</div>
            <h3 className="font-semibold mb-2">Shorten URLs</h3>
            <p className="text-sm text-gray-600">
              Convert long URLs into short, shareable links instantly.
            </p>
          </div>
          <div className="card text-center">
            <div className="text-3xl mb-2">📊</div>
            <h3 className="font-semibold mb-2">Track Analytics</h3>
            <p className="text-sm text-gray-600">
              Monitor clicks, referrers, and device types for each link.
            </p>
          </div>
          <div className="card text-center">
            <div className="text-3xl mb-2">✨</div>
            <h3 className="font-semibold mb-2">Custom Links</h3>
            <p className="text-sm text-gray-600">
              Create memorable custom short codes for your links.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
