// Wrapper sobre os Tauri commands do monitor + hooks (useTunnel, usePolling).
// Tauri auto-converte camelCase (JS) -> snake_case (Rust) nos args; payloads
// de retorno mantêm snake_case do struct Rust (vide src/types/monitor.ts).

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
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
  healthSummary: () =>
    invoke<HealthCheckSummary[]>("monitor_health_summary"),
  listStacks: () => invoke<StackSummary[]>("monitor_list_stacks"),
  stackDetail: (name: string) =>
    invoke<StackDetail>("monitor_stack_detail", { name }),
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
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = () =>
      fnRef
        .current()
        .then((v) => {
          if (!cancelled) {
            setData(v);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [intervalMs, enabled]);

  return { data, error };
}
