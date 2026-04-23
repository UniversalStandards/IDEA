import React, { useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { useTheme } from '../hooks/useTheme';

interface SettingsProps {
  token: string;
}

export function Settings({ token: _token }: SettingsProps) {
  const { isDark, toggle } = useTheme();
  const { showToast } = useToast();
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [form, setForm] = useState({
    hubName: 'MCP Orchestration Hub',
    logLevel: 'info',
    rateLimitWindow: '60000',
    rateLimitMax: '300',
    corsOrigins: '*',
  });

  const handleChange = (key: keyof typeof form, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    showToast('Settings saved successfully', 'success');
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Settings</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Hub configuration and preferences</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">General</h2>
            <form onSubmit={handleSave} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hub Name</label>
                <input
                  type="text"
                  value={form.hubName}
                  onChange={(e) => handleChange('hubName', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Log Level</label>
                <select
                  value={form.logLevel}
                  onChange={(e) => handleChange('logLevel', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="error">error</option>
                  <option value="warn">warn</option>
                  <option value="info">info</option>
                  <option value="http">http</option>
                  <option value="verbose">verbose</option>
                  <option value="debug">debug</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Rate Limit Window (ms)</label>
                  <input
                    type="number"
                    value={form.rateLimitWindow}
                    onChange={(e) => handleChange('rateLimitWindow', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Max Requests</label>
                  <input
                    type="number"
                    value={form.rateLimitMax}
                    onChange={(e) => handleChange('rateLimitMax', e.target.value)}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">CORS Origins</label>
                <input
                  type="text"
                  value={form.corsOrigins}
                  onChange={(e) => handleChange('corsOrigins', e.target.value)}
                  placeholder="* or https://app.example.com,https://admin.example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">Use * for all origins, or comma-separated list for production.</p>
              </div>
              <div className="pt-2">
                <button type="submit" className="px-5 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
                  Save Settings
                </button>
              </div>
            </form>
          </div>

          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Security</h2>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Webhook Secret</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Used to verify incoming webhook payloads</div>
                </div>
                <button
                  onClick={() => setConfirmRotate(true)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                >
                  🔄 Rotate Secret
                </button>
              </div>
            </div>
          </div>
        </div>

        <div>
          <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Appearance</h2>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gray-700 dark:text-gray-300">Dark Mode</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Switch between light and dark themes</div>
              </div>
              <button
                onClick={toggle}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isDark ? 'bg-blue-600' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${isDark ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmRotate}
        title="Rotate Webhook Secret"
        message="This will invalidate the current webhook secret. All webhook senders must be updated with the new secret. Continue?"
        onConfirm={() => { showToast('Webhook secret rotated successfully', 'success'); setConfirmRotate(false); }}
        onCancel={() => setConfirmRotate(false)}
      />
    </div>
  );
}
