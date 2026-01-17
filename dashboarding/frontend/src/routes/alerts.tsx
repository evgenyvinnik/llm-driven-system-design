import { createFileRoute } from '@tanstack/react-router';
import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import type { AlertRule, AlertInstance } from '../types';
import {
  getAlertRules,
  getAlertInstances,
  createAlertRule,
  deleteAlertRule,
  updateAlertRule,
  evaluateAlertRule,
} from '../services/api';

export const Route = createFileRoute('/alerts')({
  component: AlertsPage,
});

function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [instances, setInstances] = useState<AlertInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'rules' | 'instances'>('rules');
  const [showCreate, setShowCreate] = useState(false);

  // Form state
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    metric_name: '',
    condition_operator: '>' as const,
    condition_threshold: 80,
    condition_aggregation: 'avg' as const,
    window_seconds: 300,
    severity: 'warning' as const,
  });

  const fetchData = async () => {
    try {
      setLoading(true);
      const [rulesData, instancesData] = await Promise.all([
        getAlertRules(),
        getAlertInstances({ limit: 50 }),
      ]);
      setRules(rulesData);
      setInstances(instancesData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch alerts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  const handleCreate = async () => {
    try {
      await createAlertRule({
        name: formData.name,
        description: formData.description || null,
        metric_name: formData.metric_name,
        tags: {},
        condition: {
          operator: formData.condition_operator,
          threshold: formData.condition_threshold,
          aggregation: formData.condition_aggregation,
        },
        window_seconds: formData.window_seconds,
        severity: formData.severity,
        notifications: [{ channel: 'console', target: 'default' }],
        enabled: true,
      });
      setShowCreate(false);
      setFormData({
        name: '',
        description: '',
        metric_name: '',
        condition_operator: '>',
        condition_threshold: 80,
        condition_aggregation: 'avg',
        window_seconds: 300,
        severity: 'warning',
      });
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create alert');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this alert rule?')) return;
    try {
      await deleteAlertRule(id);
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete alert');
    }
  };

  const handleToggle = async (rule: AlertRule) => {
    try {
      await updateAlertRule(rule.id, { enabled: !rule.enabled });
      fetchData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update alert');
    }
  };

  const handleEvaluate = async (id: string) => {
    try {
      const result = await evaluateAlertRule(id);
      alert(
        `Evaluation result:\nShould fire: ${result.should_fire}\nCurrent value: ${result.current_value?.toFixed(2) ?? 'N/A'}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to evaluate alert');
    }
  };

  const getSeverityColor = (severity: string) => {
    switch (severity) {
      case 'critical':
        return 'bg-red-600 text-white';
      case 'warning':
        return 'bg-yellow-600 text-white';
      default:
        return 'bg-blue-600 text-white';
    }
  };

  const getStatusColor = (status: string) => {
    return status === 'firing' ? 'text-red-400' : 'text-green-400';
  };

  if (loading && rules.length === 0) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-dashboard-muted">Loading alerts...</div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-bold text-dashboard-text">Alerts</h1>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="bg-dashboard-highlight hover:bg-dashboard-highlight/80 text-white px-4 py-2 rounded-md text-sm font-medium"
        >
          {showCreate ? 'Cancel' : 'New Alert Rule'}
        </button>
      </div>

      {error && (
        <div className="bg-red-900/50 border border-red-700 rounded-md px-4 py-2 mb-4 text-red-200">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4 mb-8">
          <h2 className="text-lg font-semibold mb-4">Create Alert Rule</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
                placeholder="High CPU Alert"
              />
            </div>
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">Metric Name</label>
              <input
                type="text"
                value={formData.metric_name}
                onChange={(e) => setFormData({ ...formData, metric_name: e.target.value })}
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
                placeholder="cpu.usage"
              />
            </div>
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">Condition</label>
              <div className="flex gap-2">
                <select
                  value={formData.condition_aggregation}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      condition_aggregation: e.target.value as 'avg' | 'min' | 'max',
                    })
                  }
                  className="bg-dashboard-bg border border-dashboard-accent rounded-md px-2 py-2 text-dashboard-text"
                >
                  <option value="avg">avg</option>
                  <option value="min">min</option>
                  <option value="max">max</option>
                  <option value="sum">sum</option>
                </select>
                <select
                  value={formData.condition_operator}
                  onChange={(e) =>
                    setFormData({ ...formData, condition_operator: e.target.value as '>' | '<' })
                  }
                  className="bg-dashboard-bg border border-dashboard-accent rounded-md px-2 py-2 text-dashboard-text"
                >
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                </select>
                <input
                  type="number"
                  value={formData.condition_threshold}
                  onChange={(e) =>
                    setFormData({ ...formData, condition_threshold: parseFloat(e.target.value) })
                  }
                  className="w-24 bg-dashboard-bg border border-dashboard-accent rounded-md px-2 py-2 text-dashboard-text"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">Severity</label>
              <select
                value={formData.severity}
                onChange={(e) =>
                  setFormData({ ...formData, severity: e.target.value as 'info' | 'warning' | 'critical' })
                }
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="block text-sm text-dashboard-muted mb-1">Window (seconds)</label>
              <input
                type="number"
                value={formData.window_seconds}
                onChange={(e) =>
                  setFormData({ ...formData, window_seconds: parseInt(e.target.value) })
                }
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
              />
            </div>
            <div className="col-span-2">
              <label className="block text-sm text-dashboard-muted mb-1">Description</label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                className="w-full bg-dashboard-bg border border-dashboard-accent rounded-md px-3 py-2 text-dashboard-text"
                placeholder="Optional description"
              />
            </div>
          </div>
          <button
            onClick={handleCreate}
            disabled={!formData.name || !formData.metric_name}
            className="mt-4 bg-dashboard-highlight hover:bg-dashboard-highlight/80 disabled:opacity-50 text-white px-4 py-2 rounded-md text-sm font-medium"
          >
            Create Alert Rule
          </button>
        </div>
      )}

      <div className="flex gap-4 mb-4">
        <button
          onClick={() => setActiveTab('rules')}
          className={`px-4 py-2 rounded-md text-sm font-medium ${
            activeTab === 'rules'
              ? 'bg-dashboard-accent text-dashboard-text'
              : 'text-dashboard-muted hover:text-dashboard-text'
          }`}
        >
          Alert Rules ({rules.length})
        </button>
        <button
          onClick={() => setActiveTab('instances')}
          className={`px-4 py-2 rounded-md text-sm font-medium ${
            activeTab === 'instances'
              ? 'bg-dashboard-accent text-dashboard-text'
              : 'text-dashboard-muted hover:text-dashboard-text'
          }`}
        >
          Alert History ({instances.length})
        </button>
      </div>

      {activeTab === 'rules' && (
        <div className="space-y-4">
          {rules.length === 0 ? (
            <div className="bg-dashboard-card border border-dashboard-accent rounded-lg p-8 text-center text-dashboard-muted">
              No alert rules configured
            </div>
          ) : (
            rules.map((rule) => (
              <div
                key={rule.id}
                className="bg-dashboard-card border border-dashboard-accent rounded-lg p-4"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <span
                      className={`px-2 py-1 rounded text-xs font-medium ${getSeverityColor(rule.severity)}`}
                    >
                      {rule.severity}
                    </span>
                    <div>
                      <h3 className="font-semibold text-dashboard-text">{rule.name}</h3>
                      <p className="text-sm text-dashboard-muted">
                        {rule.condition.aggregation}({rule.metric_name}) {rule.condition.operator}{' '}
                        {rule.condition.threshold} over {rule.window_seconds}s
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <button
                      onClick={() => handleToggle(rule)}
                      className={`px-3 py-1 rounded text-sm ${
                        rule.enabled ? 'bg-green-600' : 'bg-gray-600'
                      }`}
                    >
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </button>
                    <button
                      onClick={() => handleEvaluate(rule.id)}
                      className="text-dashboard-highlight hover:underline text-sm"
                    >
                      Test
                    </button>
                    <button
                      onClick={() => handleDelete(rule.id)}
                      className="text-red-400 hover:text-red-300 text-sm"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === 'instances' && (
        <div className="bg-dashboard-card border border-dashboard-accent rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="bg-dashboard-accent">
              <tr>
                <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Status</th>
                <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Rule</th>
                <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Value</th>
                <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Fired At</th>
                <th className="px-4 py-2 text-left text-sm text-dashboard-muted">Resolved At</th>
              </tr>
            </thead>
            <tbody>
              {instances.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-dashboard-muted">
                    No alert history
                  </td>
                </tr>
              ) : (
                instances.map((instance) => {
                  const rule = rules.find((r) => r.id === instance.rule_id);
                  return (
                    <tr key={instance.id} className="border-t border-dashboard-accent">
                      <td className={`px-4 py-2 font-medium ${getStatusColor(instance.status)}`}>
                        {instance.status}
                      </td>
                      <td className="px-4 py-2 text-dashboard-text">
                        {rule?.name || instance.rule_id}
                      </td>
                      <td className="px-4 py-2 text-dashboard-text">{instance.value.toFixed(2)}</td>
                      <td className="px-4 py-2 text-dashboard-muted">
                        {format(new Date(instance.fired_at), 'yyyy-MM-dd HH:mm:ss')}
                      </td>
                      <td className="px-4 py-2 text-dashboard-muted">
                        {instance.resolved_at
                          ? format(new Date(instance.resolved_at), 'yyyy-MM-dd HH:mm:ss')
                          : '-'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
