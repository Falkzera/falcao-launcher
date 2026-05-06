import { pickProgressColor } from "../lib/format";

interface Props {
  /** Valor atual (bytes, %, ou unidade arbitrária). */
  value: number | null;
  /** Limite. null → não renderiza barra, mostra só "—". */
  max: number | null;
  /** Label curto à esquerda (ex: "RAM", "Disco"). */
  label: string;
  /** Formatter do valor (default: passthrough numérico). */
  formatValue?: (v: number) => string;
  /** Formatter do max (default: usa formatValue). */
  formatMax?: (v: number) => string;
}

export function UsageBar({
  value,
  max,
  label,
  formatValue,
  formatMax,
}: Props) {
  const fmtV = formatValue ?? ((v: number) => v.toString());
  const fmtM = formatMax ?? fmtV;

  // Sem dados ainda → mostra "—" no lugar da barra.
  if (value === null || max === null) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            {label}
          </span>
          <span className="font-mono text-xs text-[var(--color-text-muted)]">
            —
          </span>
        </div>
      </div>
    );
  }

  // max=0 → não tem limite definido (ex: container sem mem_limit). Mostra valor sem barra.
  if (max === 0) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            {label}
          </span>
          <span className="font-mono text-xs text-[var(--color-text-primary)]">
            {fmtV(value)}
          </span>
        </div>
      </div>
    );
  }

  const rawPct = (value / max) * 100;
  const pct = Math.min(100, Math.max(0, rawPct));
  const color = pickProgressColor(rawPct);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
          {label}
        </span>
        <span className="font-mono text-xs text-[var(--color-text-primary)]">
          {fmtV(value)}{" "}
          <span className="text-[var(--color-text-muted)]">/ {fmtM(max)}</span>
        </span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div
          className="h-full rounded-full transition-[width,background] duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}
