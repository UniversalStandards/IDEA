'use client';

import { useState } from 'react';

interface ApiKey {
  id: string;
  userId: string;
  label: string;
  createdAt: string;
  revoked: boolean;
}

const MOCK_KEYS: ApiKey[] = [
  {
    id: 'key-1',
    userId: 'user-42',
    label: 'Production key',
    createdAt: '2025-01-01T00:00:00Z',
    revoked: false,
  },
  {
    id: 'key-2',
    userId: 'user-42',
    label: 'Dev key',
    createdAt: '2025-02-01T00:00:00Z',
    revoked: false,
  },
];

export default function AdminUsersPage(): React.JSX.Element {
  const [keys, setKeys] = useState<ApiKey[]>(MOCK_KEYS);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function handleRevoke(keyId: string): Promise<void> {
    setError('');
    setRevoking(keyId);
    try {
      const res = await fetch(`/api/admin/api-keys/${keyId}/revoke`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Could not revoke API key');
        return;
      }
      setKeys((prev) =>
        prev.map((k) => (k.id === keyId ? { ...k, revoked: true } : k)),
      );
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setRevoking(null);
    }
  }

  return (
    <main>
      <h1>Users &amp; API Keys</h1>
      {error && <p role="alert">{error}</p>}
      <table aria-label="API keys table">
        <thead>
          <tr>
            <th scope="col">Label</th>
            <th scope="col">User ID</th>
            <th scope="col">Created</th>
            <th scope="col">Status</th>
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} data-key-id={key.id}>
              <td>{key.label}</td>
              <td>{key.userId}</td>
              <td>{new Date(key.createdAt).toLocaleDateString()}</td>
              <td>{key.revoked ? 'Revoked' : 'Active'}</td>
              <td>
                {!key.revoked && (
                  <button
                    type="button"
                    onClick={() => handleRevoke(key.id)}
                    disabled={revoking === key.id}
                    aria-label={`Revoke ${key.label}`}
                  >
                    {revoking === key.id ? 'Revoking…' : 'Revoke'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
