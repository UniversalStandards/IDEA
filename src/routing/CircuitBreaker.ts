export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface ProviderCircuitState {
  state: CircuitBreakerState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
}

export class CircuitBreaker {
  private readonly states = new Map<string, ProviderCircuitState>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly recoveryTimeoutMs = 30_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  canRequest(providerId: string): boolean {
    const state = this.getOrInit(providerId);

    if (state.state === 'OPEN') {
      if (this.now() - state.openedAt >= this.recoveryTimeoutMs) {
        state.state = 'HALF_OPEN';
        state.probeInFlight = false;
      } else {
        return false;
      }
    }

    if (state.state === 'HALF_OPEN') {
      if (state.probeInFlight) return false;
      state.probeInFlight = true;
      return true;
    }

    return true;
  }

  recordSuccess(providerId: string): void {
    const state = this.getOrInit(providerId);
    state.state = 'CLOSED';
    state.consecutiveFailures = 0;
    state.probeInFlight = false;
    state.openedAt = 0;
  }

  recordFailure(providerId: string): void {
    const state = this.getOrInit(providerId);

    if (state.state === 'HALF_OPEN' || state.state === 'OPEN') {
      this.open(state);
      return;
    }

    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.failureThreshold) {
      this.open(state);
    }
  }

  getState(providerId: string): CircuitBreakerState {
    const state = this.getOrInit(providerId);
    if (state.state === 'OPEN' && this.now() - state.openedAt >= this.recoveryTimeoutMs) {
      state.state = 'HALF_OPEN';
      state.probeInFlight = false;
    }
    return state.state;
  }

  private open(state: ProviderCircuitState): void {
    state.state = 'OPEN';
    state.openedAt = this.now();
    state.probeInFlight = false;
  }

  private getOrInit(providerId: string): ProviderCircuitState {
    const existing = this.states.get(providerId);
    if (existing) return existing;

    const created: ProviderCircuitState = {
      state: 'CLOSED',
      consecutiveFailures: 0,
      openedAt: 0,
      probeInFlight: false,
    };
    this.states.set(providerId, created);
    return created;
  }
}
