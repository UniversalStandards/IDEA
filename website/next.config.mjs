import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Silence the multi-lockfile workspace root detection warning
  outputFileTracingRoot: path.join(__dirname, '..'),
};
export default nextConfig;
