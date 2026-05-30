import { EventEmitter } from 'events';
import axios from 'axios';
import nodemailer, { type Transporter } from 'nodemailer';
import { createLogger } from './logger';

const logger = createLogger('alert-manager');

export type AlertOperator = '>' | '>=' | '<' | '<=' | '==' | '!=';
export type AlertChannelType = 'slack' | 'email' | 'webhook';

export interface AlertRule {
  name: string;
  metricKey: string;
  threshold: number;
  operator: AlertOperator;
  severity: 'low' | 'medium' | 'high' | 'critical';
  cooldownMs?: number;
  requiredForMs?: number;
  channels: AlertChannelType[];
}

export interface AlertPayload {
  orgId: string;
  ruleName: string;
  metricKey: string;
  threshold: number;
  operator: AlertOperator;
  observedValue: number;
  severity: AlertRule['severity'];
  breachedAt: string;
}

export interface AlertChannel {
  send(payload: AlertPayload): Promise<void>;
}

export class SlackWebhookChannel implements AlertChannel {
  constructor(private readonly webhookUrl: string) {}

  async send(payload: AlertPayload): Promise<void> {
    await axios.post(this.webhookUrl, {
      text: `[${payload.severity.toUpperCase()}] ${payload.orgId}:${payload.ruleName} ${payload.metricKey} ${payload.operator} ${payload.threshold}; observed=${payload.observedValue}`,
      metadata: payload,
    });
  }
}

export class WebhookChannel implements AlertChannel {
  constructor(private readonly webhookUrl: string) {}

  async send(payload: AlertPayload): Promise<void> {
    await axios.post(this.webhookUrl, payload);
  }
}

export class EmailChannel implements AlertChannel {
  private readonly transporter: Transporter;

  constructor(
    private readonly smtpUrl: string,
    private readonly from: string,
    private readonly to: string,
  ) {
    this.transporter = nodemailer.createTransport(this.smtpUrl);
  }

  async send(payload: AlertPayload): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: this.to,
      subject: `[${payload.severity.toUpperCase()}] Alert: ${payload.ruleName}`,
      text: JSON.stringify(payload, null, 2),
    });
  }
}

interface RuleState {
  firstBreachedAt?: number;
  lastFiredAt?: number;
}

export class AlertManager extends EventEmitter {
  private readonly rulesByOrg = new Map<string, AlertRule[]>();
  private readonly channelRegistry = new Map<AlertChannelType, AlertChannel>();
  private readonly stateByRule = new Map<string, RuleState>();

  registerChannel(type: AlertChannelType, channel: AlertChannel): void {
    this.channelRegistry.set(type, channel);
  }

  registerRule(orgId: string, rule: AlertRule): void {
    const orgRules = this.rulesByOrg.get(orgId) ?? [];
    orgRules.push(rule);
    this.rulesByOrg.set(orgId, orgRules);
  }

  evaluate(orgId: string, metricKey: string, value: number, now: Date = new Date()): void {
    const rules = this.rulesByOrg.get(orgId) ?? [];
    for (const rule of rules) {
      if (rule.metricKey !== metricKey) continue;

      const ruleKey = `${orgId}:${rule.name}`;
      const state = this.stateByRule.get(ruleKey) ?? {};
      const isBreached = this.isThresholdBreached(value, rule.operator, rule.threshold);

      if (!isBreached) {
        this.stateByRule.set(ruleKey, {});
        continue;
      }

      const nowMs = now.getTime();
      const firstBreachedAt = state.firstBreachedAt ?? nowMs;
      const requiredForMs = rule.requiredForMs ?? 0;
      const cooldownMs = rule.cooldownMs ?? 30_000;
      const cooldownElapsed = state.lastFiredAt === undefined || nowMs - state.lastFiredAt >= cooldownMs;
      const sustained = nowMs - firstBreachedAt >= requiredForMs;

      const nextState: RuleState = { ...state, firstBreachedAt };
      this.stateByRule.set(ruleKey, nextState);

      if (!cooldownElapsed || !sustained) continue;

      const payload: AlertPayload = {
        orgId,
        ruleName: rule.name,
        metricKey: rule.metricKey,
        threshold: rule.threshold,
        operator: rule.operator,
        observedValue: value,
        severity: rule.severity,
        breachedAt: now.toISOString(),
      };

      this.stateByRule.set(ruleKey, { ...nextState, lastFiredAt: nowMs });
      this.emit('alert.fired', payload);
      void this.dispatchAlert(rule.channels, payload);
    }
  }

  private async dispatchAlert(channels: AlertChannelType[], payload: AlertPayload): Promise<void> {
    const deliveries = channels
      .map((channelType) => this.channelRegistry.get(channelType))
      .filter((channel): channel is AlertChannel => channel !== undefined)
      .map(async (channel) => channel.send(payload));

    const results = await Promise.allSettled(deliveries);
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.warn('Alert channel delivery failed', {
          orgId: payload.orgId,
          ruleName: payload.ruleName,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  private isThresholdBreached(value: number, operator: AlertOperator, threshold: number): boolean {
    switch (operator) {
      case '>':
        return value > threshold;
      case '>=':
        return value >= threshold;
      case '<':
        return value < threshold;
      case '<=':
        return value <= threshold;
      case '==':
        return value === threshold;
      case '!=':
        return value !== threshold;
      default:
        return false;
    }
  }
}

export const alertManager = new AlertManager();
