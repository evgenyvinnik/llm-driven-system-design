import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useAdminStore } from '../../stores/adminStore';
import type { Template } from '../../types';

function TemplatesPage() {
  const { templates, isLoading, fetchTemplates, createTemplate, deleteTemplate } = useAdminStore();
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    id: '',
    name: '',
    description: '',
    emailSubject: '',
    emailBody: '',
    pushTitle: '',
    pushBody: '',
    smsBody: '',
    variables: '',
  });

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    const channels: Record<string, Record<string, string>> = {};

    if (formData.emailSubject || formData.emailBody) {
      channels.email = {
        subject: formData.emailSubject,
        body: formData.emailBody,
      };
    }

    if (formData.pushTitle || formData.pushBody) {
      channels.push = {
        title: formData.pushTitle,
        body: formData.pushBody,
      };
    }

    if (formData.smsBody) {
      channels.sms = {
        body: formData.smsBody,
      };
    }

    try {
      await createTemplate({
        id: formData.id,
        name: formData.name,
        description: formData.description || undefined,
        channels,
        variables: formData.variables
          ? formData.variables.split(',').map((v) => v.trim())
          : undefined,
      });
      setShowForm(false);
      setFormData({
        id: '',
        name: '',
        description: '',
        emailSubject: '',
        emailBody: '',
        pushTitle: '',
        pushBody: '',
        smsBody: '',
        variables: '',
      });
    } catch {
      // Error handled by store
    }
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this template?')) {
      await deleteTemplate(id);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Templates</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="px-4 py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700"
        >
          {showForm ? 'Cancel' : 'Create Template'}
        </button>
      </div>

      {/* Create Form */}
      {showForm && (
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-md font-semibold mb-4">New Template</h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Template ID</label>
                <input
                  type="text"
                  value={formData.id}
                  onChange={(e) => setFormData((prev) => ({ ...prev, id: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  placeholder="my-template-id"
                  pattern="[a-z0-9_-]+"
                  required
                />
                <p className="text-xs text-gray-500 mt-1">lowercase letters, numbers, hyphens, underscores</p>
              </div>
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
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                type="text"
                value={formData.description}
                onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Variables (comma-separated)
              </label>
              <input
                type="text"
                value={formData.variables}
                onChange={(e) => setFormData((prev) => ({ ...prev, variables: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                placeholder="name, orderId, status"
              />
              <p className="text-xs text-gray-500 mt-1">Use {'{{variableName}}'} in templates</p>
            </div>

            <div className="border rounded-lg p-4">
              <h4 className="font-medium text-gray-700 mb-3">Email Template</h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Subject</label>
                  <input
                    type="text"
                    value={formData.emailSubject}
                    onChange={(e) => setFormData((prev) => ({ ...prev, emailSubject: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Body</label>
                  <textarea
                    value={formData.emailBody}
                    onChange={(e) => setFormData((prev) => ({ ...prev, emailBody: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                    rows={3}
                  />
                </div>
              </div>
            </div>

            <div className="border rounded-lg p-4">
              <h4 className="font-medium text-gray-700 mb-3">Push Notification Template</h4>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Title</label>
                  <input
                    type="text"
                    value={formData.pushTitle}
                    onChange={(e) => setFormData((prev) => ({ ...prev, pushTitle: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 mb-1">Body</label>
                  <input
                    type="text"
                    value={formData.pushBody}
                    onChange={(e) => setFormData((prev) => ({ ...prev, pushBody: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  />
                </div>
              </div>
            </div>

            <div className="border rounded-lg p-4">
              <h4 className="font-medium text-gray-700 mb-3">SMS Template</h4>
              <div>
                <label className="block text-sm text-gray-600 mb-1">Message</label>
                <input
                  type="text"
                  value={formData.smsBody}
                  onChange={(e) => setFormData((prev) => ({ ...prev, smsBody: e.target.value }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  maxLength={160}
                />
                <p className="text-xs text-gray-500 mt-1">{formData.smsBody.length}/160 characters</p>
              </div>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2 bg-indigo-600 text-white font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {isLoading ? 'Creating...' : 'Create Template'}
            </button>
          </form>
        </div>
      )}

      {/* Templates List */}
      <div className="bg-white rounded-lg shadow">
        {isLoading && templates.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">Loading...</div>
        ) : templates.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-500">No templates found</div>
        ) : (
          <div className="divide-y divide-gray-200">
            {templates.map((template: Template) => (
              <div key={template.id} className="px-6 py-4">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center space-x-2">
                      <span className="font-medium text-gray-900">{template.name}</span>
                      <span className="text-xs text-gray-400 font-mono">{template.id}</span>
                    </div>
                    {template.description && (
                      <div className="mt-1 text-sm text-gray-500">{template.description}</div>
                    )}
                    <div className="mt-2 flex space-x-2">
                      {Object.keys(template.channels).map((channel) => (
                        <span
                          key={channel}
                          className="px-2 py-1 text-xs bg-gray-100 text-gray-600 rounded capitalize"
                        >
                          {channel}
                        </span>
                      ))}
                    </div>
                    {template.variables && template.variables.length > 0 && (
                      <div className="mt-2 text-xs text-gray-400">
                        Variables: {template.variables.join(', ')}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="px-3 py-1 text-sm text-red-600 border border-red-600 rounded hover:bg-red-50"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute('/admin/templates')({
  component: TemplatesPage,
});
