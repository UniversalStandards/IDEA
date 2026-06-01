'use client';

import { useState } from 'react';

interface WorkflowStep {
  id: string;
  name: string;
  action: string;
}

interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
}

export default function AdminWorkflowsPage(): React.JSX.Element {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [workflowName, setWorkflowName] = useState('');
  const [step1Name, setStep1Name] = useState('');
  const [step1Action, setStep1Action] = useState('');
  const [step2Name, setStep2Name] = useState('');
  const [step2Action, setStep2Action] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleCreate(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setSaving(true);
    const steps: Omit<WorkflowStep, 'id'>[] = [
      { name: step1Name, action: step1Action },
      { name: step2Name, action: step2Action },
    ];
    try {
      const res = await fetch('/api/admin/workflows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: workflowName, steps }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Could not create workflow');
        return;
      }
      const created = (await res.json()) as Workflow;
      setWorkflows((prev) => [...prev, created]);
      setWorkflowName('');
      setStep1Name('');
      setStep1Action('');
      setStep2Name('');
      setStep2Action('');
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main>
      <h1>Workflows</h1>
      <section aria-label="Create a workflow">
        <h2>Create new workflow</h2>
        <form onSubmit={handleCreate} aria-label="Create workflow form">
          {error && <p role="alert">{error}</p>}
          <div>
            <label htmlFor="workflowName">Workflow name</label>
            <input
              id="workflowName"
              name="workflowName"
              type="text"
              required
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
            />
          </div>
          <fieldset>
            <legend>Step 1</legend>
            <div>
              <label htmlFor="step1Name">Step name</label>
              <input
                id="step1Name"
                name="step1Name"
                type="text"
                required
                value={step1Name}
                onChange={(e) => setStep1Name(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="step1Action">Action</label>
              <input
                id="step1Action"
                name="step1Action"
                type="text"
                required
                value={step1Action}
                onChange={(e) => setStep1Action(e.target.value)}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend>Step 2</legend>
            <div>
              <label htmlFor="step2Name">Step name</label>
              <input
                id="step2Name"
                name="step2Name"
                type="text"
                required
                value={step2Name}
                onChange={(e) => setStep2Name(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="step2Action">Action</label>
              <input
                id="step2Action"
                name="step2Action"
                type="text"
                required
                value={step2Action}
                onChange={(e) => setStep2Action(e.target.value)}
              />
            </div>
          </fieldset>
          <button type="submit" disabled={saving}>
            {saving ? 'Creating…' : 'Create workflow'}
          </button>
        </form>
      </section>
      <section aria-label="Workflows list">
        <h2>Existing workflows</h2>
        {workflows.length === 0 ? (
          <p>No workflows created yet.</p>
        ) : (
          <ul>
            {workflows.map((wf) => (
              <li key={wf.id} data-workflow-id={wf.id}>
                {wf.name} ({wf.steps.length} steps)
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
