import React from 'react';
import { Link, useLocation } from 'react-router-dom';

const routeLabels: Record<string, string> = {
  '': 'Overview',
  'capabilities': 'Capabilities',
  'workflows': 'Workflows',
  'policies': 'Policies',
  'providers': 'Providers',
  'users': 'Users',
  'api-keys': 'API Keys',
  'audit': 'Audit Log',
  'costs': 'Costs',
  'settings': 'Settings',
};

export function Breadcrumbs() {
  const location = useLocation();
  const segments = location.pathname.split('/').filter(Boolean);

  return (
    <nav className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400 mb-6">
      <Link to="/" className="hover:text-gray-700 dark:hover:text-gray-200">Home</Link>
      {segments.map((seg, i) => {
        const path = '/' + segments.slice(0, i + 1).join('/');
        const label = routeLabels[seg] ?? seg;
        const isLast = i === segments.length - 1;
        return (
          <React.Fragment key={path}>
            <span>/</span>
            {isLast ? (
              <span className="text-gray-900 dark:text-white font-medium">{label}</span>
            ) : (
              <Link to={path} className="hover:text-gray-700 dark:hover:text-gray-200">{label}</Link>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}
