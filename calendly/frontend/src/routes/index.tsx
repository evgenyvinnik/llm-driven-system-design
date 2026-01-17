import { createFileRoute, Link } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';

export const Route = createFileRoute('/')({
  component: HomePage,
});

function HomePage() {
  const { isAuthenticated } = useAuthStore();

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
      {/* Hero Section */}
      <div className="text-center mb-16">
        <h1 className="text-5xl font-bold text-gray-900 mb-6">
          Easy scheduling ahead
        </h1>
        <p className="text-xl text-gray-600 max-w-2xl mx-auto mb-8">
          Calendly is your scheduling automation platform for eliminating the
          back-and-forth emails to find the perfect time.
        </p>
        {isAuthenticated ? (
          <Link to="/dashboard" className="btn btn-primary text-lg px-8 py-3">
            Go to Dashboard
          </Link>
        ) : (
          <div className="flex justify-center gap-4">
            <Link to="/register" className="btn btn-primary text-lg px-8 py-3">
              Get Started Free
            </Link>
            <Link to="/login" className="btn btn-secondary text-lg px-8 py-3">
              Log In
            </Link>
          </div>
        )}
      </div>

      {/* Features */}
      <div className="grid md:grid-cols-3 gap-8 mb-16">
        <div className="card text-center">
          <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold mb-2">Set Your Availability</h3>
          <p className="text-gray-600">
            Let invitees know when you're free by setting your working hours and buffer times.
          </p>
        </div>

        <div className="card text-center">
          <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold mb-2">Share Your Link</h3>
          <p className="text-gray-600">
            Share your personalized booking link with anyone you want to meet with.
          </p>
        </div>

        <div className="card text-center">
          <div className="w-12 h-12 bg-primary-100 rounded-lg flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-primary-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h3 className="text-lg font-semibold mb-2">Get Booked</h3>
          <p className="text-gray-600">
            Invitees pick a time that works for them, and the meeting is automatically added to your calendar.
          </p>
        </div>
      </div>

      {/* Demo Section */}
      <div className="card bg-gradient-to-r from-primary-50 to-blue-50 border border-primary-100">
        <div className="text-center py-8">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">
            Try the Demo
          </h2>
          <p className="text-gray-600 mb-6">
            See how easy it is to book a meeting with our demo user.
          </p>
          <Link
            to="/book/$meetingTypeId"
            params={{ meetingTypeId: 'b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' }}
            className="btn btn-primary"
          >
            Book a Demo Meeting
          </Link>
          <p className="text-sm text-gray-500 mt-4">
            Demo login: demo@example.com / demo123
          </p>
        </div>
      </div>
    </div>
  );
}
