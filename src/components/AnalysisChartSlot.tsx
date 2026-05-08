import { useEffect, useState } from "react";
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatByMetricName } from "../lib/format";
import { monitorApi } from "../lib/monitor";
import type { ChartSlot, MetricRef } from "../types/analysis";
import type {
  ContainerInfo,
  MetricBucket,
  MetricPoint,
  MetricSource,
} from "../types/monitor";
import { InlineLoading } from "./Loading";
import { MetricPicker } from "./MetricPicker";

interface Props {
  slot: ChartSlot;
  containers: ContainerInfo[];
  /** Range já carregado do DB (definido pelo preset global). */
  presetRange: { start: Date; end: Date };
  /** Bucket pra agregação (varia por preset — vem do windowToParams). */
  bucket: MetricBucket;
  /** Brush selecionado globalmente (subset do presetRange). */
  brushRange: { start: Date; end: Date } | null;
  /** Crosshair sincronizado entre charts. null = sem hover. */
  hoverTs: number | null;
  enabled: boolean;
  onMetricChange: (slotId: string, ref: MetricRef) => void;
  onRemove: (slotId: string) => void;
  onBrushChange: (range: { start: Date; end: Date } | null) => void;
  onHover: (ts: number | null) => void;
  /** Notifica o pai dos pontos atualmente carregados (pro useAnalysisContext). */
  onSeriesLoaded: (slotId: string, series: MetricPoint[]) => void;
}

export function AnalysisChartSlot({
  slot,
  containers,
  presetRange,
  bucket,
  brushRange,
  hoverTs,
  enabled,
  onMetricChange,
  onRemove,
  onBrushChange,
  onHover,
  onSeriesLoaded,
}: Props) {
  const [series, setSeries] = useState<MetricPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch quando preset OU metric muda. Brush não dispara fetch.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setSeries(null);
    setError(null);

    const sinceIso = presetRange.start.toISOString();
    const untilIso = presetRange.end.toISOString();
    const { kind, metric } = slot.metric;
    const resource =
      slot.metric.kind === "container" ? slot.metric.resource : null;

    monitorApi
      .metricSeries({
        source: kind as MetricSource,
        resource,
        metric,
        sinceIso,
        untilIso,
        bucket: bucket ?? undefined,
      })
      .then((points) => {
        if (cancelled) return;
        setSeries(points);
        onSeriesLoaded(slot.id, points);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    presetRange.start.getTime(),
    presetRange.end.getTime(),
    slot.metric,
    bucket,
    slot.id,
    onSeriesLoaded,
  ]);

  // Brush UI: Recharts <Brush> emite startIndex/endIndex (índices no array).
  // Convertemos pra timestamps reais e propagamos via callback global.
  const handleBrushChange = (e: { startIndex?: number; endIndex?: number }) => {
    if (!series || e.startIndex == null || e.endIndex == null) return;
    if (e.startIndex === 0 && e.endIndex === series.length - 1) {
      onBrushChange(null); // brush cobrindo tudo = sem brush
      return;
    }
    const start = new Date(series[e.startIndex].ts);
    const end = new Date(series[e.endIndex].ts);
    onBrushChange({ start, end });
  };

  return (
    <div className="flex h-full flex-col rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3">
      {/* Header (drag handle) */}
      <div
        className="analysis-slot-drag-handle mb-2 flex cursor-move items-center justify-between gap-2"
        title="Arrastar pra mover (segure aqui)"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {/* Drag handle visual — Sprint 5 polish (decorativo; o handle real
              continua sendo a div .analysis-slot-drag-handle inteira) */}
          <span
            className="select-none text-base leading-none text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
            aria-hidden="true"
          >
            ⋮⋮
          </span>
          <MetricPicker
            value={slot.metric}
            onChange={(ref) => onMetricChange(slot.id, ref)}
            containers={containers}
          />
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(slot.id);
          }}
          className="analysis-no-drag rounded-md px-2 py-0.5 text-xs text-[var(--color-text-secondary)] transition hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
          aria-label="Remover chart"
          title="Remover"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {error ? (
          <ChartError error={error} />
        ) : series === null ? (
          <InlineLoading
            minHeight="100%"
            messages={["Carregando série", "Buscando dados", "Quase lá"]}
          />
        ) : series.length === 0 ? (
          <ChartEmpty />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={series.map((p) => ({
                ts: new Date(p.ts).getTime(),
                value: p.value,
              }))}
              onMouseMove={(state) => {
                if (state && state.activeLabel != null) {
                  onHover(Number(state.activeLabel));
                }
              }}
              onMouseLeave={() => onHover(null)}
            >
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="2 4"
              />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatTick}
                stroke="var(--color-text-muted)"
                fontSize={10}
              />
              <YAxis
                stroke="var(--color-text-muted)"
                fontSize={10}
                tickFormatter={(v: number) =>
                  formatByMetricName(slot.metric.metric, v)
                }
                width={64}
              />
              <Tooltip
                labelFormatter={(ts) =>
                  new Date(Number(ts)).toLocaleString("pt-BR")
                }
                formatter={(value: unknown) =>
                  formatByMetricName(slot.metric.metric, Number(value))
                }
                contentStyle={{
                  background: "var(--color-bg-secondary)",
                  border: "1px solid var(--color-border-subtle)",
                  fontSize: 11,
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent-primary)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              {hoverTs != null && (
                <ReferenceLine
                  x={hoverTs}
                  stroke="var(--color-accent-primary)"
                  strokeOpacity={0.5}
                  strokeDasharray="2 2"
                />
              )}
              {brushRange && (
                <ReferenceLine
                  x={brushRange.start.getTime()}
                  stroke="var(--color-success)"
                  strokeWidth={2}
                />
              )}
              {brushRange && (
                <ReferenceLine
                  x={brushRange.end.getTime()}
                  stroke="var(--color-success)"
                  strokeWidth={2}
                />
              )}
              <Brush
                dataKey="ts"
                height={20}
                stroke="var(--color-accent-primary)"
                fill="var(--color-bg-secondary)"
                tickFormatter={formatTick}
                onChange={handleBrushChange}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function formatTick(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function ChartError({ error }: { error: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center">
      <div>
        <div className="text-xs text-[var(--color-danger)]">Erro ao carregar</div>
        <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
          {error}
        </div>
      </div>
    </div>
  );
}

function ChartEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="text-xs text-[var(--color-text-muted)]">
        sem dados nesse período
      </div>
    </div>
  );
}
