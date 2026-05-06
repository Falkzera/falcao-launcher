import type { MetricBucket, WindowKey } from "../types/monitor";

interface Props {
  value: WindowKey;
  onChange: (w: WindowKey) => void;
}

const OPTIONS: WindowKey[] = ["1h", "6h", "24h", "7d", "30d"];

/**
 * Mapeia a janela escolhida para os params da API:
 *  - minutes: quantos minutos atrás começa a janela
 *  - bucket: agregação no Postgres (null = sem agregar, pontos crus)
 *
 * Buckets escolhidos pra manter ~60-300 pontos por chart, evitando lag no Recharts.
 */
export function windowToParams(w: WindowKey): {
  minutes: number;
  bucket: MetricBucket;
} {
  switch (w) {
    case "1h":
      return { minutes: 60, bucket: null };
    case "6h":
      return { minutes: 360, bucket: "1 minute" };
    case "24h":
      return { minutes: 1440, bucket: "5 minutes" };
    case "7d":
      return { minutes: 10080, bucket: "1 hour" };
    case "30d":
      return { minutes: 43200, bucket: "1 day" };
  }
}

export function TimeWindowSelector({ value, onChange }: Props) {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-1"
      role="tablist"
      aria-label="Janela de tempo"
    >
      {OPTIONS.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt)}
            className={
              "rounded-md px-3 py-1 text-xs font-semibold font-mono transition " +
              (active
                ? "bg-[var(--color-accent-primary)] text-black"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]")
            }
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
