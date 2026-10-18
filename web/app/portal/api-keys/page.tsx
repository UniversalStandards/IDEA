'use client';

import { useState } from 'react';

interface ApiKey {
  id: string;
  label: string;
  prefix: string;
  createdAt: string;
}

export default function PortalApiKeysPage(): React.JSX.Element {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newKeySecret, setNewKeySecret] = useState('');
  const [error, setError] = useState('');

  async function handleCreate(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setCreating(true);
    try {
      const res = await fetch('/api/user/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Could not create API key');
        return;
      }
      const result = (await res.json()) as ApiKey & { secret: string };
      setKeys((prev) => [...prev, { id: result.id, label: result.label, prefix: result.prefix, createdAt: result.createdAt }]);
      setNewKeySecret(result.secret);
      setLabel('');
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setCreating(false);
    }
  }

  return (
    <main>
      <h1>API Keys</h1>
      <section aria-label="Create API key">
        <h2>Create new API key</h2>
        <form onSubmit={handleCreate} aria-label="Create API key form">
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="label">Key label</label>
            <input
              id="label"
              name="label"
              type="text"
              required
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>
          <button type="submit" disabled={creating}>
            {creating ? 'Creating…' : 'Create API key'}
          </button>
        </form>
        {newKeySecret && (
          <div role="status" aria-label="New API key created">
            <p>
              Your new API key (shown once):&nbsp;
              <code data-testid="new-api-key-value">{newKeySecret}</code>
            </p>
          </div>
        )}
      </section>
      <section aria-label="Your API keys">
        <h2>Your API keys</h2>
        {keys.length === 0 ? (
          <p>You have no API keys yet.</p>
        ) : (
          <ul>
            {keys.map((key) => (
              <li key={key.id} data-key-id={key.id}>
                {key.label} — {key.prefix}… (created {new Date(key.createdAt).toLocaleDateString()})
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
