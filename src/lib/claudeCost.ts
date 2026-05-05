// src/lib/claudeCost.ts
import type { AggregatedUsage } from "../types";

type ModelPricing = {
  input_per_1m: number;
  cache_create_per_1m: number;
  cache_read_per_1m: number;
  output_per_1m: number;
};

const PRICING: Array<[string, ModelPricing]> = [
  ["claude-opus-4-7", { input_per_1m: 15, cache_create_per_1m: 18.75, cache_read_per_1m: 1.5, output_per_1m: 75 }],
  ["claude-sonnet-4-6", { input_per_1m: 3, cache_create_per_1m: 3.75, cache_read_per_1m: 0.3, output_per_1m: 15 }],
  ["claude-haiku-4-5", { input_per_1m: 0.8, cache_create_per_1m: 1, cache_read_per_1m: 0.08, output_per_1m: 4 }],
];

const FALLBACK: ModelPricing = { input_per_1m: 3, cache_create_per_1m: 3.75, cache_read_per_1m: 0.3, output_per_1m: 15 };

export function pricingFor(model: string | null | undefined): ModelPricing {
  if (!model) return FALLBACK;
  const match = PRICING.find(([key]) => model.startsWith(key));
  return match ? match[1] : FALLBACK;
}

export function costUsd(usage: AggregatedUsage, model: string | null | undefined): number {
  const p = pricingFor(model);
  return (
    (usage.input_tokens * p.input_per_1m +
      usage.cache_creation_input_tokens * p.cache_create_per_1m +
      usage.cache_read_input_tokens * p.cache_read_per_1m +
      usage.output_tokens * p.output_per_1m) /
    1_000_000
  );
}

export function totalTokens(usage: AggregatedUsage): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  );
}

export function humanizeTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "—";
  return `$${usd.toFixed(2)}`;
}
