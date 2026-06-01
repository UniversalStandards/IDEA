'use client';

import { useState } from 'react';

export default function TwoFactorPage(): React.JSX.Element {
  const [totpCode, setTotpCode] = useState('');
  const [error, setError] = useState('');
  const [enrolled, setEnrolled] = useState(false);
  const [loading, setLoading] = useState(false);

  // Simulate loading the QR code / enrollment data
  const qrDataUrl = '/api/auth/2fa/qr';

  async function handleEnroll(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await fetch('/api/auth/2fa/enroll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ totpCode }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Invalid TOTP code');
        return;
      }
      setEnrolled(true);
    } catch {
      setError('An unexpected error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  if (enrolled) {
    return (
      <main>
        <h1>Two-factor authentication enabled</h1>
        <p>Your account is now protected with 2FA.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Set up two-factor authentication</h1>
      <p>Scan the QR code below with your authenticator app.</p>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={qrDataUrl} alt="2FA QR code" width={200} height={200} />
      <form onSubmit={handleEnroll} aria-label="2FA enrollment form">
        {error && <p role="alert">{error}</p>}
        <div>
          <label htmlFor="totpCode">Verification code</label>
          <input
            id="totpCode"
            name="totpCode"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value)}
          />
        </div>
        <button type="submit" disabled={loading}>
          {loading ? 'Verifying…' : 'Enable 2FA'}
        </button>
      </form>
    </main>
  );
}
