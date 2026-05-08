// Espelha src-tauri/src/monitor/costs.rs (Tauri serializa em snake_case).
// Mantido em sync manualmente — drift gated em code review.

export type CostService = "vercel" | "gh_actions" | "hetzner";
export type CostUnit = "bytes" | "minutes" | "count" | "usd";

export interface CostUsage {
  service: CostService;
  metric: string;
  value: number;
  quota: number | null;
  unit: CostUnit;
  pct: number | null;
  period_start: string | null; // ISO
  ts: string;                  // ISO
}

export interface CostHistoryPoint {
  ts: string;
  value: number;
}

export const COST_THRESHOLDS = {
  warning: 70,
  danger: 90,
} as const;

export type CostColor = "success" | "warning" | "danger" | "muted";

export function pctColor(pct: number | null): CostColor {
  if (pct == null) return "muted";
  if (pct >= COST_THRESHOLDS.danger) return "danger";
  if (pct >= COST_THRESHOLDS.warning) return "warning";
  return "success";
}

export const SERVICE_LABEL: Record<CostService, string> = {
  vercel: "Vercel",
  gh_actions: "GitHub Actions",
  hetzner: "Hetzner",
};

export const SERVICE_ICON: Record<CostService, string> = {
  vercel: "▲",
  gh_actions: "🐙",
  hetzner: "☁",
};

/** Formata `value` no `unit` declarado, sem assumir nada do contexto. */
export function formatCostValue(value: number, unit: CostUnit): string {
  switch (unit) {
    case "bytes":
      return formatBytes(value);
    case "minutes":
      return `${Math.round(value)} min`;
    case "count":
      return value.toLocaleString("pt-BR");
    case "usd":
      return `$${value.toFixed(2)}`;
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b.toFixed(0)} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
