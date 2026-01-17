import { Link } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

export function HomePage() {
  const { isAuthenticated } = useAuthStore();

  return (
    <div className="min-h-[calc(100vh-64px)] flex flex-col items-center justify-center px-4">
      <div className="text-center max-w-3xl">
        <h1 className="text-5xl font-bold text-white mb-6">
          Master Your <span className="text-primary-500">Coding Skills</span>
        </h1>
        <p className="text-xl text-gray-400 mb-8">
          Practice coding problems, improve your algorithmic thinking, and prepare for technical interviews with our collection of programming challenges.
        </p>

        <div className="flex items-center justify-center gap-4">
          <Link
            to="/problems"
            className="px-6 py-3 bg-primary-500 text-white rounded-lg font-medium hover:bg-primary-600 transition-colors"
          >
            Start Practicing
          </Link>
          {!isAuthenticated && (
            <Link
              to="/register"
              className="px-6 py-3 border border-gray-600 text-gray-300 rounded-lg font-medium hover:border-gray-500 hover:text-white transition-colors"
            >
              Create Account
            </Link>
          )}
        </div>

        <div className="mt-16 grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="p-6 bg-dark-300 rounded-lg">
            <div className="text-3xl mb-4">&#128187;</div>
            <h3 className="text-lg font-semibold text-white mb-2">Code in Browser</h3>
            <p className="text-gray-400">
              Write and test your code directly in the browser with our integrated code editor.
            </p>
          </div>

          <div className="p-6 bg-dark-300 rounded-lg">
            <div className="text-3xl mb-4">&#9889;</div>
            <h3 className="text-lg font-semibold text-white mb-2">Instant Feedback</h3>
            <p className="text-gray-400">
              Get immediate results with our sandboxed code execution environment.
            </p>
          </div>

          <div className="p-6 bg-dark-300 rounded-lg">
            <div className="text-3xl mb-4">&#128200;</div>
            <h3 className="text-lg font-semibold text-white mb-2">Track Progress</h3>
            <p className="text-gray-400">
              Monitor your improvement with detailed statistics and submission history.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
