import { NavLink, useNavigate } from 'react-router-dom';
import { useTheme } from '../hooks/useTheme';

interface SidebarProps {
  onLogout: () => void;
}

const navItems = [
  { path: '/', label: 'Overview', icon: '🏠', end: true },
  { path: '/capabilities', label: 'Capabilities', icon: '🔧' },
  { path: '/workflows', label: 'Workflows', icon: '⚙️' },
  { path: '/policies', label: 'Policies', icon: '📋' },
  { path: '/providers', label: 'Providers', icon: '🤖' },
  { path: '/users', label: 'Users', icon: '👥' },
  { path: '/api-keys', label: 'API Keys', icon: '🔑' },
  { path: '/audit', label: 'Audit Log', icon: '📊' },
  { path: '/costs', label: 'Costs', icon: '💰' },
  { path: '/settings', label: 'Settings', icon: '⚙️' },
];

export function Sidebar({ onLogout }: SidebarProps) {
  const { isDark, toggle } = useTheme();
  const navigate = useNavigate();

  const handleLogout = () => {
    onLogout();
    navigate('/login');
  };

  return (
    <aside className="fixed top-0 left-0 h-full w-60 flex flex-col bg-gray-50 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 z-10">
      <div className="px-6 py-5 border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🧠</span>
          <div>
            <div className="font-bold text-gray-900 dark:text-white text-base">MCP Hub</div>
            <div className="text-xs text-gray-500 dark:text-gray-400">Admin Console</div>
          </div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3">
        {navItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.end}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg mb-0.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`
            }
          >
            <span className="text-lg leading-none">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2">
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors w-full text-left"
        >
          <span className="text-lg leading-none">{isDark ? '☀️' : '🌙'}</span>
          {isDark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors w-full text-left"
        >
          <span className="text-lg leading-none">🚪</span>
          Logout
        </button>
      </div>
    </aside>
  );
}
