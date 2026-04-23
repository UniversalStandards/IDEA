import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import type { AuditEntry } from '../types';

const MOCK_AUDIT: AuditEntry[] = [
  { id: '1', timestamp: new Date(Date.now() - 60000).toISOString(), actor: 'admin@example.com', action: 'capability.install', resource: 'github-tools@2.1.0', status: 'success', details: 'Installed from github-registry' },
  { id: '2', timestamp: new Date(Date.now() - 300000).toISOString(), actor: 'system', action: 'policy.evaluate', resource: 'req-abc123', status: 'success', details: 'Rule: allow-internal-tools matched' },
  { id: '3', timestamp: new Date(Date.now() - 900000).toISOString(), actor: 'bob@example.com', action: 'workflow.create', resource: 'data-pipeline', status: 'success', details: 'Created workflow with 7 steps' },
  { id: '4', timestamp: new Date(Date.now() - 3600000).toISOString(), actor: 'system', action: 'provider.health_check', resource: 'google-gemini', status: 'warning', details: 'Latency: 4200ms (threshold: 2000ms)' },
  { id: '5', timestamp: new Date(Date.now() - 7200000).toISOString(), actor: 'alice@example.com', action: 'user.invite', resource: 'carol@example.com', status: 'success', details: 'Role: viewer' },
  { id: '6', timestamp: new Date(Date.now() - 10800000).toISOString(), actor: 'system', action: 'security.threat_detected', resource: 'req-xyz789', status: 'failure', details: 'PII pattern detected in output; request blocked' },
  { id: '7', timestamp: new Date(Date.now() - 14400000).toISOString(), actor: 'dave@example.com', action: 'auth.login', resource: 'dashboard', status: 'failure', details: 'Invalid token' },
  { id: '8', timestamp: new Date(Date.now() - 18000000).toISOString(), actor: 'alice@example.com', action: 'apikey.create', resource: 'CI/CD Integration', status: 'success', details: 'New key created' },
  { id: '9', timestamp: new Date(Date.now() - 21600000).toISOString(), actor: 'system', action: 'workflow.execute', resource: 'daily-report', status: 'success', details: 'Completed in 2m 10s' },
  { id: '10', timestamp: new Date(Date.now() - 86400000).toISOString(), actor: 'alice@example.com', action: 'settings.update', resource: 'rate-limit', status: 'success', details: 'max_requests: 100 → 300' },
];

interface AuditProps {
  token: string;
}

export function Audit({ token: _token }: AuditProps) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const { showToast } = useToast();

  const filtered = MOCK_AUDIT.filter((e) => {
    if (statusFilter && e.status !== statusFilter) return false;
    if (dateFrom && new Date(e.timestamp) < new Date(dateFrom)) return false;
    if (dateTo && new Date(e.timestamp) > new Date(dateTo + 'T23:59:59')) return false;
    return true;
  });

  const exportCSV = () => {
    const header = 'Timestamp,Actor,Action,Resource,Status,Details\n';
    const rows = filtered.map((e) =>
      `"${e.timestamp}","${e.actor}","${e.action}","${e.resource}","${e.status}","${e.details}"`
    ).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'audit-log.csv';
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exported', 'success');
  };

  const columns = [
    { key: 'timestamp', label: 'Time', render: (row: AuditEntry) => (
      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{new Date(row.timestamp).toLocaleString()}</span>
    )},
    { key: 'actor', label: 'Actor', render: (row: AuditEntry) => (
      <span className="text-sm text-gray-800 dark:text-gray-200 truncate max-w-[140px] block">{row.actor}</span>
    )},
    { key: 'action', label: 'Action', render: (row: AuditEntry) => (
      <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-700 dark:text-gray-300">{row.action}</span>
    )},
    { key: 'resource', label: 'Resource', render: (row: AuditEntry) => (
      <span className="text-sm text-gray-700 dark:text-gray-300 truncate max-w-[140px] block">{row.resource}</span>
    )},
    { key: 'status', label: 'Status', render: (row: AuditEntry) => <StatusBadge status={row.status} /> },
    { key: 'details', label: 'Details', render: (row: AuditEntry) => (
      <span className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[200px] block">{row.details}</span>
    )},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Tamper-evident record of all system events</p>
        </div>
        <button onClick={exportCSV} className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors">
          📥 Export CSV
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-4">
        <div className="flex flex-wrap gap-4 mb-4">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">From:</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600 dark:text-gray-400 whitespace-nowrap">To:</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
            <option value="">All Statuses</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="warning">Warning</option>
          </select>
          {(dateFrom || dateTo || statusFilter) && (
            <button onClick={() => { setDateFrom(''); setDateTo(''); setStatusFilter(''); }} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
              Clear filters
            </button>
          )}
        </div>

        <DataTable
          columns={columns}
          data={filtered}
          searchKeys={['actor', 'action', 'resource', 'details']}
          emptyMessage="No audit entries match the current filters."
        />
      </div>
    </div>
  );
}
