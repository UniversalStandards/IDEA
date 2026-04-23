'use client';

import { useState } from 'react';

export default function PortalSettingsPage(): React.JSX.Element {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('user@example.com');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setSaved(false);
    setSaving(true);
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Could not save settings');
        return;
      }
      setSaved(true);
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <h1>Profile Settings</h1>
      <form onSubmit={handleSubmit} aria-label="Profile settings form">
        {error && <p role="alert">{error}</p>}
        {saved && <p role="status">Settings saved successfully.</p>}
        <div>
          <label htmlFor="name">Display name</label>
          <input
            id="name"
            name="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </main>
  );
}
