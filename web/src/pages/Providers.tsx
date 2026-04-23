import { useToast } from '../components/Toast';
import type { Provider } from '../types';

const MOCK_PROVIDERS: Provider[] = [
  { id: '1', name: 'OpenAI', type: 'openai', models: 5, health: 'healthy', circuitBreaker: 'closed', costToday: 1.24 },
  { id: '2', name: 'Anthropic', type: 'anthropic', models: 3, health: 'healthy', circuitBreaker: 'closed', costToday: 0.87 },
  { id: '3', name: 'Google Gemini', type: 'google', models: 4, health: 'degraded', circuitBreaker: 'half-open', costToday: 0.36 },
  { id: '4', name: 'Local Ollama', type: 'local', models: 2, health: 'healthy', circuitBreaker: 'closed', costToday: 0 },
];

interface ProvidersProps {
  token: string;
}

function HealthDot({ health }: { health: Provider['health'] }) {
  const colors = { healthy: 'bg-green-500', degraded: 'bg-yellow-500', down: 'bg-red-500' };
  return <span className={`inline-block w-2.5 h-2.5 rounded-full ${colors[health]}`} />;
}

export function Providers({ token: _token }: ProvidersProps) {
  const { showToast } = useToast();

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Providers</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">AI model provider health and configuration</p>
        </div>
        <button onClick={() => showToast('Add provider: coming soon', 'info')} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors">
          + Add Provider
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {MOCK_PROVIDERS.map((provider) => (
          <div key={provider.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <span className="text-2xl">
                  {provider.type === 'openai' ? '🟢' : provider.type === 'anthropic' ? '🟠' : provider.type === 'google' ? '🔵' : '⚪'}
                </span>
                <span className="font-semibold text-gray-900 dark:text-white">{provider.name}</span>
              </div>
              <HealthDot health={provider.health} />
            </div>

            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Status</span>
                <span className={`font-medium capitalize ${provider.health === 'healthy' ? 'text-green-600 dark:text-green-400' : provider.health === 'degraded' ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-600 dark:text-red-400'}`}>
                  {provider.health}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Models</span>
                <span className="text-gray-800 dark:text-gray-200">{provider.models}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Circuit</span>
                <span className={`font-medium capitalize ${provider.circuitBreaker === 'closed' ? 'text-green-600 dark:text-green-400' : provider.circuitBreaker === 'open' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}`}>
                  {provider.circuitBreaker}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Cost Today</span>
                <span className="text-gray-800 dark:text-gray-200 font-medium">
                  {provider.costToday === 0 ? 'Free' : `$${provider.costToday.toFixed(2)}`}
                </span>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-gray-100 dark:border-gray-700 flex gap-2">
              <button onClick={() => showToast(`Checking health: ${provider.name}`, 'info')} className="flex-1 text-xs py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700">
                Ping
              </button>
              <button onClick={() => showToast(`Configuring: ${provider.name}`, 'info')} className="flex-1 text-xs py-1.5 rounded border border-blue-300 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20">
                Configure
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
