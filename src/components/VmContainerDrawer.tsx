import { useState } from "react";
import { motion } from "framer-motion";
import { monitorApi } from "../lib/monitor";
import { slideInRight } from "../styles/animations";
import type { WindowKey } from "../types/monitor";
import { TimeWindowSelector, windowToParams } from "./TimeWindowSelector";
import { VmMetricChart } from "./VmMetricChart";

interface Props {
  containerName: string;
  enabled: boolean;
  onClose: () => void;
}

const WINDOW_LABELS: Record<WindowKey, string> = {
  "1h": "últimos 60 min",
  "6h": "últimas 6h",
  "24h": "últimas 24h",
  "7d": "últimos 7 dias",
  "30d": "últimos 30 dias",
};

export function VmContainerDrawer({
  containerName,
  enabled,
  onClose,
}: Props) {
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [drawerWindow, setDrawerWindow] = useState<WindowKey>("1h");
  const params = windowToParams(drawerWindow);

  const fetchLogs = async () => {
    setLoadingLogs(true);
    setLogError(null);
    try {
      const text = await monitorApi.fetchLogs(containerName, 200);
      setLogs(text);
    } catch (e) {
      setLogError(String(e));
      setLogs(null);
    } finally {
      setLoadingLogs(false);
    }
  };

  return (
    <motion.aside
      variants={slideInRight}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed top-0 right-0 z-30 flex h-full w-full max-w-2xl flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    >
      <header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            container
          </div>
          <h3 className="truncate font-mono text-base font-semibold text-[var(--color-text-primary)]">
            {containerName}
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

      <div className="flex-1 space-y-6 overflow-y-auto p-5">
        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Métricas · {WINDOW_LABELS[drawerWindow]}
            </h4>
            <TimeWindowSelector
              value={drawerWindow}
              onChange={setDrawerWindow}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <VmMetricChart
              title="CPU"
              source="container"
              resource={containerName}
              metric="cpu_pct"
              unit="%"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={enabled}
              pollMs={5_000}
            />
            <VmMetricChart
              title="RAM"
              source="container"
              resource={containerName}
              metric="mem_pct"
              unit="%"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={enabled}
              pollMs={5_000}
            />
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              Logs
            </h4>
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
            <div className="mb-2 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-2 text-xs text-[var(--color-danger)]">
              {logError}
            </div>
          )}
          {logs !== null && (
            <pre className="max-h-96 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-3 font-mono text-xs leading-relaxed text-[var(--color-text-primary)]">
              {logs.length === 0 ? "(sem saída)" : logs}
            </pre>
          )}
        </section>
      </div>
    </motion.aside>
  );
}
