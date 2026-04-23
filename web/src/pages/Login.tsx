import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';

interface LoginProps {
  onLogin: (token: string) => void;
}

export function Login({ onLogin }: LoginProps) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) {
      setError('Please enter a JWT token.');
      return;
    }
    onLogin(token.trim());
    navigate('/');
  };

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-gray-900 flex items-center justify-center">
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl p-8 w-full max-w-md">
        <div className="text-center mb-8">
          <div className="text-5xl mb-3">🧠</div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">MCP Hub</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">Admin Console</p>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Bearer Token
            </label>
            <textarea
              value={token}
              onChange={(e) => { setToken(e.target.value); setError(''); }}
              placeholder="Paste your JWT token here..."
              rows={4}
              className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono resize-none"
            />
            {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
          </div>
          <button
            type="submit"
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-colors text-sm"
          >
            Sign In
          </button>
        </form>
        <p className="text-xs text-gray-400 dark:text-gray-500 text-center mt-4">
          Generate a token with: <code className="font-mono bg-gray-100 dark:bg-gray-700 px-1 rounded">JWT_SECRET</code> in your server config
        </p>
      </div>
    </div>
  );
}
