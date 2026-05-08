interface Props {
  /** Quantidade de métricas em estado danger (≥90%). 0 → não renderiza. */
  count: number;
}

/**
 * Chip compacto na topbar próximo ao label "Custos".
 * Sprint B3 — Monitor de custos. Render null se count == 0.
 */
export function CostChip({ count }: Props) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-1 rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-[var(--color-danger)]"
      title={`${count} métrica${count === 1 ? "" : "s"} ≥ 90% do free tier`}
    >
      ⚠ {count}
    </span>
  );
}
