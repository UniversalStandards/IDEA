'use client';

import { useState } from 'react';
import Link from 'next/link';

export default function ForgotPasswordPage(): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Could not send reset email');
        return;
      }
      setSubmitted(true);
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (submitted) {
    return (
      <main>
        <h1>Check your email</h1>
        <p>
          If an account with that address exists, we sent a password-reset link. Check your inbox
          and follow the instructions.
        </p>
        <p>
          <Link href="/auth/login">Back to sign in</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>Reset your password</h1>
      <form onSubmit={handleSubmit} aria-label="Password reset form">
        {error && <p role="alert">{error}</p>}
        <div>
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? 'Sending…' : 'Send reset link'}
        </button>
      </form>
      <p>
        <Link href="/auth/login">Back to sign in</Link>
      </p>
    </main>
  );
}
