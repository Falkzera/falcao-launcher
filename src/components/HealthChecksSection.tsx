import { monitorApi, usePolling } from "../lib/monitor";
import { HealthCheckRow } from "./HealthCheckRow";

interface Props {
  enabled: boolean;
}

export function HealthChecksSection({ enabled }: Props) {
  const { data: summaries } = usePolling(
    monitorApi.healthSummary,
    30_000,
    enabled,
  );

  if (!summaries) {
    return (
      <section>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-secondary)]">
          Health checks externos
        </h2>
        <div className="text-sm text-[var(--color-text-tertiary)]">
          Carregando health checks…
        </div>
      </section>
    );
  }

  const allEmpty = summaries.every((s) => s.last_ts === null);

  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-secondary)]">
        Health checks externos
      </h2>
      {allEmpty ? (
        <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 text-sm text-[var(--color-text-tertiary)]">
          Aguardando primeiro check externo… (workflow GH Actions roda a cada 5min)
        </div>
      ) : (
        <div className="space-y-2">
          {summaries.map((s) => (
            <HealthCheckRow key={s.endpoint} summary={s} />
          ))}
        </div>
      )}
    </section>
  );
}
