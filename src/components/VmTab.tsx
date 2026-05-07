import { useCallback, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { toRate } from "../lib/metrics";
import { useTunnel } from "../lib/monitor";
import type { StackSummary, WindowKey } from "../types/monitor";
import { HealthChecksSection } from "./HealthChecksSection";
import { StackGrid } from "./StackGrid";
import { TimeWindowSelector, windowToParams } from "./TimeWindowSelector";
import { VmContainerDrawer } from "./VmContainerDrawer";
import { VmContainerGrid } from "./VmContainerGrid";
import { VmHeader } from "./VmHeader";
import { VmMetricChart } from "./VmMetricChart";

const WINDOW_LABELS: Record<WindowKey, string> = {
  "1h": "últimos 60 min",
  "6h": "últimas 6h",
  "24h": "últimas 24h",
  "7d": "últimos 7 dias",
  "30d": "últimos 30 dias",
};

export function VmTab() {
  const { ready, error } = useTunnel();
  const [selectedContainer, setSelectedContainer] = useState<string | null>(
    null,
  );
  const [vmWindow, setVmWindow] = useState<WindowKey>("1h");
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  const params = windowToParams(vmWindow);

  // Containers já agrupados em stacks (somem do grid cru).
  const groupedNames = stacks.flatMap((s) => s.container_names);

  const handleStacksChange = useCallback((next: StackSummary[]) => {
    setStacks(next);
  }, []);

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
        Erro ao conectar na VM: {error}
      </div>
    );
  }

  return (
    <>
      <div
        className="space-y-6 transition-[padding] duration-200"
        style={{ paddingRight: selectedContainer ? "32rem" : "0" }}
      >
        <VmHeader enabled={ready} />

        <HealthChecksSection enabled={ready} />

        <section>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-text-secondary)]">
            Stacks em produção
          </h2>
          <StackGrid enabled={ready} onStacksChange={handleStacksChange} />
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
              VM geral · {WINDOW_LABELS[vmWindow]}
            </h2>
            <TimeWindowSelector value={vmWindow} onChange={setVmWindow} />
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <VmMetricChart
              title="Load 1m"
              source="vm"
              metric="load_1m"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              format={(v) => v.toFixed(2)}
            />
            <VmMetricChart
              title="RAM usada"
              source="vm"
              metric="mem_used_bytes"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              format={(v) => `${(v / 1e9).toFixed(2)} GB`}
            />
            <VmMetricChart
              title="CPU"
              source="vm"
              metric="cpu_pct"
              unit="%"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
            />
            <VmMetricChart
              title="Disco usado"
              source="vm"
              metric="disk_used_bytes"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              format={(v) => `${(v / 1e9).toFixed(2)} GB`}
            />
            <VmMetricChart
              title="Network out (rate)"
              source="vm"
              metric="net_tx_bytes"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              transform={toRate}
              format={(v) => `${(v / 1e6).toFixed(2)} MB/s`}
            />
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
            Containers
          </h2>
          <VmContainerGrid
            enabled={ready}
            onSelect={setSelectedContainer}
            excludeNames={groupedNames}
          />
        </section>
      </div>

      <AnimatePresence>
        {selectedContainer && (
          <VmContainerDrawer
            key={selectedContainer}
            containerName={selectedContainer}
            enabled={ready}
            onClose={() => setSelectedContainer(null)}
          />
        )}
      </AnimatePresence>
    </>
  );
}
