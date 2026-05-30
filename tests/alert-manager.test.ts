import { AlertManager, type AlertChannel } from '../src/observability/AlertManager';

describe('AlertManager', () => {
  it('fires and routes alerts when threshold is breached', async () => {
    const manager = new AlertManager();
    const sent: string[] = [];
    const channel: AlertChannel = {
      send: async () => {
        sent.push('delivered');
      },
    };

    manager.registerChannel('webhook', channel);
    manager.registerRule('org-1', {
      name: 'latency-high',
      metricKey: 'latency_ms',
      threshold: 500,
      operator: '>=',
      severity: 'high',
      channels: ['webhook'],
      cooldownMs: 1_000,
    });

    manager.evaluate('org-1', 'latency_ms', 550, new Date('2026-01-01T00:00:00.000Z'));
    await Promise.resolve();

    expect(sent).toHaveLength(1);
  });

  it('respects cooldown per org/rule', async () => {
    const manager = new AlertManager();
    let deliveries = 0;
    manager.registerChannel('webhook', {
      send: async () => {
        deliveries += 1;
      },
    });
    manager.registerRule('org-1', {
      name: 'errors',
      metricKey: 'error_rate',
      threshold: 0.1,
      operator: '>',
      severity: 'critical',
      channels: ['webhook'],
      cooldownMs: 30_000,
    });

    manager.evaluate('org-1', 'error_rate', 0.2, new Date('2026-01-01T00:00:00.000Z'));
    manager.evaluate('org-1', 'error_rate', 0.25, new Date('2026-01-01T00:00:10.000Z'));
    manager.evaluate('org-1', 'error_rate', 0.3, new Date('2026-01-01T00:00:31.000Z'));

    await Promise.resolve();
    expect(deliveries).toBe(2);
  });
});
