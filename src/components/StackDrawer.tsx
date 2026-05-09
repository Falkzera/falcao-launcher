import { useCallback, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { fmtBytes, formatRelative, pickUptimeColor } from "../lib/format";
import { monitorApi, usePolling } from "../lib/monitor";
import {
  resolveSecurityTargetDir,
  serializeSecurityGroup,
} from "../lib/serializeSecurity";
import { slideInRight } from "../styles/animations";
import type {
  ContainerInfo,
  HealthCheckSummary,
  VercelDeploymentRow,
  WindowKey,
} from "../types/monitor";
import type { VulnerabilityRow as VulnRow } from "../types/security";
import { DrawerLoadingOverlay } from "./Loading";
import { TimeWindowSelector, windowToParams } from "./TimeWindowSelector";
import { UsageBar } from "./UsageBar";
import { VercelStatusBadge } from "./VercelStatusBadge";
import { VmMetricChart } from "./VmMetricChart";

interface Props {
  stackName: string;
  enabled: boolean;
  onClose: () => void;
  /** Quando presente, renderiza botão "🔍 Investigar período" no header
   *  de cada container do bloco backend. Sprint 3. */
  onInvestigateContainer?: (containerName: string) => void;
}

const WINDOW_LABELS: Record<WindowKey, string> = {
  "1h": "últimos 60 min",
  "6h": "últimas 6h",
  "24h": "últimas 24h",
  "7d": "últimos 7 dias",
  "30d": "últimos 30 dias",
};

export function StackDrawer({
  stackName,
  enabled,
  onClose,
  onInvestigateContainer,
}: Props) {
  const fetchDetail = useCallback(
    () => monitorApi.stackDetail(stackName),
    [stackName],
  );
  const { data: detail } = usePolling(fetchDetail, 30_000, enabled);

  const [drawerWindow, setDrawerWindow] = useState<WindowKey>("1h");
  const params = windowToParams(drawerWindow);

  // Loading: detail ainda não chegou na primeira coleta.
  // Quando estiver disponível mostramos o conteúdo real; o usePolling
  // continua atualizando em background a cada 30s sem reativar o overlay.
  const isLoading = detail === null || detail === undefined;

  return (
    <motion.aside
      variants={slideInRight}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed top-0 right-0 z-30 flex h-full w-full max-w-2xl flex-col overflow-hidden border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            stack
          </div>
          <h3 className="truncate font-mono text-base font-semibold text-[var(--color-text-primary)]">
            {stackName}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="rounded-md px-2 py-1 text-sm text-[var(--color-text-secondary)] transition hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
          aria-label="Fechar"
        >
          ✕
        </button>
      </header>

      <div className="relative min-h-0 flex-1">
        <div
          className="h-full space-y-7 overflow-y-auto p-5"
          style={{ overscrollBehavior: "contain" }}
        >
          <VercelSection
            latest={detail?.vercel ?? null}
            history={detail?.vercel_history ?? []}
          />

          <ContainersSection
            containers={detail?.containers ?? []}
            enabled={enabled}
            window={drawerWindow}
            onWindowChange={setDrawerWindow}
            windowParams={params}
            onInvestigateContainer={onInvestigateContainer}
          />

          <SecuritySection
            stackName={stackName}
            containers={detail?.containers ?? []}
            enabled={enabled}
          />

          {detail?.endpoint_health && (
            <EndpointSection health={detail.endpoint_health} />
          )}
        </div>
        <DrawerLoadingOverlay loading={isLoading} />
      </div>
    </motion.aside>
  );
}

// ─── Vercel ─────────────────────────────────────────────────────────────────

function VercelSection({
  latest,
  history,
}: {
  latest: VercelDeploymentRow | null;
  history: VercelDeploymentRow[];
}) {
  if (!latest && history.length === 0) {
    return (
      <section>
        <SectionTitle>Frontend Vercel</SectionTitle>
        <p className="text-sm text-[var(--color-text-muted)]">
          sem deploys ainda
        </p>
      </section>
    );
  }

  // history sempre traz o latest na primeira posição (vindo do backend).
  // Os subsequentes são o histórico.
  const previous = history.slice(1);

  return (
    <section className="space-y-3">
      <SectionTitle>Frontend Vercel</SectionTitle>
      {latest && <DeploymentCard deployment={latest} highlight />}
      {previous.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]">
            Histórico ({previous.length}){" "}
            <span className="ml-1 inline-block transition group-open:rotate-90">
              ›
            </span>
          </summary>
          <div className="mt-2 space-y-2">
            {previous.map((d, i) => (
              <DeploymentCard
                key={`${d.created_at ?? i}-${d.state}`}
                deployment={d}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function DeploymentCard({
  deployment,
  highlight,
}: {
  deployment: VercelDeploymentRow;
  highlight?: boolean;
}) {
  const url = deployment.prod_url ?? deployment.url;
  const href = url ? (url.startsWith("http") ? url : `https://${url}`) : null;
  const ts = deployment.ready_at ?? deployment.created_at;
  const buildLabel =
    deployment.build_ms != null
      ? `${(deployment.build_ms / 1000).toFixed(1)}s`
      : null;

  return (
    <div
      className={
        highlight
          ? "rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-card)] p-3"
          : "rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)]/40 p-3"
      }
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <VercelStatusBadge state={deployment.state} />
        {ts && (
          <span className="text-xs text-[var(--color-text-secondary)]">
            {formatRelative(new Date(ts))}
          </span>
        )}
        {buildLabel && (
          <span className="font-mono text-xs text-[var(--color-text-muted)]">
            · build {buildLabel}
          </span>
        )}
        {deployment.branch && (
          <span className="rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-text-secondary)]">
            {deployment.branch}
          </span>
        )}
      </div>
      {deployment.commit_msg && (
        <p
          className="mb-1 line-clamp-2 text-xs text-[var(--color-text-primary)]"
          title={deployment.commit_msg}
        >
          {deployment.commit_msg.split("\n")[0]}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 text-[10px] text-[var(--color-text-muted)]">
        <span className="font-mono">
          {deployment.author ? `por ${deployment.author}` : ""}
        </span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="truncate font-mono hover:text-[var(--color-accent-primary)]"
            title={url ?? undefined}
          >
            {url} ↗
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Containers ─────────────────────────────────────────────────────────────

function ContainersSection({
  containers,
  enabled,
  window: windowKey,
  onWindowChange,
  windowParams,
  onInvestigateContainer,
}: {
  containers: ContainerInfo[];
  enabled: boolean;
  window: WindowKey;
  onWindowChange: (w: WindowKey) => void;
  windowParams: { minutes: number; bucket: "1 minute" | "5 minutes" | "1 hour" | "1 day" | null };
  onInvestigateContainer?: (name: string) => void;
}) {
  if (containers.length === 0) {
    return (
      <section>
        <SectionTitle>Backend container</SectionTitle>
        <p className="text-sm text-[var(--color-text-muted)]">
          sem containers ativos
        </p>
      </section>
    );
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle>Backend container</SectionTitle>
        <TimeWindowSelector value={windowKey} onChange={onWindowChange} />
      </div>
      <p className="-mt-1 text-[10px] text-[var(--color-text-muted)]">
        Métricas — {WINDOW_LABELS[windowKey]}
      </p>
      <div className="space-y-5">
        {containers.map((c) => (
          <ContainerBlock
            key={c.name}
            container={c}
            enabled={enabled}
            windowParams={windowParams}
            onInvestigate={onInvestigateContainer}
          />
        ))}
      </div>
    </section>
  );
}

function ContainerBlock({
  container,
  enabled,
  windowParams,
  onInvestigate,
}: {
  container: ContainerInfo;
  enabled: boolean;
  windowParams: { minutes: number; bucket: "1 minute" | "5 minutes" | "1 hour" | "1 day" | null };
  onInvestigate?: (name: string) => void;
}) {
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);

  const fetchLogs = async () => {
    setLoadingLogs(true);
    setLogError(null);
    try {
      const text = await monitorApi.fetchLogs(container.name, 200);
      setLogs(text);
    } catch (e) {
      setLogError(String(e));
      setLogs(null);
    } finally {
      setLoadingLogs(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)]/40 p-3">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-[var(--color-text-primary)]">
          {container.name}
        </span>
        {onInvestigate && (
          <button
            onClick={() => onInvestigate(container.name)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
            title="Abre o modo análise focado neste container"
          >
            🔍 Investigar período
          </button>
        )}
        <span className="text-[10px] text-[var(--color-text-muted)]">
          {container.last_seen
            ? `visto ${formatRelative(new Date(container.last_seen))}`
            : "—"}
        </span>
      </div>

      <div className="mb-3 space-y-2">
        <UsageBar
          label="CPU agora"
          value={container.last_cpu_pct}
          max={100}
          formatValue={(v) => `${v.toFixed(1)}%`}
          formatMax={() => "100%"}
        />
        <UsageBar
          label="RAM agora"
          value={container.last_mem_used_bytes}
          max={container.last_mem_limit_bytes}
          formatValue={fmtBytes}
          formatMax={fmtBytes}
        />
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        <VmMetricChart
          title="CPU"
          source="container"
          resource={container.name}
          metric="cpu_pct"
          unit="%"
          windowMinutes={windowParams.minutes}
          bucket={windowParams.bucket}
          enabled={enabled}
          pollMs={5_000}
        />
        <VmMetricChart
          title="RAM"
          source="container"
          resource={container.name}
          metric="mem_pct"
          unit="%"
          windowMinutes={windowParams.minutes}
          bucket={windowParams.bucket}
          enabled={enabled}
          pollMs={5_000}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
            Logs
          </span>
          <button
            onClick={fetchLogs}
            disabled={loadingLogs}
            className="rounded-md bg-[var(--color-accent-primary)] px-3 py-1 text-xs font-semibold text-black transition hover:bg-[var(--color-accent-secondary)] disabled:opacity-50"
          >
            {loadingLogs
              ? "Carregando…"
              : logs
                ? "Recarregar"
                : "Ver últimos 200"}
          </button>
        </div>
        {logError && (
          <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-2 text-xs text-[var(--color-danger)]">
            {logError}
          </div>
        )}
        {logs !== null && (
          <pre className="max-h-72 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-3 font-mono text-[10px] leading-relaxed text-[var(--color-text-primary)]">
            {logs.length === 0 ? "(sem saída)" : logs}
          </pre>
        )}
      </div>
    </div>
  );
}

// ─── Endpoint ───────────────────────────────────────────────────────────────

function EndpointSection({ health }: { health: HealthCheckSummary }) {
  const isDown = health.last_ok === false;
  const isUnknown = health.last_ok === null;
  const statusColor = isDown
    ? "var(--color-danger)"
    : isUnknown
      ? "var(--color-text-muted)"
      : "var(--color-success)";

  const cells = [
    { label: "24h", value: health.uptime_24h },
    { label: "7d", value: health.uptime_7d },
    { label: "30d", value: health.uptime_30d },
  ];

  return (
    <section className="space-y-2">
      <SectionTitle>Endpoint público</SectionTitle>
      <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)]/40 p-3">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm" style={{ color: statusColor }}>
            {isUnknown
              ? "—"
              : isDown
                ? `✗ ${health.last_status_code ?? "down"}`
                : `${health.last_status_code ?? 200}`}
          </span>
          {health.last_response_ms != null && (
            <span className="font-mono text-xs text-[var(--color-text-secondary)]">
              · {health.last_response_ms}ms
            </span>
          )}
          {health.avg_response_ms_24h != null && Number.isFinite(health.avg_response_ms_24h) && (
            <span className="font-mono text-xs text-[var(--color-text-muted)]">
              · média 24h {Math.round(health.avg_response_ms_24h)}ms
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {cells.map((c) => (
            <div
              key={c.label}
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-2 text-center"
            >
              <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
                {c.label}
              </div>
              <div
                className="font-mono text-sm font-semibold"
                style={{
                  color:
                    c.value != null && Number.isFinite(c.value)
                      ? pickUptimeColor(c.value)
                      : "var(--color-text-muted)",
                }}
              >
                {c.value != null && Number.isFinite(c.value)
                  ? `${c.value.toFixed(2)}%`
                  : "—"}
              </div>
            </div>
          ))}
        </div>
        <p
          className="mt-3 truncate font-mono text-[10px] text-[var(--color-text-muted)]"
          title={health.endpoint}
        >
          {health.endpoint}
        </p>
      </div>
    </section>
  );
}

// ─── Segurança (CVEs por stack) ─────────────────────────────────────────────

const SEV_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};

function vulnBelongsToStack(
  vuln: VulnRow,
  stackName: string,
  containerNames: string[],
): boolean {
  if (vuln.kind === "advisory") return false; // cross-cutting, fica na aba Segurança
  const src = vuln.source_id.toLowerCase();
  const stack = stackName.toLowerCase();
  if (src.includes(stack)) return true;
  return containerNames.some((c) => src.includes(c.toLowerCase()));
}

function SecuritySection({
  stackName,
  containers,
  enabled,
}: {
  stackName: string;
  containers: ContainerInfo[];
  enabled: boolean;
}) {
  const [spawning, setSpawning] = useState(false);
  const [scanning, setScanning] = useState(false);

  const { data: vulns, refetch: refetchVulns } = usePolling(
    () =>
      monitorApi.listVulnerabilities({
        severities: ["critical", "high", "medium", "low"],
        kinds: ["deps", "image", "advisory"],
        search: "",
      }),
    30_000,
    enabled,
  );

  const containerNames = useMemo(
    () => containers.map((c) => c.name),
    [containers],
  );

  const stackVulns = useMemo(() => {
    if (!vulns) return null;
    return vulns
      .filter((v) => vulnBelongsToStack(v, stackName, containerNames))
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  }, [vulns, stackName, containerNames]);

  const counts = useMemo(() => {
    const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    if (!stackVulns) return c;
    for (const v of stackVulns) c[v.severity] += 1;
    return c;
  }, [stackVulns]);

  const handleInvestigate = async () => {
    if (!stackVulns || stackVulns.length === 0) return;
    setSpawning(true);
    try {
      const prompt = serializeSecurityGroup(stackName, stackVulns);
      const targetDir = resolveSecurityTargetDir(stackName);
      await monitorApi.spawnClaudeInvestigation(prompt, targetDir);
    } catch (e) {
      console.error("spawnClaudeInvestigation failed:", e);
    } finally {
      setSpawning(false);
    }
  };

  const handleRescan = async () => {
    setScanning(true);
    try {
      // Dispara ambos os scans (Trivy na VM + Dependabot via gh) e aguarda.
      // Nem todos os bytes ficam prontos imediatamente (Dependabot é GH Actions
      // assíncrono), mas o refetch já pega o que landed.
      await Promise.allSettled([
        monitorApi.triggerTrivyScan(),
        monitorApi.triggerDependabotScan(),
      ]);
      await refetchVulns();
    } finally {
      setScanning(false);
    }
  };

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <SectionTitle>Segurança</SectionTitle>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRescan}
            disabled={scanning || !enabled}
            title="Re-escanear Trivy (imagens) + Dependabot (deps). Refresh imediato após disparar."
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)] disabled:opacity-50"
          >
            {scanning ? "Scanning…" : "🔄 Re-escanear"}
          </button>
          {stackVulns && stackVulns.length > 0 && (
            <button
              onClick={handleInvestigate}
              disabled={spawning}
              title="Abrir Claude Code com contexto de todas as CVEs desta stack"
              className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)] disabled:opacity-50"
            >
              {spawning ? "Abrindo…" : "🤖 Investigar com Claude"}
            </button>
          )}
        </div>
      </div>

      {!stackVulns && (
        <p className="text-xs text-[var(--color-text-muted)]">carregando…</p>
      )}

      {stackVulns && stackVulns.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          🎉 Nenhuma CVE aberta nesta stack
        </p>
      )}

      {stackVulns && stackVulns.length > 0 && (
        <>
          <div className="flex flex-wrap gap-3 font-mono text-xs">
            <SevCount label="Critical" count={counts.critical} color="danger" />
            <SevCount label="High" count={counts.high} color="warning" />
            <SevCount label="Medium" count={counts.medium} color="accent-secondary" />
            <SevCount label="Low" count={counts.low} color="text-muted" />
          </div>
          <ul className="space-y-1.5">
            {stackVulns.slice(0, 12).map((v) => (
              <VulnLine key={`${v.source_id}:${v.cve_id ?? v.ghsa_id ?? v.package_name}:${v.last_seen}`} vuln={v} />
            ))}
          </ul>
          {stackVulns.length > 12 && (
            <p className="text-xs text-[var(--color-text-muted)]">
              … e mais {stackVulns.length - 12}. Use o botão Claude pra ver todas com plano de upgrade.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function SevCount({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: "danger" | "warning" | "accent-secondary" | "text-muted";
}) {
  return (
    <span>
      <span className="text-[var(--color-text-muted)]">{label}:</span>{" "}
      <span style={{ color: `var(--color-${color})` }}>{count}</span>
    </span>
  );
}

function VulnLine({ vuln }: { vuln: VulnRow }) {
  const id = vuln.cve_id ?? vuln.ghsa_id ?? "—";
  const sevColor: Record<string, string> = {
    critical: "var(--color-danger)",
    high: "var(--color-accent-primary)",
    medium: "var(--color-accent-secondary)",
    low: "var(--color-text-muted)",
    unknown: "var(--color-text-muted)",
  };
  return (
    <li className="flex items-baseline gap-2 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] px-2 py-1.5 text-xs">
      <span
        className="rounded-sm px-1 font-mono text-[9px] font-bold uppercase"
        style={{ color: sevColor[vuln.severity], borderColor: sevColor[vuln.severity] }}
      >
        {vuln.severity}
      </span>
      <span className="font-mono text-[10px] text-[var(--color-text-secondary)]">{id}</span>
      {vuln.package_name && (
        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
          {vuln.package_name}
        </span>
      )}
      <span className="truncate text-[var(--color-text-primary)]" title={vuln.title ?? ""}>
        {vuln.title ?? ""}
      </span>
      {vuln.url && (
        <a
          href={vuln.url}
          target="_blank"
          rel="noreferrer"
          className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-accent-primary)]"
          onClick={(e) => e.stopPropagation()}
        >
          ↗
        </a>
      )}
    </li>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
      {children}
    </h4>
  );
}
