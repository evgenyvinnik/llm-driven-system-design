import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAuthStore } from '../stores/authStore';
import { useHealthStore } from '../stores/healthStore';
import { MetricCard } from '../components/MetricCard';
import { HealthChart } from '../components/HealthChart';
import { InsightCard } from '../components/InsightCard';

export function Dashboard() {
  const navigate = useNavigate();
  const { isAuthenticated, user } = useAuthStore();
  const {
    dailySummary,
    insights,
    history,
    fetchDailySummary,
    fetchInsights,
    fetchHistory,
    acknowledgeInsight,
  } = useHealthStore();

  useEffect(() => {
    if (!isAuthenticated) {
      navigate({ to: '/login' });
      return;
    }

    fetchDailySummary();
    fetchInsights();
    fetchHistory('STEPS', 30);
    fetchHistory('HEART_RATE', 30);
  }, [isAuthenticated, navigate, fetchDailySummary, fetchInsights, fetchHistory]);

  if (!isAuthenticated) {
    return null;
  }

  const formatNumber = (value: number | undefined, decimals = 0) => {
    if (value === undefined) return '--';
    return value.toLocaleString(undefined, { maximumFractionDigits: decimals });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Welcome back, {user?.name || 'User'}
          </h1>
          <p className="text-gray-600">Here is your health summary for today</p>
        </div>
        <div className="text-sm text-gray-500">
          {new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
          })}
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          title="Steps"
          value={formatNumber(dailySummary?.STEPS?.value)}
          unit="steps"
          color="blue"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          }
          subtitle={dailySummary?.STEPS ? `${dailySummary.STEPS.sampleCount} samples` : undefined}
        />

        <MetricCard
          title="Heart Rate"
          value={formatNumber(dailySummary?.HEART_RATE?.value, 0)}
          unit="bpm"
          color="red"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
            </svg>
          }
          subtitle={
            dailySummary?.HEART_RATE
              ? `Range: ${formatNumber(dailySummary.HEART_RATE.minValue)}-${formatNumber(dailySummary.HEART_RATE.maxValue)}`
              : undefined
          }
        />

        <MetricCard
          title="Sleep"
          value={formatNumber((dailySummary?.SLEEP_ANALYSIS?.value || 0) / 60, 1)}
          unit="hours"
          color="purple"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          }
        />

        <MetricCard
          title="Active Calories"
          value={formatNumber(dailySummary?.ACTIVE_ENERGY?.value)}
          unit="kcal"
          color="orange"
          icon={
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z" />
            </svg>
          }
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {history.STEPS && history.STEPS.length > 0 && (
          <HealthChart
            data={history.STEPS}
            title="Steps - Last 30 Days"
            color="blue"
            unit="steps"
            type="area"
          />
        )}

        {history.HEART_RATE && history.HEART_RATE.length > 0 && (
          <HealthChart
            data={history.HEART_RATE}
            title="Heart Rate - Last 30 Days"
            color="red"
            unit="bpm"
            showMinMax
          />
        )}
      </div>

      {/* Insights */}
      {insights.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Health Insights</h2>
          <div className="space-y-3">
            {insights.slice(0, 5).map((insight) => (
              <InsightCard
                key={insight.id}
                insight={insight}
                onAcknowledge={acknowledgeInsight}
              />
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!dailySummary && (
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
          <h3 className="mt-4 text-lg font-medium text-gray-900">No health data yet</h3>
          <p className="mt-2 text-gray-500">
            Connect a device to start tracking your health metrics.
          </p>
        </div>
      )}
    </div>
  );
}
