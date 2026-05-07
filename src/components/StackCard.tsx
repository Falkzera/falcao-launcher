import { useCallback } from "react";
import { fmtBytes, formatRelative, pickUptimeColor } from "../lib/format";
import { monitorApi, usePolling } from "../lib/monitor";
import type {
  ContainerInfo,
  HealthCheckSummary,
  StackSummary,
  VercelDeploymentRow,
} from "../types/monitor";
import { UsageBar } from "./UsageBar";
import { VercelStatusBadge } from "./VercelStatusBadge";

interface Props {
  summary: StackSummary;
  enabled: boolean;
}

export function StackCard({ summary, enabled }: Props) {
  // Lazy-load do detalhe — polling de 30s só quando o tunnel está pronto.
  const fetchDetail = useCallback(
    () => monitorApi.stackDetail(summary.name),
    [summary.name],
  );
  const { data: detail } = usePolling(fetchDetail, 30_000, enabled);

  const aggregateHealthy =
    summary.vercel_state === "READY" && summary.backend_running;

  return (
    <div
      className="flex flex-col gap-4 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 shadow-sm"
      data-stack={summary.name}
    >
      <header className="flex items-center justify-between gap-3">
        <h3
          className="page-title truncate text-lg text-[var(--color-text-primary)]"
          title={summary.name}
        >
          {summary.name}
        </h3>
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{
            background: aggregateHealthy
              ? "var(--color-success)"
              : "var(--color-text-muted)",
          }}
          aria-label={aggregateHealthy ? "stack saudável" : "stack incompleta"}
        />
      </header>

      <VercelBlock vercel={detail?.vercel ?? null} initialState={summary.vercel_state} />

      <BackendBlock
        containers={detail?.containers ?? []}
        backendRunning={summary.backend_running}
      />

      <EndpointBlock health={detail?.endpoint_health ?? null} />
    </div>
  );
}

// ─── Sub-blocos ────────────────────────────────────────────────────────────

function VercelBlock({
  vercel,
  initialState,
}: {
  vercel: VercelDeploymentRow | null;
  initialState: string | null;
}) {
  // Sem deploy ainda: estado vazio
  if (!vercel && !initialState) {
    return (
      <section className="space-y-1">
        <SectionLabel>Frontend Vercel</SectionLabel>
        <p className="text-xs text-[var(--color-text-muted)]">
          sem deploys ainda
        </p>
      </section>
    );
  }

  // Detail ainda carregando: mostra só o badge a partir do summary
  if (!vercel && initialState) {
    return (
      <section className="space-y-1.5">
        <SectionLabel>Frontend Vercel</SectionLabel>
        <VercelStatusBadge state={initialState} />
      </section>
    );
  }

  if (!vercel) return null;

  const url = vercel.prod_url ?? vercel.url;
  const href = url ? (url.startsWith("http") ? url : `https://${url}`) : null;
  const deployTs = vercel.ready_at ?? vercel.created_at;
  const buildLabel =
    vercel.build_ms != null ? `build: ${(vercel.build_ms / 1000).toFixed(1)}s` : null;

  const content = (
    <div className="flex flex-wrap items-center gap-2">
      <VercelStatusBadge state={vercel.state} />
      {deployTs && (
        <span className="text-xs text-[var(--color-text-secondary)]">
          deploy {formatRelative(new Date(deployTs))}
        </span>
      )}
      {buildLabel && (
        <span className="font-mono text-xs text-[var(--color-text-muted)]">
          · {buildLabel}
        </span>
      )}
      {vercel.branch && (
        <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
          {vercel.branch}
        </span>
      )}
    </div>
  );

  return (
    <section className="space-y-1.5">
      <SectionLabel>Frontend Vercel</SectionLabel>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="block rounded-md transition hover:bg-[var(--color-bg-glass)]"
          title={url ?? undefined}
        >
          {content}
        </a>
      ) : (
        content
      )}
      {vercel.commit_msg && (
        <p
          className="truncate text-xs text-[var(--color-text-muted)]"
          title={vercel.commit_msg}
        >
          “{vercel.commit_msg}”
          {vercel.author ? ` — ${vercel.author}` : ""}
        </p>
      )}
    </section>
  );
}

function BackendBlock({
  containers,
  backendRunning,
}: {
  containers: ContainerInfo[];
  backendRunning: boolean;
}) {
  if (containers.length === 0) {
    return (
      <section className="space-y-1">
        <SectionLabel>Backend container</SectionLabel>
        <p className="text-xs text-[var(--color-text-muted)]">
          {backendRunning ? "carregando…" : "container offline"}
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <SectionLabel>Backend container</SectionLabel>
      <div className="space-y-3">
        {containers.map((c) => (
          <ContainerStats key={c.name} container={c} />
        ))}
      </div>
    </section>
  );
}

function ContainerStats({ container }: { container: ContainerInfo }) {
  const ageSec = container.last_seen
    ? Math.round((Date.now() - Date.parse(container.last_seen)) / 1000)
    : null;
  const stale = ageSec === null || ageSec > 60;
  const uptimeLabel = container.last_seen
    ? formatRelative(new Date(container.last_seen))
    : "—";

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-[var(--color-text-primary)]">
          {container.name}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          {stale ? "stale" : `visto ${uptimeLabel}`}
        </span>
      </div>
      <UsageBar
        label="CPU"
        value={container.last_cpu_pct}
        max={100}
        formatValue={(v) => `${v.toFixed(1)}%`}
        formatMax={() => "100%"}
      />
      <UsageBar
        label="RAM"
        value={container.last_mem_used_bytes}
        max={container.last_mem_limit_bytes}
        formatValue={fmtBytes}
        formatMax={fmtBytes}
      />
    </div>
  );
}

function EndpointBlock({ health }: { health: HealthCheckSummary | null }) {
  if (!health) return null;

  const isDown = health.last_ok === false;
  const isUnknown = health.last_ok === null;
  const statusColor = isDown
    ? "var(--color-danger)"
    : isUnknown
      ? "var(--color-text-muted)"
      : "var(--color-success)";

  return (
    <section className="space-y-1.5">
      <SectionLabel>Endpoint público</SectionLabel>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span
          className="font-mono"
          style={{ color: statusColor }}
        >
          {isUnknown
            ? "—"
            : isDown
              ? `✗ ${health.last_status_code ?? "down"}`
              : `${health.last_status_code ?? 200}`}
        </span>
        {health.last_response_ms != null && (
          <span className="font-mono text-[var(--color-text-secondary)]">
            · {health.last_response_ms}ms
          </span>
        )}
        {health.uptime_30d != null && Number.isFinite(health.uptime_30d) && (
          <span className="font-mono" style={{ color: pickUptimeColor(health.uptime_30d) }}>
            · {health.uptime_30d.toFixed(2)}% / 30d
          </span>
        )}
      </div>
      <p
        className="truncate font-mono text-[10px] text-[var(--color-text-muted)]"
        title={health.endpoint}
      >
        {health.endpoint}
      </p>
    </section>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
      {children}
    </div>
  );
}
