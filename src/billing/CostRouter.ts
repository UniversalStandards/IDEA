import { CostAttributor } from './CostAttributor';

export class CostRouter {
  constructor(private readonly attributor: CostAttributor) {}

  getCostPerModelTier(): Record<string, number> {
    const result: Record<string, number> = {};

    for (const price of this.attributor.getPriceTable()) {
      const baseline = price.inputPer1kTokensUsd + price.outputPer1kTokensUsd;
      result[price.tier] = Math.min(result[price.tier] ?? Number.POSITIVE_INFINITY, baseline);
    }

    return result;
  }

  chooseLowestCostModel(models: string[]): string | null {
    let bestModel: string | null = null;
    let bestCost = Number.POSITIVE_INFINITY;

    for (const model of models) {
      const entry = this.attributor.getPriceTable().find((price) => price.model === model);
      if (!entry) continue;
      const cost = entry.inputPer1kTokensUsd + entry.outputPer1kTokensUsd;
      if (cost < bestCost) {
        bestCost = cost;
        bestModel = model;
      }
    }

    return bestModel;
  }
}
