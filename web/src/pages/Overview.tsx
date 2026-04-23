import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import type { AuditEntry, HealthStatus } from '../types';

const MOCK_AUDIT: AuditEntry[] = [
  { id: '1', timestamp: new Date(Date.now() - 60000).toISOString(), actor: 'admin@example.com', action: 'capability.install', resource: 'github-tools@1.2.0', status: 'success', details: 'Installed successfully' },
  { id: '2', timestamp: new Date(Date.now() - 300000).toISOString(), actor: 'system', action: 'policy.evaluate', resource: 'request-123', status: 'success', details: 'Request allowed' },
  { id: '3', timestamp: new Date(Date.now() - 900000).toISOString(), actor: 'operator@example.com', action: 'workflow.create', resource: 'data-pipeline', status: 'success', details: 'Created with 5 steps' },
  { id: '4', timestamp: new Date(Date.now() - 3600000).toISOString(), actor: 'system', action: 'provider.health', resource: 'openai', status: 'warning', details: 'Latency elevated' },
  { id: '5', timestamp: new Date(Date.now() - 7200000).toISOString(), actor: 'admin@example.com', action: 'user.invite', resource: 'new@example.com', status: 'success', details: 'Invitation sent' },
];

interface OverviewProps {
  token: string;
}

function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon: string; color: string }) {
  return (
    <div className={`bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700 flex items-center gap-4`}>
      <div className={`text-3xl p-3 rounded-xl ${color}`}>{icon}</div>
      <div>
        <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
        <div className="text-sm text-gray-500 dark:text-gray-400">{label}</div>
      </div>
    </div>
  );
}

export function Overview({ token: _token }: OverviewProps) {
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    api.getHealth()
      .then((h) => setHealth(h as HealthStatus))
      .catch(() => setHealth({ status: 'error' }));
  }, []);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Overview</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">System health and activity at a glance</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        <StatCard label="Active Capabilities" value={12} icon="🔧" color="bg-blue-50 dark:bg-blue-900/20" />
        <StatCard label="Running Workflows" value={4} icon="⚙️" color="bg-green-50 dark:bg-green-900/20" />
        <StatCard label="Policy Rules" value={8} icon="📋" color="bg-purple-50 dark:bg-purple-900/20" />
        <StatCard label="Cost Today" value="$2.47" icon="💰" color="bg-yellow-50 dark:bg-yellow-900/20" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Recent Activity</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 dark:text-gray-400 uppercase">
                <th className="text-left pb-3">Time</th>
                <th className="text-left pb-3">Actor</th>
                <th className="text-left pb-3">Action</th>
                <th className="text-left pb-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {MOCK_AUDIT.map((entry) => (
                <tr key={entry.id}>
                  <td className="py-2.5 text-gray-500 dark:text-gray-400 text-xs">{new Date(entry.timestamp).toLocaleTimeString()}</td>
                  <td className="py-2.5 text-gray-800 dark:text-gray-200 truncate max-w-[120px]">{entry.actor}</td>
                  <td className="py-2.5 text-gray-700 dark:text-gray-300 font-mono text-xs">{entry.action}</td>
                  <td className="py-2.5"><StatusBadge status={entry.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Health Status</h2>
          {health ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${health.status === 'ok' ? 'bg-green-500' : health.status === 'degraded' ? 'bg-yellow-500' : 'bg-red-500'}`} />
                <span className="text-sm font-medium text-gray-900 dark:text-white capitalize">{health.status}</span>
              </div>
              {health.version && <p className="text-xs text-gray-500 dark:text-gray-400">Version: {health.version}</p>}
              {health.environment && <p className="text-xs text-gray-500 dark:text-gray-400">Env: {health.environment}</p>}
              {health.nodeVersion && <p className="text-xs text-gray-500 dark:text-gray-400">Node: {health.nodeVersion}</p>}
            </div>
          ) : (
            <div className="text-sm text-gray-400">Checking health...</div>
          )}

          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Quick Actions</h3>
            <div className="flex flex-col gap-2">
              <Link to="/capabilities" className="flex items-center gap-2 px-3 py-2 text-sm text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 rounded-lg hover:bg-blue-100 dark:hover:bg-blue-900/40 transition-colors">
                <span>🔧</span> Install Capability
              </Link>
              <Link to="/workflows" className="flex items-center gap-2 px-3 py-2 text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg hover:bg-green-100 dark:hover:bg-green-900/40 transition-colors">
                <span>⚙️</span> Create Workflow
              </Link>
              <Link to="/providers" className="flex items-center gap-2 px-3 py-2 text-sm text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 rounded-lg hover:bg-purple-100 dark:hover:bg-purple-900/40 transition-colors">
                <span>🤖</span> Add Provider
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
