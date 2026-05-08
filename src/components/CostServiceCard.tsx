import {
  formatCostValue,
  SERVICE_ICON,
  SERVICE_LABEL,
  type CostService,
  type CostUsage,
} from "../types/costs";
import { CostUsageBar } from "./CostUsageBar";

interface Props {
  service: CostService;
  metrics: CostUsage[];
}

export function CostServiceCard({ service, metrics }: Props) {
  const sortedMetrics = [...metrics].sort((a, b) => {
    if (a.pct == null && b.pct == null) return 0;
    if (a.pct == null) return 1;
    if (b.pct == null) return -1;
    return b.pct - a.pct;
  });

  return (
    <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-[var(--color-text-primary)]">
          <span aria-hidden>{SERVICE_ICON[service]}</span>
          <span>{SERVICE_LABEL[service]}</span>
        </h3>
      </header>

      {sortedMetrics.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          aguardando primeira coleta (até 1h)
        </p>
      )}

      {sortedMetrics.map((m) => {
        const valueFmt = formatCostValue(m.value, m.unit);
        const quotaFmt = m.quota != null ? formatCostValue(m.quota, m.unit) : null;
        const label = quotaFmt
          ? `${m.metric}: ${valueFmt} / ${quotaFmt}`
          : `${m.metric}: ${valueFmt}`;
        return (
          <CostUsageBar
            key={m.metric}
            value={m.value}
            quota={m.quota}
            pct={m.pct}
            label={label}
          />
        );
      })}
    </section>
  );
}
