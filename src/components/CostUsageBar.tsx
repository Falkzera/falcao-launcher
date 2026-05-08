import { pctColor, type CostColor } from "../types/costs";

interface Props {
  /** Valor consumido. */
  value: number;
  /** Limite do free tier; null = sem free tier (renderiza barra cinza ⅓ cheia). */
  quota: number | null;
  /** % calculado já no backend (CostUsage.pct). null = sem quota. */
  pct: number | null;
  /** Texto pré-formatado (ex: "12.4 GB / 100 GB"). */
  label: string;
}

const COLOR_TO_VAR: Record<CostColor, string> = {
  success: "var(--color-success, #10b981)",
  warning: "var(--color-accent-primary)",
  danger: "var(--color-danger)",
  muted: "var(--color-text-muted)",
};

export function CostUsageBar({ value: _value, quota, pct, label }: Props) {
  const color = pctColor(pct);
  const fillPct = quota == null ? 33 : Math.min(100, Math.max(2, pct ?? 0));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-xs">
        <span className="text-[var(--color-text-secondary)]">{label}</span>
        {pct != null && (
          <span style={{ color: COLOR_TO_VAR[color] }} className="font-semibold">
            {pct.toFixed(1)}%
          </span>
        )}
        {pct == null && (
          <span className="text-[var(--color-text-muted)]">sem free tier</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-secondary)]">
        <div
          className="h-full rounded-full transition-[width,background-color]"
          style={{ width: `${fillPct}%`, backgroundColor: COLOR_TO_VAR[color] }}
        />
      </div>
    </div>
  );
}
