'use client';

import { useState } from 'react';

interface Tool {
  id: string;
  name: string;
  version: string;
  status: 'installed' | 'installing' | 'error';
}

export default function AdminToolsPage(): React.JSX.Element {
  const [tools, setTools] = useState<Tool[]>([]);
  const [toolName, setToolName] = useState('');
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState('');

  async function handleInstall(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setInstalling(true);
    try {
      const res = await fetch('/api/admin/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: toolName }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Installation failed');
        return;
      }
      const newTool = (await res.json()) as Tool;
      setTools((prev) => [...prev, newTool]);
      setToolName('');
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setInstalling(false);
    }
  }

  return (
    <main>
      <h1>Tools</h1>
      <section aria-label="Install a new tool">
        <h2>Install new tool</h2>
        <form onSubmit={handleInstall} aria-label="Install tool form">
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="toolName">Tool name</label>
            <input
              id="toolName"
              name="toolName"
              type="text"
              required
              value={toolName}
              onChange={(e) => setToolName(e.target.value)}
            />
          </div>
          <button type="submit" disabled={installing}>
            {installing ? 'Installing…' : 'Install tool'}
          </button>
        </form>
      </section>
      <section aria-label="Installed tools">
        <h2>Installed tools</h2>
        {tools.length === 0 ? (
          <p>No tools installed yet.</p>
        ) : (
          <ul>
            {tools.map((tool) => (
              <li key={tool.id} data-tool-id={tool.id}>
                {tool.name} v{tool.version} — {tool.status}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
