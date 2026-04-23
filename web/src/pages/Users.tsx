import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { StatusBadge } from '../components/StatusBadge';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import type { User } from '../types';

const MOCK_USERS: User[] = [
  { id: '1', name: 'Alice Admin', email: 'alice@example.com', role: 'admin', lastLogin: '5 min ago', status: 'active' },
  { id: '2', name: 'Bob Operator', email: 'bob@example.com', role: 'operator', lastLogin: '1 hour ago', status: 'active' },
  { id: '3', name: 'Carol Viewer', email: 'carol@example.com', role: 'viewer', lastLogin: '2 days ago', status: 'active' },
  { id: '4', name: 'Dave Dev', email: 'dave@example.com', role: 'operator', lastLogin: '1 week ago', status: 'suspended' },
  { id: '5', name: 'Eve External', email: 'eve@partner.com', role: 'viewer', lastLogin: 'Never', status: 'active' },
];

interface UsersProps {
  token: string;
}

export function Users({ token: _token }: UsersProps) {
  const [users, setUsers] = useState<User[]>(MOCK_USERS);
  const [suspendTarget, setSuspendTarget] = useState<User | null>(null);
  const { showToast } = useToast();

  const handleSuspend = (user: User) => setSuspendTarget(user);
  const confirmSuspend = () => {
    if (!suspendTarget) return;
    setUsers((prev) => prev.map((u) =>
      u.id === suspendTarget.id ? { ...u, status: u.status === 'active' ? 'suspended' : 'active' } : u
    ) as User[]);
    showToast(`User ${suspendTarget.status === 'active' ? 'suspended' : 'reactivated'}: ${suspendTarget.name}`, 'success');
    setSuspendTarget(null);
  };

  const columns = [
    { key: 'name', label: 'Name', render: (row: User) => (
      <div>
        <div className="font-medium text-gray-900 dark:text-white">{row.name}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{row.email}</div>
      </div>
    )},
    { key: 'role', label: 'Role', render: (row: User) => <StatusBadge status={row.role} label={row.role} /> },
    { key: 'lastLogin', label: 'Last Login' },
    { key: 'status', label: 'Status', render: (row: User) => <StatusBadge status={row.status} /> },
    { key: 'actions', label: 'Actions', sortable: false, render: (row: User) => (
      <div className="flex items-center gap-2">
        <button onClick={() => showToast(`Editing: ${row.name}`, 'info')} className="text-xs px-2 py-1 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300">
          Edit
        </button>
        <button onClick={() => handleSuspend(row)} className={`text-xs px-2 py-1 rounded border ${row.status === 'active' ? 'border-red-300 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400' : 'border-green-300 hover:bg-green-50 text-green-600'}`}>
          {row.status === 'active' ? 'Suspend' : 'Reactivate'}
        </button>
      </div>
    )},
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Users</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Manage user accounts and role assignments</p>
        </div>
        <button onClick={() => showToast('Invite user: coming soon', 'info')} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
          + Invite User
        </button>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <DataTable columns={columns} data={users} searchKeys={['name', 'email']} emptyMessage="No users found." />
      </div>

      <ConfirmDialog
        open={suspendTarget !== null}
        title={suspendTarget?.status === 'active' ? 'Suspend User' : 'Reactivate User'}
        message={`Are you sure you want to ${suspendTarget?.status === 'active' ? 'suspend' : 'reactivate'} "${suspendTarget?.name}"?`}
        onConfirm={confirmSuspend}
        onCancel={() => setSuspendTarget(null)}
      />
    </div>
  );
}
