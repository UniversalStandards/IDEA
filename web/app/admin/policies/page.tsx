'use client';

import { useState } from 'react';

interface PolicyRule {
  id: string;
  name: string;
  effect: 'allow' | 'deny';
  action: string;
  resource: string;
}

export default function AdminPoliciesPage(): React.JSX.Element {
  const [policies, setPolicies] = useState<PolicyRule[]>([
    {
      id: 'default-1',
      name: 'Allow admin reads',
      effect: 'allow',
      action: 'read',
      resource: '*',
    },
  ]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editEffect, setEditEffect] = useState<'allow' | 'deny'>('allow');
  const [editName, setEditName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function startEdit(policy: PolicyRule): void {
    setEditingId(policy.id);
    setEditEffect(policy.effect);
    setEditName(policy.name);
    setError('');
  }

  async function handleUpdate(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (!editingId) return;
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/policies/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, effect: editEffect }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Could not update policy');
        return;
      }
      setPolicies((prev) =>
        prev.map((p) =>
          p.id === editingId ? { ...p, name: editName, effect: editEffect } : p,
        ),
      );
      setEditingId(null);
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <h1>Policies</h1>
      {error && <p role="alert">{error}</p>}
      <ul aria-label="Policy list">
        {policies.map((policy) => (
          <li key={policy.id} data-policy-id={policy.id}>
            {editingId === policy.id ? (
              <form onSubmit={handleUpdate} aria-label="Edit policy form">
                <div>
                  <label htmlFor="editName">Policy name</label>
                  <input
                    id="editName"
                    name="editName"
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                  />
                </div>
                <div>
                  <label htmlFor="editEffect">Effect</label>
                  <select
                    id="editEffect"
                    name="editEffect"
                    value={editEffect}
                    onChange={(e) => setEditEffect(e.target.value as 'allow' | 'deny')}
                  >
                    <option value="allow">Allow</option>
                    <option value="deny">Deny</option>
                  </select>
                </div>
                <button type="submit" disabled={saving}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
                <button type="button" onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span>
                  {policy.name} — {policy.effect} {policy.action} on {policy.resource}
                </span>
                <button type="button" onClick={() => startEdit(policy)}>
                  Edit
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
