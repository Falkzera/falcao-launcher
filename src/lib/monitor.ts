// Wrapper sobre os Tauri commands do monitor + hooks (useTunnel, usePolling).
// Tauri auto-converte camelCase (JS) -> snake_case (Rust) nos args; payloads
// de retorno mantêm snake_case do struct Rust (vide src/types/monitor.ts).

import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LogsRangeResponse } from "../types/analysis";
import type {
  ContainerInfo,
  HealthCheckSummary,
  MetricBucket,
  MetricPoint,
  MetricSource,
  StackDetail,
  StackSummary,
  VmStatus,
} from "../types/monitor";
import type {
  DismissedVuln,
  VulnFilters,
  VulnSummary,
  VulnerabilityRow,
} from "../types/security";
import type {
  CostHistoryPoint,
  CostUsage,
} from "../types/costs";

export const monitorApi = {
  openTunnel: () => invoke<number>("monitor_open_tunnel"),
  closeTunnel: () => invoke<void>("monitor_close_tunnel"),
  vmStatus: () => invoke<VmStatus>("monitor_vm_status"),
  listContainers: () => invoke<ContainerInfo[]>("monitor_list_containers"),
  metricSeries: (params: {
    source: MetricSource;
    resource?: string | null;
    metric: string;
    sinceIso: string;
    untilIso?: string | null;
    bucket?: MetricBucket;
  }) =>
    invoke<MetricPoint[]>("monitor_metric_series", {
      source: params.source,
      resource: params.resource ?? null,
      metric: params.metric,
      sinceIso: params.sinceIso,
      untilIso: params.untilIso ?? null,
      bucket: params.bucket ?? null,
    }),
  fetchLogs: (container: string, lines: number) =>
    invoke<string>("monitor_fetch_logs", { container, lines }),
  fetchLogsRange: (container: string, sinceIso: string, untilIso: string) =>
    invoke<LogsRangeResponse>("monitor_fetch_logs_range", {
      container,
      sinceIso,
      untilIso,
    }),
  // Spawn Claude Code com prompt pré-populado (Sprint 4). Tauri auto-converte
  // camelCase (JS) → snake_case (Rust) nos args.
  spawnClaudeInvestigation: (promptMarkdown: string, targetDir: string) =>
    invoke<void>("spawn_claude_investigation", {
      promptMarkdown,
      targetDir,
    }),
  healthSummary: () =>
    invoke<HealthCheckSummary[]>("monitor_health_summary"),
  listStacks: () => invoke<StackSummary[]>("monitor_list_stacks"),
  stackDetail: (name: string) =>
    invoke<StackDetail>("monitor_stack_detail", { name }),
  // Sprint B1 — Snyk-like
  listVulnerabilities: (filters: VulnFilters) =>
    invoke<VulnerabilityRow[]>("monitor_list_vulnerabilities", {
      severities: filters.severities,
      kinds: filters.kinds,
    }),
  vulnSummary: () => invoke<VulnSummary>("monitor_vuln_summary"),
  vulnCountByRepo: () =>
    invoke<Record<string, number>>("monitor_vuln_count_by_repo"),
  triggerTrivyScan: () => invoke<void>("trigger_trivy_scan_on_vm"),
  triggerDependabotScan: () =>
    invoke<void>("trigger_dependabot_scan_via_gh"),
  dismissCve: (cveKey: string, fixVersionAtTime: string | null) =>
    invoke<void>("dismiss_cve", { cveKey, fixVersionAtTime }),
  undismissCve: (cveKey: string) =>
    invoke<void>("undismiss_cve", { cveKey }),
  listDismissedCves: () =>
    invoke<Record<string, DismissedVuln>>("list_dismissed_cves"),
  // Sprint B1.5 — tokens trackeados (Vercel projects + container resources + stack labels)
  listTrackedTokens: () => invoke<string[]>("monitor_list_tracked_tokens"),
  // Sprint B3 — Custos multi-serviço
  costSummary: () => invoke<CostUsage[]>("monitor_cost_summary"),
  costHistory: (
    service: string,
    metric: string,
    sinceIso: string,
    untilIso: string,
  ) =>
    invoke<CostHistoryPoint[]>("monitor_cost_history", {
      service,
      metric,
      sinceIso,
      untilIso,
    }),
};

/**
 * Garante tunnel SSH aberto enquanto o componente está montado.
 * Fecha no unmount. Idempotente do lado Rust (TunnelManager dedupe).
 */
export function useTunnel(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    monitorApi
      .openTunnel()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      monitorApi.closeTunnel().catch(() => {});
    };
  }, []);

  return { ready, error };
}

/**
 * Polling helper genérico. Roda `fn` imediatamente e depois a cada `intervalMs`
 * enquanto `enabled` for true. A função é guardada num ref pra não ressubscrever
 * o intervalo a cada render do caller (que pode passar arrow funcs novas).
 *
 * `refetch()` força um tick imediato fora do schedule — útil após uma ação
 * que modifica os dados no servidor (ex: rescan) pra evitar esperar até 60s
 * pra UI refletir a mudança.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
): { data: T | null; error: string | null; refetch: () => Promise<void> } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  const cancelledRef = useRef(false);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    cancelledRef.current = false;

    const tick = () =>
      fnRef
        .current()
        .then((v) => {
          if (!cancelledRef.current) {
            setData(v);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelledRef.current) setError(String(e));
        });

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [intervalMs, enabled]);

  const refetch = useCallback(async () => {
    try {
      const v = await fnRef.current();
      if (!cancelledRef.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (!cancelledRef.current) setError(String(e));
    }
  }, []);

  return { data, error, refetch };
}
