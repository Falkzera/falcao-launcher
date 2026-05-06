import { useState } from "react";
import { useTunnel } from "../lib/monitor";
import { VmContainerGrid } from "./VmContainerGrid";
import { VmHeader } from "./VmHeader";
import { VmMetricChart } from "./VmMetricChart";

export function VmTab() {
  const { ready, error } = useTunnel();
  const [selectedContainer, setSelectedContainer] = useState<string | null>(
    null,
  );

  if (error) {
    return (
      <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-4 text-sm text-[var(--color-danger)]">
        Erro ao conectar na VM: {error}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <VmHeader enabled={ready} />

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          VM geral · últimos 60 min
        </h2>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <VmMetricChart
            title="Load 1m"
            source="vm"
            metric="load_1m"
            windowMinutes={60}
            enabled={ready}
            format={(v) => v.toFixed(2)}
          />
          <VmMetricChart
            title="RAM usada"
            source="vm"
            metric="mem_used_bytes"
            windowMinutes={60}
            enabled={ready}
            format={(v) => `${(v / 1e9).toFixed(2)} GB`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          Containers
        </h2>
        <VmContainerGrid enabled={ready} onSelect={setSelectedContainer} />
      </section>

      {selectedContainer && (
        <div className="text-sm text-[var(--color-text-secondary)]">
          (drawer pra detalhes de "{selectedContainer}" vem na Task D6)
        </div>
      )}
    </div>
  );
}
