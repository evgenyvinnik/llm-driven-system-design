import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useHealthStore } from '../stores/healthStore';
import { HealthChart } from '../components/HealthChart';

const METRIC_CONFIG: Record<string, { name: string; color: string; unit: string }> = {
  STEPS: { name: 'Steps', color: 'blue', unit: 'steps' },
  HEART_RATE: { name: 'Heart Rate', color: 'red', unit: 'bpm' },
  RESTING_HEART_RATE: { name: 'Resting Heart Rate', color: 'red', unit: 'bpm' },
  SLEEP_ANALYSIS: { name: 'Sleep', color: 'purple', unit: 'min' },
  ACTIVE_ENERGY: { name: 'Active Calories', color: 'orange', unit: 'kcal' },
  WEIGHT: { name: 'Weight', color: 'yellow', unit: 'kg' },
  DISTANCE: { name: 'Distance', color: 'cyan', unit: 'm' },
  BLOOD_PRESSURE_SYSTOLIC: { name: 'Blood Pressure (Systolic)', color: 'red', unit: 'mmHg' },
  BLOOD_PRESSURE_DIASTOLIC: { name: 'Blood Pressure (Diastolic)', color: 'red', unit: 'mmHg' },
  OXYGEN_SATURATION: { name: 'Blood Oxygen', color: 'cyan', unit: '%' },
};

export function Metrics() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuthStore();
  const { history, fetchHistory, isLoading } = useHealthStore();
  const [selectedMetric, setSelectedMetric] = useState('STEPS');
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    fetchHistory(selectedMetric, days);
  }, [isAuthenticated, navigate, selectedMetric, days, fetchHistory]);

  if (!isAuthenticated) {
    return null;
  }

  const metricConfig = METRIC_CONFIG[selectedMetric] || {
    name: selectedMetric,
    color: 'blue',
    unit: '',
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Health Metrics</h1>
        <p className="text-gray-600">Explore your health data over time</p>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap gap-4">
          <div>
            <label htmlFor="metric" className="block text-sm font-medium text-gray-700 mb-1">
              Metric
            </label>
            <select
              id="metric"
              value={selectedMetric}
              onChange={(e) => setSelectedMetric(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-health-500 focus:border-health-500"
            >
              {Object.entries(METRIC_CONFIG).map(([key, config]) => (
                <option key={key} value={key}>
                  {config.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="days" className="block text-sm font-medium text-gray-700 mb-1">
              Time Range
            </label>
            <select
              id="days"
              value={days}
              onChange={(e) => setDays(parseInt(e.target.value))}
              className="px-3 py-2 border border-gray-300 rounded-lg focus:ring-health-500 focus:border-health-500"
            >
              <option value={7}>Last 7 days</option>
              <option value={14}>Last 14 days</option>
              <option value={30}>Last 30 days</option>
              <option value={60}>Last 60 days</option>
              <option value={90}>Last 90 days</option>
            </select>
          </div>
        </div>
      </div>

      {/* Chart */}
      {isLoading ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-health-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading data...</p>
        </div>
      ) : history[selectedMetric] && history[selectedMetric].length > 0 ? (
        <HealthChart
          data={history[selectedMetric]}
          title={`${metricConfig.name} - Last ${days} Days`}
          color={metricConfig.color}
          unit={metricConfig.unit}
          type="area"
          showMinMax
        />
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <svg
            className="mx-auto h-12 w-12 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
            />
          </svg>
          <h3 className="mt-4 text-lg font-medium text-gray-900">No data available</h3>
          <p className="mt-2 text-gray-500">
            No {metricConfig.name.toLowerCase()} data found for the selected period.
          </p>
        </div>
      )}

      {/* Stats */}
      {history[selectedMetric] && history[selectedMetric].length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Statistics</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-sm text-gray-600">Average</p>
              <p className="text-xl font-bold text-gray-900">
                {(
                  history[selectedMetric].reduce((sum, d) => sum + d.value, 0) /
                  history[selectedMetric].length
                ).toFixed(1)}{' '}
                <span className="text-sm font-normal text-gray-500">{metricConfig.unit}</span>
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Minimum</p>
              <p className="text-xl font-bold text-gray-900">
                {Math.min(...history[selectedMetric].map((d) => d.value)).toFixed(1)}{' '}
                <span className="text-sm font-normal text-gray-500">{metricConfig.unit}</span>
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Maximum</p>
              <p className="text-xl font-bold text-gray-900">
                {Math.max(...history[selectedMetric].map((d) => d.value)).toFixed(1)}{' '}
                <span className="text-sm font-normal text-gray-500">{metricConfig.unit}</span>
              </p>
            </div>
            <div>
              <p className="text-sm text-gray-600">Data Points</p>
              <p className="text-xl font-bold text-gray-900">{history[selectedMetric].length}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
