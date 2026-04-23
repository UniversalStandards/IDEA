import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import type { Capability } from '../types';

const MOCK_CAPABILITIES: Capability[] = [
  { id: '1', name: 'github-tools', version: '2.1.0', status: 'active', description: 'GitHub repository operations (PR, issues, commits)', source: 'github-registry' },
  { id: '2', name: 'web-search', version: '1.4.2', status: 'active', description: 'Web search via multiple search providers', source: 'official-registry' },
  { id: '3', name: 'code-interpreter', version: '3.0.1', status: 'active', description: 'Safe sandboxed Python/JS code execution', source: 'official-registry' },
  { id: '4', name: 'database-connector', version: '1.0.0', status: 'disabled', description: 'PostgreSQL/MySQL read-only query interface', source: 'enterprise-catalog' },
  { id: '5', name: 'slack-notifier', version: '0.9.5', status: 'error', description: 'Send messages and notifications to Slack', source: 'github-registry' },
];

interface CapabilitiesProps {
  token: string;
}

export function Capabilities({ token: _token }: CapabilitiesProps) {
  const [caps, setCaps] = useState<Capability[]>(MOCK_CAPABILITIES);
  const [deleteTarget, setDeleteTarget] = useState<Capability | null>(null);
  const [showInstall, setShowInstall] = useState(false);
  const [installSearch, setInstallSearch] = useState('');
  const { showToast } = useToast();

  const handleDelete = (cap: Capability) => setDeleteTarget(cap);
  const confirmDelete = () => {
    if (!deleteTarget) return;
    setCaps((prev) => prev.filter((c) => c.id !== deleteTarget.id));
    showToast(`Deleted capability: ${deleteTarget.name}`, 'success');
    setDeleteTarget(null);
  };

  const handleToggle = (id: string) => {
    setCaps((prev) => prev.map((c) =>
      c.id === id ? { ...c, status: c.status === 'active' ? 'disabled' : 'active' } : c
    ) as Capability[]);
    showToast('Capability status updated', 'success');
  };

  const columns = [
    { key: 'name', label: 'Name', render: (row: Capability) => (
      <div>
        <div className="font-medium text-gray-900 dark:text-white">{row.name}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{row.source}</div>
      </div>
    )},
    { key: 'version', label: 'Version', render: (row: Capability) => (
      <span className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">{row.version}</span>
    )},
    { key: 'status', label: 'Status', render: (row: Capability) => <StatusBadge status={row.status} /> },
    { key: 'description', label: 'Description' },
    { key: 'actions', label: 'Actions', sortable: false, render: (row: Capability) => (
      <div className="flex items-center gap-2">
        <button onClick={() => handleToggle(row.id)} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
          {row.status === 'active' ? 'Disable' : 'Enable'}
        </button>
        <button onClick={() => handleDelete(row)} className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400">
          Delete
        </button>
      </div>
    )},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Capabilities</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage installed MCP tools and capabilities</p>
        </div>
        <button onClick={() => setShowInstall(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2">
          <span>+</span> Install New
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <DataTable
          columns={columns}
          data={caps}
          searchKeys={['name', 'description']}
          emptyMessage="No capabilities installed."
        />
      </div>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Capability"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This action cannot be undone.`}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {showInstall && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 max-w-lg w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Install Capability</h3>
            <input
              type="text"
              placeholder="Search registry (e.g. github-tools, web-search)..."
              value={installSearch}
              onChange={(e) => setInstallSearch(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            />
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">Type a capability name to search the registry.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowInstall(false)} className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200">Cancel</button>
              <button
                onClick={() => {
                  if (installSearch) {
                    setCaps((prev) => [...prev, { id: String(Date.now()), name: installSearch, version: '1.0.0', status: 'active', description: 'Newly installed capability' }]);
                    showToast(`Installed: ${installSearch}`, 'success');
                    setShowInstall(false);
                    setInstallSearch('');
                  }
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700"
              >
                Install
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
