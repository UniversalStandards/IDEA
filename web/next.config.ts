import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // API proxy: forward /api/* calls to the MCP hub backend
  async rewrites() {
    const backendUrl = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:8080';
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
