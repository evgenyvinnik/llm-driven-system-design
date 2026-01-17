import { createFileRoute, Link } from '@tanstack/react-router'

function SigningCompletePage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white p-8 rounded-lg shadow-lg text-center max-w-md">
        <svg
          className="w-20 h-20 text-green-500 mx-auto mb-6"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Signing Complete!</h1>
        <p className="text-gray-600 mb-6">
          Thank you for signing the document. All parties will be notified, and you will receive a
          copy of the completed document via email.
        </p>
        <Link
          to="/"
          className="inline-block bg-docusign-blue text-white px-6 py-3 rounded-lg font-medium hover:bg-docusign-dark"
        >
          Go to Dashboard
        </Link>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/signing-complete')({
  component: SigningCompletePage,
})
