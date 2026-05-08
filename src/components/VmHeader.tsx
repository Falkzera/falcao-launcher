import { forecastMonthly } from "../lib/cost";
import { fmtBytes } from "../lib/format";
import { monitorApi, usePolling } from "../lib/monitor";
import { InlineLoading } from "./Loading";
import { UsageBar } from "./UsageBar";

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
      <InlineLoading
        minHeight="9rem"
        messages={[
          "Abrindo túnel SSH",
          "Conectando ao monitor",
          "Negociando chaves",
          "Quase lá",
        ]}
      />
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
      <InlineLoading
        minHeight="9rem"
        messages={[
          "Lendo status da VM",
          "Coletando heartbeat do agente",
          "Calculando custo acumulado",
          "Quase lá",
        ]}
      />
    );
  }

  const heartbeatAge = status.last_heartbeat
    ? Math.round((Date.now() - Date.parse(status.last_heartbeat)) / 1000)
    : null;
  const stale = heartbeatAge === null || heartbeatAge > 60;

  const dotColor = stale ? "var(--color-danger)" : "var(--color-success)";

  // Disco: total = used + avail (quando ambos disponíveis).
  const diskTotal =
    status.last_disk_used_bytes !== null && status.last_disk_avail_bytes !== null
      ? status.last_disk_used_bytes + status.last_disk_avail_bytes
      : null;

  // Forecast custo mensal.
  const forecast =
    status.cost_accumulated_usd !== null && status.vm_age_hours !== null
      ? forecastMonthly(status.cost_accumulated_usd, status.vm_age_hours)
      : null;

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

      {/* Linha 1: cards "header" — Agente, Uptime, Load, Custo */}
      <div className="mt-3 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
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
            Uptime
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {formatUptime(status.vm_age_hours)}
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
            Custo
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {status.cost_accumulated_usd !== null ? (
              <>
                ${status.cost_accumulated_usd.toFixed(2)}
                {forecast !== null && (
                  <span className="text-[var(--color-text-muted)]">
                    {" "}
                    / ${forecast.toFixed(2)}
                  </span>
                )}
              </>
            ) : (
              "$—"
            )}
          </div>
          <div className="text-xs text-[var(--color-text-muted)]">
            {status.vm_age_hours !== null
              ? `~${status.vm_age_hours.toFixed(0)}h rodando`
              : "—"}
          </div>
        </div>
      </div>

      {/* Linha 2: bars de utilização — RAM, Disco, Bandwidth */}
      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        <UsageBar
          label="RAM"
          value={status.last_mem_used_bytes}
          max={status.last_mem_total_bytes}
          formatValue={fmtBytes}
          formatMax={fmtBytes}
        />
        <UsageBar
          label="Disco"
          value={status.last_disk_used_bytes}
          max={diskTotal}
          formatValue={fmtBytes}
          formatMax={fmtBytes}
        />
        <UsageBar
          label="Bandwidth do mês"
          value={status.last_hetzner_outgoing_bytes}
          max={status.last_hetzner_included_bytes}
          formatValue={fmtBytes}
          formatMax={fmtBytes}
        />
      </div>
    </div>
  );
}

/**
 * Formata uptime em string humana, escolhendo unidade apropriada.
 *  < 1h   → "32 min"
 *  < 24h  → "5h 32min" (ou "5h" se min == 0)
 *  < 30d  → "12 dias"
 *  ≥ 30d  → "2.0 meses (62 dias)"
 */
function formatUptime(hours: number | null): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "—";
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 24) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  const days = hours / 24;
  if (days < 30) {
    const d = Math.floor(days);
    return `${d} dia${d >= 2 ? "s" : ""}`;
  }
  const months = days / 30;
  return `${months.toFixed(1)} meses (${Math.floor(days)} dias)`;
}
