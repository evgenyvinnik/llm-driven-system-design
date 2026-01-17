import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAdminStore } from '../../stores/adminStore';
import type { Campaign, Template } from '../../types';

function CampaignsPage() {
  const {
    campaigns,
    templates,
    isLoading,
    fetchCampaigns,
    fetchTemplates,
    createCampaign,
    startCampaign,
    cancelCampaign,
  } = useAdminStore();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    description: '',
    templateId: '',
    channels: ['email'],
    priority: 'normal',
  });

  useEffect(() => {
    fetchCampaigns();
    fetchTemplates();
  }, [fetchCampaigns, fetchTemplates]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createCampaign({
        name: formData.name,
        description: formData.description || undefined,
        templateId: formData.templateId || undefined,
        channels: formData.channels,
        priority: formData.priority,
      });
      setShowForm(false);
      setFormData({ name: '', description: '', templateId: '', channels: ['email'], priority: 'normal' });
    } catch {
      // Error handled by store
    }
  };

  const handleStart = async (id: string) => {
    if (confirm('Are you sure you want to start this campaign?')) {
      try {
        const result = await startCampaign(id);
        alert(`Campaign started! Sent to ${result.sentCount} users.`);
      } catch {
        // Error handled by store
      }
    }
  };

  const handleCancel = async (id: string) => {
    if (confirm('Are you sure you want to cancel this campaign?')) {
      await cancelCampaign(id);
    }
  };

  const toggleChannel = (channel: string) => {
    setFormData((prev) => ({
      ...prev,
      channels: prev.channels.includes(channel)
        ? prev.channels.filter((c) => c !== channel)
        : [...prev.channels, channel],
    }));
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 text-green-800';
      case 'running':
        return 'bg-blue-100 text-blue-800';
      case 'scheduled':
        return 'bg-yellow-100 text-yellow-800';
      case 'cancelled':
        return 'bg-red-100 text-red-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Campaigns</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700"
        >
          {showForm ? 'Cancel' : 'Create Campaign'}
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-md font-semibold mb-4">New Campaign</h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                required
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <textarea
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                rows={2}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Template</label>
              <select
                value={formData.templateId}
                onChange={(e) => setFormData((prev) => ({ ...prev, templateId: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="">Select a template</option>
                {templates.map((template: Template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Channels</label>
              <div className="flex space-x-4">
                {['push', 'email', 'sms'].map((channel) => (
                  <label key={channel} className="flex items-center">
                    <input
                      type="checkbox"
                      checked={formData.channels.includes(channel)}
                      onChange={() => toggleChannel(channel)}
                      className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
                    />
                    <span className="ml-2 text-sm text-gray-700 capitalize">{channel}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
              <select
                value={formData.priority}
                onChange={(e) => setFormData((prev) => ({ ...prev, priority: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              >
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create Campaign'}
            </button>
          </form>
        </div>
      )}

      {/* Campaigns List */}
      <div className="bg-white rounded-lg shadow">
        {isLoading && campaigns.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
        ) : campaigns.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">No campaigns found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {campaigns.map((campaign: Campaign) => (
              <div key={campaign.id} className="px-6 py-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-900">{campaign.name}</span>
                      <span className={`px-2 py-1 text-xs font-medium rounded-full ${getStatusColor(campaign.status)}`}>
                        {campaign.status}
                      </span>
                    </div>
                    {campaign.description && (
                      <div className="mt-1 text-sm text-gray-500">{campaign.description}</div>
                    )}
                    <div className="mt-2 text-xs text-gray-400 space-x-4">
                      <span>Channels: {campaign.channels.join(', ')}</span>
                      {campaign.total_sent !== undefined && <span>Sent: {campaign.total_sent}</span>}
                      {campaign.total_delivered !== undefined && <span>Delivered: {campaign.total_delivered}</span>}
                      {campaign.total_failed !== undefined && campaign.total_failed > 0 && (
                        <span className="text-red-500">Failed: {campaign.total_failed}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex space-x-2">
                    {campaign.status === 'draft' && (
                      <button
                        onClick={() => handleStart(campaign.id)}
                        className="px-3 py-1 text-sm text-white bg-green-600 rounded hover:bg-green-700"
                      >
                        Start
                      </button>
                    )}
                    {['draft', 'scheduled', 'running'].includes(campaign.status) && (
                      <button
                        onClick={() => handleCancel(campaign.id)}
                        className="px-3 py-1 text-sm text-red-600 border border-red-600 rounded hover:bg-red-50"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin/campaigns')({
  component: CampaignsPage,
});
