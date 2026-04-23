import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useTheme } from './hooks/useTheme';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/Toast';
import { Login } from './pages/Login';
import { Overview } from './pages/Overview';
import { Capabilities } from './pages/Capabilities';
import { Workflows } from './pages/Workflows';
import { Policies } from './pages/Policies';
import { Providers } from './pages/Providers';
import { Users } from './pages/Users';
import { ApiKeys } from './pages/ApiKeys';
import { Audit } from './pages/Audit';
import { Costs } from './pages/Costs';
import { Settings } from './pages/Settings';

function RequireAuth({ children, token }: { children: React.ReactNode; token: string | null }) {
  if (!token) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { token, login, logout } = useAuth();
  useTheme(); // init dark mode on mount

  return (
    <ToastProvider>
      <BrowserRouter basename="/admin-ui">
        <Routes>
          <Route path="/login" element={<Login onLogin={login} />} />
          <Route
            path="/*"
            element={
              <RequireAuth token={token}>
                <Layout onLogout={logout}>
                  <Routes>
                    <Route path="/" element={<Overview token={token!} />} />
                    <Route path="/capabilities" element={<Capabilities token={token!} />} />
                    <Route path="/workflows" element={<Workflows token={token!} />} />
                    <Route path="/policies" element={<Policies token={token!} />} />
                    <Route path="/providers" element={<Providers token={token!} />} />
                    <Route path="/users" element={<Users token={token!} />} />
                    <Route path="/api-keys" element={<ApiKeys token={token!} />} />
                    <Route path="/audit" element={<Audit token={token!} />} />
                    <Route path="/costs" element={<Costs token={token!} />} />
                    <Route path="/settings" element={<Settings token={token!} />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Layout>
              </RequireAuth>
            }
          />
        </Routes>
      </BrowserRouter>
    </ToastProvider>
  );
}
