import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import type { Policy } from '../types';

const MOCK_POLICIES: Policy[] = [
  { id: '1', name: 'allow-internal-tools', type: 'capability', action: 'allow', priority: 1, active: true },
  { id: '2', name: 'deny-external-write', type: 'data-access', action: 'deny', priority: 2, active: true },
  { id: '3', name: 'allow-read-only', type: 'data-access', action: 'allow', priority: 3, active: true },
  { id: '4', name: 'block-pii-exfiltration', type: 'security', action: 'deny', priority: 1, active: true },
  { id: '5', name: 'allow-testing-tools', type: 'capability', action: 'allow', priority: 10, active: false },
];

interface PoliciesProps {
  token: string;
}

export function Policies({ token: _token }: PoliciesProps) {
  const [policies, setPolicies] = useState<Policy[]>(MOCK_POLICIES);
  const [showTest, setShowTest] = useState(false);
  const [testInput, setTestInput] = useState('{\n  "action": "read",\n  "resource": "database",\n  "actor": "user@example.com"\n}');
  const { showToast } = useToast();

  const handleToggle = (id: string) => {
    setPolicies((prev) => prev.map((p) => p.id === id ? { ...p, active: !p.active } : p));
    showToast('Policy status updated', 'success');
  };

  const columns = [
    { key: 'name', label: 'Name', render: (row: Policy) => (
      <span className="font-medium font-mono text-sm text-gray-900 dark:text-white">{row.name}</span>
    )},
    { key: 'type', label: 'Type', render: (row: Policy) => (
      <span className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded text-gray-700 dark:text-gray-300">{row.type}</span>
    )},
    { key: 'action', label: 'Action', render: (row: Policy) => (
      <StatusBadge status={row.action === 'allow' ? 'active' : 'error'} label={row.action} />
    )},
    { key: 'priority', label: 'Priority' },
    { key: 'active', label: 'Active', render: (row: Policy) => (
      <button
        onClick={() => handleToggle(row.id)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${row.active ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'}`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${row.active ? 'translate-x-4' : 'translate-x-1'}`} />
      </button>
    )},
    { key: 'actions', label: 'Actions', sortable: false, render: (row: Policy) => (
      <button onClick={() => showToast(`Editing: ${row.name}`, 'info')} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
        Edit
      </button>
    )},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Policies</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage access control and security policies</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => showToast('Hot-reloading policies...', 'info')} className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            🔄 Hot Reload
          </button>
          <button onClick={() => setShowTest(true)} className="px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors">
            🧪 Test Policy
          </button>
          <button onClick={() => showToast('Add policy: coming soon', 'info')} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
            + Add Policy
          </button>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <DataTable columns={columns} data={policies} searchKeys={['name', 'type']} emptyMessage="No policies configured." />
      </div>

      {showTest && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 max-w-lg w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Test Policy</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Enter a request context as JSON:</p>
            <textarea
              value={testInput}
              onChange={(e) => setTestInput(e.target.value)}
              rows={8}
              className="w-full px-3 py-2 text-sm font-mono border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowTest(false)} className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg">Cancel</button>
              <button onClick={() => { showToast('Policy evaluation: ALLOW (mock)', 'success'); setShowTest(false); }} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">
                Evaluate
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
