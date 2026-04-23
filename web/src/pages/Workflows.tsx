import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { useToast } from '../components/Toast';
import type { Workflow } from '../types';

const MOCK_WORKFLOWS: Workflow[] = [
  { id: '1', name: 'Data Pipeline ETL', status: 'active', steps: 7, lastRun: '2 min ago', duration: '45s' },
  { id: '2', name: 'Daily Report Generator', status: 'active', steps: 4, lastRun: '1 hour ago', duration: '2m 10s' },
  { id: '3', name: 'Code Review Automation', status: 'paused', steps: 5, lastRun: '3 hours ago', duration: '1m 30s' },
  { id: '4', name: 'Alert Triage Bot', status: 'failed', steps: 3, lastRun: '30 min ago', duration: '12s' },
  { id: '5', name: 'Customer Onboarding', status: 'active', steps: 9, lastRun: '5 min ago', duration: '3m 22s' },
];

const MOCK_DLQ = [
  { id: 'dlq-1', workflow: 'Alert Triage Bot', step: 'send-notification', failedAt: '30 min ago', error: 'Slack API rate limit exceeded' },
  { id: 'dlq-2', workflow: 'Data Pipeline ETL', step: 'validate-schema', failedAt: '2 days ago', error: 'Schema validation failed: missing required field' },
];

interface WorkflowsProps {
  token: string;
}

export function Workflows({ token: _token }: WorkflowsProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>(MOCK_WORKFLOWS);
  const { showToast } = useToast();

  const handleToggle = (id: string) => {
    setWorkflows((prev) => prev.map((w) =>
      w.id === id ? { ...w, status: w.status === 'active' ? 'paused' : 'active' } : w
    ) as Workflow[]);
    showToast('Workflow status updated', 'success');
  };

  const columns = [
    { key: 'name', label: 'Name', render: (row: Workflow) => (
      <span className="font-medium text-gray-900 dark:text-white">{row.name}</span>
    )},
    { key: 'status', label: 'Status', render: (row: Workflow) => <StatusBadge status={row.status} /> },
    { key: 'steps', label: 'Steps', render: (row: Workflow) => (
      <span className="text-gray-700 dark:text-gray-300">{row.steps} steps</span>
    )},
    { key: 'lastRun', label: 'Last Run' },
    { key: 'duration', label: 'Duration' },
    { key: 'actions', label: 'Actions', sortable: false, render: (row: Workflow) => (
      <div className="flex items-center gap-2">
        <button onClick={() => handleToggle(row.id)} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
          {row.status === 'active' ? 'Pause' : 'Resume'}
        </button>
        <button onClick={() => showToast(`Running: ${row.name}`, 'info')} className="text-xs px-2 py-1 rounded border border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-blue-600 dark:text-blue-400">
          Run Now
        </button>
      </div>
    )},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Workflows</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage automated workflow pipelines</p>
        </div>
        <button onClick={() => showToast('Create workflow: coming soon', 'info')} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2">
          <span>+</span> Create Workflow
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-6">
        <DataTable columns={columns} data={workflows} searchKeys={['name']} emptyMessage="No workflows configured." />
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Dead Letter Queue</h2>
        {MOCK_DLQ.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">No failed steps in DLQ.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {MOCK_DLQ.map((item) => (
              <div key={item.id} className="flex items-start gap-4 p-4 bg-red-50 dark:bg-red-900/10 border border-red-200 dark:border-red-800 rounded-lg">
                <span className="text-red-500 text-lg">⚠️</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-white">{item.workflow} → {item.step}</div>
                  <div className="text-xs text-red-600 dark:text-red-400 mt-0.5">{item.error}</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">Failed {item.failedAt}</div>
                </div>
                <button onClick={() => showToast(`Retrying: ${item.step}`, 'info')} className="text-xs px-2 py-1 rounded border border-red-300 hover:bg-red-100 text-red-600">
                  Retry
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
