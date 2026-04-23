import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import type { ApiKey } from '../types';

const MOCK_KEYS: ApiKey[] = [
  { id: '1', name: 'Production API Key', key: 'sk-prod-...x7f2', created: '2025-01-01', lastUsed: '2 min ago' },
  { id: '2', name: 'CI/CD Integration', key: 'sk-cicd-...a3b9', created: '2025-02-15', lastUsed: '1 day ago' },
  { id: '3', name: 'Dashboard Key', key: 'sk-dash-...m1k4', created: '2025-03-10', lastUsed: '5 min ago' },
];

interface ApiKeysProps {
  token: string;
}

export function ApiKeys({ token: _token }: ApiKeysProps) {
  const [keys, setKeys] = useState<ApiKey[]>(MOCK_KEYS);
  const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const { showToast } = useToast();

  const confirmRevoke = () => {
    if (!revokeTarget) return;
    setKeys((prev) => prev.filter((k) => k.id !== revokeTarget.id));
    showToast(`Revoked: ${revokeTarget.name}`, 'success');
    setRevokeTarget(null);
  };

  const handleCreate = () => {
    if (!newKeyName.trim()) { showToast('Enter a key name', 'error'); return; }
    const generated = `sk-${Math.random().toString(36).slice(2, 14)}-${Math.random().toString(36).slice(2, 10)}`;
    setKeys((prev) => [...prev, { id: String(Date.now()), name: newKeyName, key: `sk-...${generated.slice(-4)}`, created: new Date().toISOString().slice(0, 10), lastUsed: 'Never' }]);
    setNewKey(generated);
    setShowCreate(false);
    setNewKeyName('');
  };

  const columns = [
    { key: 'name', label: 'Name', render: (row: ApiKey) => (
      <span className="font-medium text-gray-900 dark:text-white">{row.name}</span>
    )},
    { key: 'key', label: 'Key', render: (row: ApiKey) => (
      <span className="font-mono text-sm text-gray-600 dark:text-gray-400">{row.key}</span>
    )},
    { key: 'created', label: 'Created' },
    { key: 'lastUsed', label: 'Last Used' },
    { key: 'actions', label: 'Actions', sortable: false, render: (row: ApiKey) => (
      <button onClick={() => setRevokeTarget(row)} className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400">
        Revoke
      </button>
    )},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">API Keys</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage programmatic access credentials</p>
        </div>
        <button onClick={() => setShowCreate(true)} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
          + Create API Key
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <DataTable columns={columns} data={keys} searchKeys={['name']} emptyMessage="No API keys found." />
      </div>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="Revoke API Key"
        message={`Are you sure you want to revoke "${revokeTarget?.name}"? All applications using this key will lose access immediately.`}
        onConfirm={confirmRevoke}
        onCancel={() => setRevokeTarget(null)}
      />

      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Create API Key</h3>
            <input
              type="text"
              placeholder="Key name (e.g. Production API)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg">Cancel</button>
              <button onClick={handleCreate} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700">Create</button>
            </div>
          </div>
        </div>
      )}

      {newKey && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">Your New API Key</h3>
            <p className="text-sm text-yellow-600 dark:text-yellow-400 mb-4">⚠️ Copy this key now. It will not be shown again.</p>
            <div className="flex items-center gap-2 bg-gray-100 dark:bg-gray-700 rounded-lg p-3 mb-4">
              <code className="flex-1 text-sm font-mono text-gray-900 dark:text-white break-all">{newKey}</code>
              <button onClick={() => { void navigator.clipboard.writeText(newKey); showToast('Copied to clipboard!', 'success'); }} className="px-2 py-1 text-xs bg-blue-600 text-white rounded">Copy</button>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setNewKey(null)} className="px-4 py-2 text-sm font-medium text-white bg-gray-600 rounded-lg hover:bg-gray-700">Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
