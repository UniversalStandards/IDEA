import React from 'react';
import { Sidebar } from './Sidebar';
import { Breadcrumbs } from './Breadcrumbs';

interface LayoutProps {
  children: React.ReactNode;
  onLogout: () => void;
}

export function Layout({ children, onLogout }: LayoutProps) {
  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900">
      <Sidebar onLogout={onLogout} />
      <main className="ml-60 p-8">
        <Breadcrumbs />
        {children}
      </main>
    </div>
  );
}
