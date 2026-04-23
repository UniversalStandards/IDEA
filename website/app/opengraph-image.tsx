import { ImageResponse } from 'next/og';

export const alt = 'Universal MCP Orchestration Hub';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #1e1b4b 100%)',
          fontFamily: 'sans-serif',
          padding: '60px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
          <div
            style={{
              width: '64px',
              height: '64px',
              borderRadius: '16px',
              background: '#6366f1',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '32px',
            }}
          >
            ⚡
          </div>
          <span style={{ color: '#a5b4fc', fontSize: '28px', fontWeight: 600 }}>MCP Hub</span>
        </div>
        <h1
          style={{
            color: 'white',
            fontSize: '56px',
            fontWeight: 800,
            textAlign: 'center',
            lineHeight: 1.1,
            margin: '0 0 20px 0',
          }}
        >
          Universal MCP
          <br />
          Orchestration Hub
        </h1>
        <p style={{ color: '#c7d2fe', fontSize: '24px', textAlign: 'center', margin: 0, maxWidth: '800px' }}>
          Auto-discover, provision, route, and secure any AI tool or provider.
        </p>
        <div
          style={{
            marginTop: '40px',
            padding: '12px 28px',
            background: '#6366f1',
            borderRadius: '12px',
            color: 'white',
            fontSize: '18px',
            fontWeight: 600,
          }}
        >
          Open Source · Apache-2.0
        </div>
      </div>
    ),
    { ...size }
  );
}
