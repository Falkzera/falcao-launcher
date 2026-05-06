import { monitorApi, usePolling } from "../lib/monitor";

interface Props {
  enabled: boolean;
}

export function VmHeader({ enabled }: Props) {
  const { data: status, error } = usePolling(
    monitorApi.vmStatus,
    15_000,
    enabled,
  );

  if (!enabled) {
    return (
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 text-sm text-[var(--color-text-secondary)]">
        Conectando ao monitor…
      </div>
    );
  }
  if (error && !status) {
    return (
      <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
        Erro ao ler status: {error}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 text-sm text-[var(--color-text-secondary)]">
        Carregando status da VM…
      </div>
    );
  }

  const heartbeatAge = status.last_heartbeat
    ? Math.round((Date.now() - Date.parse(status.last_heartbeat)) / 1000)
    : null;
  const stale = heartbeatAge === null || heartbeatAge > 60;

  const dotColor = stale
    ? "var(--color-danger)"
    : "var(--color-success)";

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 shadow-sm">
      <div className="flex items-center gap-3">
        <span
          className="h-2 w-2 rounded-full"
          style={{ background: dotColor }}
          aria-label={stale ? "stale" : "fresh"}
        />
        <span className="font-semibold text-[var(--color-text-primary)]">
          falcao-main
        </span>
        <span className="font-mono text-xs text-[var(--color-text-secondary)]">
          CX23 · Nuremberg · 162.55.217.189
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Agente
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {status.agent_version ?? "—"}
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {heartbeatAge !== null
              ? `heartbeat há ${heartbeatAge}s`
              : "sem heartbeat"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Load 1m
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {status.last_cpu_pct !== null
              ? status.last_cpu_pct.toFixed(2)
              : "—"}
          </div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            RAM
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {status.last_mem_pct !== null
              ? `${status.last_mem_pct.toFixed(1)}%`
              : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
