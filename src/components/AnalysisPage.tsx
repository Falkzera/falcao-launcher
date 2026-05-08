import { useCallback, useMemo, useState } from "react";
import { monitorApi, usePolling } from "../lib/monitor";
import { useAnalysisContext } from "../lib/useAnalysisContext";
import { useAnalysisLayouts } from "../lib/useAnalysisLayouts";
import {
  type ChartSlot,
  type LogsRangeResponse,
  type MetricRef,
} from "../types/analysis";
import type { ContainerInfo, MetricPoint, WindowKey } from "../types/monitor";
import { AnalysisGrid } from "./AnalysisGrid";
import { AnalysisLayoutPicker } from "./AnalysisLayoutPicker";
import { AnalysisLogsPanel } from "./AnalysisLogsPanel";
import { ClaudeInvestigationModal } from "./ClaudeInvestigationModal";
import { TimeWindowSelector, windowToParams } from "./TimeWindowSelector";

interface Props {
  enabled: boolean;
  initialMetric: MetricRef;
  initialContainer: string | null;
  onBack: () => void;
}

export function AnalysisPage({
  enabled,
  initialMetric,
  initialContainer,
  onBack,
}: Props) {
  // Containers pra MetricPicker e LogsPanel
  const { data: containers } = usePolling(monitorApi.listContainers, 30_000, enabled);
  const containerList: ContainerInfo[] = containers ?? [];

  // ─── State global ──────────────────────────────────────────────────────
  const [preset, setPreset] = useState<WindowKey>("1h");
  const [brushRange, setBrushRange] = useState<{ start: Date; end: Date } | null>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [charts, setCharts] = useState<ChartSlot[]>(() => [
    {
      id: crypto.randomUUID(),
      x: 0,
      y: 0,
      w: 12,
      h: 5,
      metric: initialMetric,
    },
  ]);
  const [chartSeriesById, setChartSeriesById] = useState<Record<string, MetricPoint[]>>({});
  const [lastFetchedLogs, setLastFetchedLogs] = useState<{
    range: { start: Date; end: Date };
    container: string;
    response: LogsRangeResponse;
  } | null>(null);

  // Layouts hook
  const layoutsApi = useAnalysisLayouts();

  // Preset → range derivado
  const params = windowToParams(preset);
  const presetRange = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - params.minutes * 60_000);
    return { start, end };
  }, [params.minutes]);

  const effectiveRange = brushRange ?? presetRange;

  // Context serializável (consumido pelo ClaudeInvestigationModal — Sprint 4)
  const analysisContext = useAnalysisContext({
    preset,
    presetRange,
    brushRange,
    charts: charts.map((slot) => ({
      slot,
      bucket: params.bucket,
      series: chartSeriesById[slot.id] ?? [],
    })),
    logsContainer: lastFetchedLogs?.container ?? null,
    lastFetchedLogs,
    layout: layoutsApi.currentLayout,
  });

  // Sprint 4: modal "Investigar com Claude"
  const [claudeModalOpen, setClaudeModalOpen] = useState(false);
  // Pronto pra investigar quando todos os charts retornaram série (mesmo vazia).
  const analysisReady = charts.every(
    (slot) => chartSeriesById[slot.id] !== undefined,
  );

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleAddChart = () => {
    setCharts((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        x: 0,
        y: prev.length * 5,
        w: 6,
        h: 4,
        metric: prev[0]?.metric ?? initialMetric,
      },
    ]);
  };

  const handleRemoveChart = (id: string) => {
    setCharts((prev) => {
      if (prev.length === 1) return prev; // não permite vazio
      return prev.filter((c) => c.id !== id);
    });
    setChartSeriesById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleMetricChange = (id: string, ref: MetricRef) => {
    setCharts((prev) => prev.map((c) => (c.id === id ? { ...c, metric: ref } : c)));
  };

  const handleSeriesLoaded = useCallback((id: string, series: MetricPoint[]) => {
    setChartSeriesById((prev) => ({ ...prev, [id]: series }));
  }, []);

  const handlePresetChange = (w: WindowKey) => {
    setPreset(w);
    setBrushRange(null);
  };

  // Layout: salvar/recuperar
  const handleSaveLayout = (name: string) => {
    layoutsApi.save(name, { default_preset: preset, charts });
  };

  const handleSelectLayout = (id: string | null) => {
    layoutsApi.setCurrent(id);
    if (id) {
      const l = layoutsApi.layouts.find((x) => x.id === id);
      if (l) {
        setCharts(l.charts);
        setPreset(l.default_preset);
        setBrushRange(null);
      }
    }
  };

  const handleImportLayout = async (file: File) => {
    try {
      const imported = await layoutsApi.importLayout(file);
      setCharts(imported.charts);
      setPreset(imported.default_preset);
      setBrushRange(null);
    } catch (e) {
      console.warn("import failed:", e);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5">
      {/* Top bar: voltar + layouts */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-1 text-sm text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
        >
          ← Voltar pra VM
        </button>
        <button
          onClick={() => setClaudeModalOpen(true)}
          disabled={!analysisReady}
          className="rounded-md border border-[var(--color-accent-primary)]/40 bg-[var(--color-bg-secondary)] px-3 py-1 text-sm text-[var(--color-accent-primary)] transition hover:bg-[var(--color-accent-primary)]/10 disabled:cursor-not-allowed disabled:opacity-40"
          title={analysisReady ? "Abrir Claude Code com este contexto" : "Aguardando dados…"}
        >
          🤖 Investigar com Claude
        </button>
        <AnalysisLayoutPicker
          layouts={layoutsApi.layouts}
          currentLayoutId={layoutsApi.currentLayout?.id ?? null}
          onSelect={handleSelectLayout}
          onSave={handleSaveLayout}
          onRename={(id, name) => layoutsApi.update(id, { name })}
          onDelete={layoutsApi.delete}
          onDuplicate={layoutsApi.duplicate}
          onExport={layoutsApi.exportLayout}
          onImport={handleImportLayout}
          errorMessage={layoutsApi.error}
        />
      </div>

      {/* Preset + brush info */}
      <div className="flex flex-wrap items-center gap-3 border-y border-[var(--color-border-subtle)] py-2">
        <TimeWindowSelector value={preset} onChange={handlePresetChange} />
        {brushRange && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[var(--color-text-secondary)]">
              brush: {brushRange.start.toLocaleTimeString("pt-BR")} →{" "}
              {brushRange.end.toLocaleTimeString("pt-BR")}
            </span>
            <button
              onClick={() => setBrushRange(null)}
              className="rounded-md border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] hover:border-[var(--color-accent-primary)]/60"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Charts em grid drag-drop (Phase D — AnalysisGrid responsivo) */}
      <AnalysisGrid
        charts={charts}
        containers={containerList}
        presetRange={presetRange}
        bucket={params.bucket}
        brushRange={brushRange}
        hoverTs={hoverTs}
        enabled={enabled}
        onLayoutChange={setCharts}
        onMetricChange={handleMetricChange}
        onRemove={handleRemoveChart}
        onBrushChange={setBrushRange}
        onHover={setHoverTs}
        onSeriesLoaded={handleSeriesLoaded}
      />
      <button
        onClick={handleAddChart}
        className="self-start rounded-md border border-dashed border-[var(--color-border-default)] px-4 py-2 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
      >
        + Adicionar chart
      </button>

      {/* Logs */}
      <AnalysisLogsPanel
        range={effectiveRange}
        containers={containerList}
        defaultContainer={initialContainer}
        onLogsFetched={setLastFetchedLogs}
      />

      {/* Sprint 4: modal "Investigar com Claude" */}
      <ClaudeInvestigationModal
        context={analysisContext}
        primaryMetric={charts[0]?.metric ?? initialMetric}
        open={claudeModalOpen}
        onClose={() => setClaudeModalOpen(false)}
      />
    </div>
  );
}
