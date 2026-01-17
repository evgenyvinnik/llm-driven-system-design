/**
 * Home page - shows welcome and recent highlights
 * @module routes/index
 */
import { createFileRoute, Link } from '@tanstack/react-router'
import { useStore } from '@/stores/useStore'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  const { isAuthenticated } = useStore()

  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold text-gray-900">
          Discover What the World is Reading
        </h1>
        <p className="mb-8 text-xl text-gray-600">
          Highlight passages, sync across devices, and discover popular quotes
          from millions of readers.
        </p>

        {!isAuthenticated ? (
          <div className="flex justify-center gap-4">
            <Link
              to="/register"
              className="rounded-lg bg-blue-600 px-6 py-3 text-lg font-medium text-white hover:bg-blue-700"
            >
              Get Started Free
            </Link>
            <Link
              to="/login"
              className="rounded-lg border border-gray-300 bg-white px-6 py-3 text-lg font-medium text-gray-700 hover:bg-gray-50"
            >
              Sign In
            </Link>
          </div>
        ) : (
          <Link
            to="/library"
            className="rounded-lg bg-blue-600 px-6 py-3 text-lg font-medium text-white hover:bg-blue-700"
          >
            Go to My Library
          </Link>
        )}
      </div>

      <div className="mt-16 grid gap-8 md:grid-cols-3">
        <FeatureCard
          icon="✨"
          title="Highlight Anywhere"
          description="Select text to create highlights with notes and colors. Works across all your devices."
        />
        <FeatureCard
          icon="👥"
          title="Community Insights"
          description="See what passages resonate with other readers. Discover popular highlights."
        />
        <FeatureCard
          icon="📤"
          title="Export Your Notes"
          description="Download your highlights as Markdown, CSV, or JSON for use anywhere."
        />
      </div>

      <div className="mt-16">
        <h2 className="mb-6 text-center text-2xl font-semibold text-gray-900">
          How It Works
        </h2>
        <div className="grid gap-6 md:grid-cols-4">
          <StepCard step={1} title="Add Books" description="Import your reading list" />
          <StepCard step={2} title="Highlight" description="Select meaningful passages" />
          <StepCard step={3} title="Sync" description="Access from any device" />
          <StepCard step={4} title="Discover" description="See community highlights" />
        </div>
      </div>
    </div>
  )
}

interface FeatureCardProps {
  icon: string
  title: string
  description: string
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
  return (
    <div className="rounded-lg bg-white p-6 shadow-sm">
      <div className="mb-4 text-4xl">{icon}</div>
      <h3 className="mb-2 text-lg font-semibold text-gray-900">{title}</h3>
      <p className="text-gray-600">{description}</p>
    </div>
  )
}

interface StepCardProps {
  step: number
  title: string
  description: string
}

function StepCard({ step, title, description }: StepCardProps) {
  return (
    <div className="text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-blue-100 text-lg font-bold text-blue-600">
        {step}
      </div>
      <h4 className="font-medium text-gray-900">{title}</h4>
      <p className="text-sm text-gray-500">{description}</p>
    </div>
  )
}
