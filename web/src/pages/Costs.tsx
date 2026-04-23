import { useState } from 'react';
import type { CostEntry } from '../types';

const MOCK_COSTS: CostEntry[] = [
  { provider: 'OpenAI', model: 'gpt-4o', costUsd: 0.84, requests: 142 },
  { provider: 'OpenAI', model: 'gpt-4o-mini', costUsd: 0.12, requests: 380 },
  { provider: 'Anthropic', model: 'claude-3-5-sonnet', costUsd: 0.62, requests: 87 },
  { provider: 'Anthropic', model: 'claude-3-haiku', costUsd: 0.08, requests: 210 },
  { provider: 'Google', model: 'gemini-1.5-pro', costUsd: 0.27, requests: 65 },
  { provider: 'Google', model: 'gemini-1.5-flash', costUsd: 0.05, requests: 190 },
];

const BUDGET_DAILY = 10.0;

const providerTotals = MOCK_COSTS.reduce<Record<string, number>>((acc, c) => {
  acc[c.provider] = (acc[c.provider] ?? 0) + c.costUsd;
  return acc;
}, {});

const maxProviderCost = Math.max(...Object.values(providerTotals));

function SummaryCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
      {sub && <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">{sub}</div>}
    </div>
  );
}

interface CostsProps {
  token: string;
}

export function Costs({ token: _token }: CostsProps) {
  const [window_, setWindow_] = useState(24);
  const totalToday = MOCK_COSTS.reduce((s, c) => s + c.costUsd, 0);
  const budgetPct = Math.min(100, (totalToday / BUDGET_DAILY) * 100);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Costs</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">AI provider usage and spending</p>
        </div>
        <select value={window_} onChange={(e) => setWindow_(Number(e.target.value))} className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white">
          <option value={24}>Last 24h</option>
          <option value={168}>Last 7 days</option>
          <option value={720}>Last 30 days</option>
        </select>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <SummaryCard label="Today" value={`$${totalToday.toFixed(2)}`} sub={`${MOCK_COSTS.reduce((s, c) => s + c.requests, 0)} requests`} />
        <SummaryCard label="This Week" value={`$${(totalToday * 5.2).toFixed(2)}`} sub="Est. based on today" />
        <SummaryCard label="This Month" value={`$${(totalToday * 18.7).toFixed(2)}`} sub="Est. based on today" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Cost by Provider</h2>
          <div className="space-y-3">
            {Object.entries(providerTotals).map(([provider, cost]) => (
              <div key={provider}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="text-gray-700 dark:text-gray-300 font-medium">{provider}</span>
                  <span className="text-gray-600 dark:text-gray-400">${cost.toFixed(2)}</span>
                </div>
                <div className="h-6 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-500"
                    style={{ width: `${(cost / maxProviderCost) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
          <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Daily Budget</h2>
          <div className="mb-2 flex justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">Used: ${totalToday.toFixed(2)}</span>
            <span className="text-gray-600 dark:text-gray-400">Budget: ${BUDGET_DAILY.toFixed(2)}</span>
          </div>
          <div className="h-4 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden mb-2">
            <div
              className={`h-full rounded-full transition-all duration-500 ${budgetPct > 80 ? 'bg-red-500' : budgetPct > 60 ? 'bg-yellow-500' : 'bg-green-500'}`}
              style={{ width: `${budgetPct}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">{budgetPct.toFixed(1)}% of daily budget used</p>

          <div className="mt-6">
            <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Window: {window_}h</p>
            <p className="text-xs text-gray-400 dark:text-gray-500">Data updates every 60 seconds</p>
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-4">Cost by Model</h2>
        <table className="w-full text-sm">
          <thead className="text-xs text-gray-500 dark:text-gray-400 uppercase">
            <tr>
              <th className="text-left pb-3">Provider</th>
              <th className="text-left pb-3">Model</th>
              <th className="text-right pb-3">Requests</th>
              <th className="text-right pb-3">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {[...MOCK_COSTS].sort((a, b) => b.costUsd - a.costUsd).map((entry, i) => (
              <tr key={i}>
                <td className="py-2.5 text-gray-700 dark:text-gray-300">{entry.provider}</td>
                <td className="py-2.5 font-mono text-xs text-gray-600 dark:text-gray-400">{entry.model}</td>
                <td className="py-2.5 text-right text-gray-700 dark:text-gray-300">{entry.requests.toLocaleString()}</td>
                <td className="py-2.5 text-right font-medium text-gray-900 dark:text-white">${entry.costUsd.toFixed(3)}</td>
              </tr>
            ))}
            <tr className="border-t-2 border-gray-300 dark:border-gray-600">
              <td colSpan={2} className="py-2.5 font-semibold text-gray-900 dark:text-white">Total</td>
              <td className="py-2.5 text-right font-semibold text-gray-900 dark:text-white">{MOCK_COSTS.reduce((s, c) => s + c.requests, 0).toLocaleString()}</td>
              <td className="py-2.5 text-right font-semibold text-gray-900 dark:text-white">${totalToday.toFixed(3)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
