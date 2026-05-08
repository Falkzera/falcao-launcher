import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { fmtBytes, fmtBytesPerSec } from "../lib/format";
import { toRate } from "../lib/metrics";
import { useTunnel } from "../lib/monitor";
import type { MetricRef } from "../types/analysis";
import type { StackSummary, WindowKey } from "../types/monitor";
import { AnalysisPage } from "./AnalysisPage";
import { HealthChecksSection } from "./HealthChecksSection";
import { SettingsMenu } from "./SettingsMenu";
import { StackGrid } from "./StackGrid";
import { TimeWindowSelector, windowToParams } from "./TimeWindowSelector";
import { VmContainerDrawer } from "./VmContainerDrawer";
import { VmContainerGrid } from "./VmContainerGrid";
import { VmHeader } from "./VmHeader";
import { VmMetricChart } from "./VmMetricChart";

const SHOW_FRONTEND_ONLY_STACKS_KEY = "vm:show_frontend_only_stacks";

type VmView =
  | { kind: "dashboard" }
  | { kind: "analysis"; initialMetric: MetricRef; initialContainer: string | null };

const WINDOW_LABELS: Record<WindowKey, string> = {
  "1h": "últimos 60 min",
  "6h": "últimas 6h",
  "24h": "últimas 24h",
  "7d": "últimos 7 dias",
  "30d": "últimos 30 dias",
};

export function VmTab() {
  const { ready, error } = useTunnel();
  const [vmView, setVmView] = useState<VmView>({ kind: "dashboard" });
  const [selectedContainer, setSelectedContainer] = useState<string | null>(
    null,
  );
  const [vmWindow, setVmWindow] = useState<WindowKey>("1h");
  const [stacks, setStacks] = useState<StackSummary[]>([]);
  // Default false: stacks só-frontend (sem container na VM) ficam ocultas.
  // Decisão do Falcão: foco em projetos com backend na VM.
  const [showFrontendOnlyStacks, setShowFrontendOnlyStacks] = useState(() => {
    return localStorage.getItem(SHOW_FRONTEND_ONLY_STACKS_KEY) === "true";
  });
  const params = windowToParams(vmWindow);

  useEffect(() => {
    localStorage.setItem(
      SHOW_FRONTEND_ONLY_STACKS_KEY,
      String(showFrontendOnlyStacks),
    );
  }, [showFrontendOnlyStacks]);

  // Containers já agrupados em stacks (somem do grid cru).
  const groupedNames = stacks.flatMap((s) => s.container_names);

  const handleStacksChange = useCallback((next: StackSummary[]) => {
    setStacks(next);
  }, []);

  const enterAnalysis = useCallback(
    (metric: MetricRef, container: string | null = null) => {
      setSelectedContainer(null); // fecha drawer se aberto
      setVmView({ kind: "analysis", initialMetric: metric, initialContainer: container });
    },
    [],
  );

  if (vmView.kind === "analysis") {
    return (
      <AnalysisPage
        enabled={ready}
        initialMetric={vmView.initialMetric}
        initialContainer={vmView.initialContainer}
        onBack={() => setVmView({ kind: "dashboard" })}
      />
    );
  }

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
        {/* ─── BLOCO A · INFRA ───────────────────────────────────────── */}
        <MacroHeading>Infra</MacroHeading>

        <VmHeader enabled={ready} />

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
              onClick={() => enterAnalysis({ kind: "vm", metric: "load_1m" })}
            />
            <VmMetricChart
              title="RAM usada"
              source="vm"
              metric="mem_used_bytes"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              format={fmtBytes}
              onClick={() => enterAnalysis({ kind: "vm", metric: "mem_used_bytes" })}
            />
            <VmMetricChart
              title="CPU"
              source="vm"
              metric="cpu_pct"
              unit="%"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              onClick={() => enterAnalysis({ kind: "vm", metric: "cpu_pct" })}
            />
            <VmMetricChart
              title="Disco usado"
              source="vm"
              metric="disk_used_bytes"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              format={fmtBytes}
              onClick={() => enterAnalysis({ kind: "vm", metric: "disk_used_bytes" })}
            />
            <VmMetricChart
              title="Network out (rate)"
              source="vm"
              metric="net_tx_bytes"
              windowMinutes={params.minutes}
              bucket={params.bucket}
              enabled={ready}
              transform={toRate}
              format={fmtBytesPerSec}
              onClick={() => enterAnalysis({ kind: "vm", metric: "net_tx_bytes" })}
            />
          </div>
        </section>

        <HealthChecksSection enabled={ready} />

        {/* ─── BLOCO B · APLICAÇÕES ──────────────────────────────────── */}
        <MacroHeading className="!mt-10">Aplicações</MacroHeading>

        <section>
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-[var(--color-text-secondary)]">
              Stacks em produção
            </h2>
            <SettingsMenu
              groups={[
                {
                  title: "stacks",
                  toggles: [
                    {
                      key: "show_frontend_only",
                      label: "Mostrar stacks só-frontend",
                      hint: "Inclui projetos Vercel sem backend na VM (page-bea, public, sigof, etc.)",
                      checked: showFrontendOnlyStacks,
                      onChange: setShowFrontendOnlyStacks,
                    },
                  ],
                },
              ]}
            />
          </div>
          <StackGrid
            enabled={ready}
            onStacksChange={handleStacksChange}
            showFrontendOnly={showFrontendOnlyStacks}
            onInvestigateContainer={(name) =>
              enterAnalysis({ kind: "container", resource: name, metric: "cpu_pct" }, name)
            }
          />
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
            onInvestigate={(name) =>
              enterAnalysis({ kind: "container", resource: name, metric: "cpu_pct" }, name)
            }
          />
        )}
      </AnimatePresence>
    </>
  );
}

// Eyebrow tipográfico que separa os blocos macro (Infra / Aplicações).
// Sutil de propósito — o storytelling vem da ordem; isso só rotula.
function MacroHeading({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "font-mono text-[10px] uppercase tracking-[0.22em] text-[var(--color-text-muted)] " +
        className
      }
    >
      {children}
    </div>
  );
}
