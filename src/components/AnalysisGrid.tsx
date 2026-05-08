import { useMemo } from "react";
import { Responsive, WidthProvider } from "react-grid-layout";
import type { Layout } from "react-grid-layout";
import type { ChartSlot, MetricRef } from "../types/analysis";
import type { ContainerInfo, MetricBucket, MetricPoint } from "../types/monitor";
import { AnalysisChartSlot } from "./AnalysisChartSlot";

const ResponsiveGridLayout = WidthProvider(Responsive);

interface Props {
  charts: ChartSlot[];
  containers: ContainerInfo[];
  presetRange: { start: Date; end: Date };
  bucket: MetricBucket;
  brushRange: { start: Date; end: Date } | null;
  hoverTs: number | null;
  enabled: boolean;
  /** Atualiza posição/tamanho dos slots após drag/resize. */
  onLayoutChange: (charts: ChartSlot[]) => void;
  onMetricChange: (slotId: string, ref: MetricRef) => void;
  onRemove: (slotId: string) => void;
  onBrushChange: (range: { start: Date; end: Date } | null) => void;
  onHover: (ts: number | null) => void;
  onSeriesLoaded: (slotId: string, series: MetricPoint[]) => void;
}

const COLS = { lg: 12, md: 6, sm: 1 };
const BREAKPOINTS = { lg: 900, md: 600, sm: 0 };
const ROW_HEIGHT = 48;

export function AnalysisGrid({
  charts,
  containers,
  presetRange,
  bucket,
  brushRange,
  hoverTs,
  enabled,
  onLayoutChange,
  onMetricChange,
  onRemove,
  onBrushChange,
  onHover,
  onSeriesLoaded,
}: Props) {
  // Layouts por breakpoint:
  //   lg: usa coords salvos
  //   md: derivado (cada slot vira full-width 6 cols)
  //   sm: stack vertical 1 chart por vez (static — sem drag/resize em mobile)
  const layouts = useMemo(() => {
    const lg: Layout[] = charts.map((c) => ({
      i: c.id,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      minW: 3,
      minH: 3,
      maxW: 12,
      maxH: 8,
    }));
    const md: Layout[] = charts.map((c, idx) => ({
      i: c.id,
      x: 0,
      y: idx * 4,
      w: 6,
      h: 4,
      minW: 3,
      minH: 3,
      maxW: 6,
      maxH: 8,
    }));
    const sm: Layout[] = charts.map((c, idx) => ({
      i: c.id,
      x: 0,
      y: idx * 4,
      w: 1,
      h: 4,
      static: true,
    }));
    return { lg, md, sm };
  }, [charts]);

  const handleLayoutChange = (current: Layout[]) => {
    // Só persiste mudanças no breakpoint LG (single source of truth do schema).
    // Heurística: layout `lg` tem itens com `w > 6` ou todos `w === 12`.
    // Layout `md` tem `w === 6`. Layout `sm` é static (não dispara onChange).
    const isLg = current.some((it) => it.w > 6) || current.every((it) => it.w === 12);
    if (!isLg) return;
    const updated = charts.map((c) => {
      const lg = current.find((l) => l.i === c.id);
      if (!lg) return c;
      return { ...c, x: lg.x, y: lg.y, w: lg.w, h: lg.h };
    });
    onLayoutChange(updated);
  };

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      cols={COLS}
      breakpoints={BREAKPOINTS}
      rowHeight={ROW_HEIGHT}
      margin={[10, 10]}
      containerPadding={[0, 0]}
      onLayoutChange={handleLayoutChange}
      draggableHandle=".analysis-slot-drag-handle"
      draggableCancel=".analysis-no-drag"
      compactType="vertical"
      preventCollision={false}
    >
      {charts.map((slot) => (
        <div key={slot.id}>
          <AnalysisChartSlot
            slot={slot}
            containers={containers}
            presetRange={presetRange}
            bucket={bucket}
            brushRange={brushRange}
            hoverTs={hoverTs}
            enabled={enabled}
            onMetricChange={onMetricChange}
            onRemove={onRemove}
            onBrushChange={onBrushChange}
            onHover={onHover}
            onSeriesLoaded={onSeriesLoaded}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
