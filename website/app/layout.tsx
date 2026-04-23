import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { ThemeProvider } from '@/components/ThemeProvider';
import Header from '@/components/Header';
import Footer from '@/components/Footer';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  metadataBase: new URL('https://universalstandards.dev'),
  title: {
    default: 'Universal MCP Orchestration Hub',
    template: '%s | Universal MCP Orchestration Hub',
  },
  description:
    'The universal orchestration layer for AI tools. Auto-discover, provision, route, and secure any MCP-compatible tool or AI provider.',
  openGraph: {
    type: 'website',
    locale: 'en_US',
    url: 'https://universalstandards.dev',
    siteName: 'Universal MCP Orchestration Hub',
  },
  twitter: { card: 'summary_large_image' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100 antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <Header />
          <main>{children}</main>
          <Footer />
        </ThemeProvider>
      </body>
    </html>
  );
}
