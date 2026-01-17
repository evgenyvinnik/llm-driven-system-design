// Main App Component

import { HealthStatus } from './components/HealthStatus';
import { MetricsDashboard } from './components/MetricsDashboard';
import { AlgorithmSelector } from './components/AlgorithmSelector';
import { TestConfiguration } from './components/TestConfiguration';
import { TestRunner } from './components/TestRunner';
import { TestResults } from './components/TestResults';

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Rate Limiter Dashboard</h1>
              <p className="text-sm text-gray-600">
                Test and monitor distributed rate limiting algorithms
              </p>
            </div>
            <HealthStatus />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="space-y-6">
          {/* Metrics */}
          <MetricsDashboard />

          {/* Algorithm Selection */}
          <AlgorithmSelector />

          {/* Configuration and Runner */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <TestConfiguration />
            <TestRunner />
          </div>

          {/* Results */}
          <TestResults />
        </div>
      </main>

      {/* Footer */}
      <footer className="bg-white border-t mt-8">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <p className="text-sm text-gray-500 text-center">
            Rate Limiter Learning Project - Implements Fixed Window, Sliding Window, Sliding Log, Token Bucket, and Leaky Bucket algorithms
          </p>
        </div>
      </footer>
    </div>
  );
}
