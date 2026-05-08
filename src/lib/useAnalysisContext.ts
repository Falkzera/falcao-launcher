import { useMemo } from "react";
import type {
  AnalysisContext,
  AnalysisLayout,
  ChartSlot,
  LogsRangeResponse,
} from "../types/analysis";
import type { MetricBucket, MetricPoint, WindowKey } from "../types/monitor";

interface ChartSeries {
  slot: ChartSlot;
  bucket: MetricBucket;
  series: MetricPoint[];
}

interface UseAnalysisContextArgs {
  preset: WindowKey;
  presetRange: { start: Date; end: Date };
  brushRange: { start: Date; end: Date } | null;
  charts: ChartSeries[];
  logsContainer: string | null;
  lastFetchedLogs: {
    range: { start: Date; end: Date };
    container: string;
    response: LogsRangeResponse;
  } | null;
  layout: AnalysisLayout | null;
}

/**
 * Agrega o estado atual do AnalysisPage num formato serializável.
 * Sprint 4 (integração Claude) consome este hook pra montar prompt.
 *
 * Sem efeitos. Sem refs. Tudo passável a JSON.stringify.
 */
export function useAnalysisContext(args: UseAnalysisContextArgs): AnalysisContext {
  return useMemo<AnalysisContext>(() => {
    const range = args.brushRange ?? args.presetRange;
    return {
      range,
      preset: args.preset,
      charts: args.charts.map((c) => ({
        metric: c.slot.metric,
        bucket: c.bucket,
        series: c.series,
      })),
      logs: {
        container: args.logsContainer,
        fetched_for: args.lastFetchedLogs ? args.lastFetchedLogs.range : null,
        text: args.lastFetchedLogs ? args.lastFetchedLogs.response.text : null,
        truncated: args.lastFetchedLogs?.response.truncated ?? false,
      },
      layout: args.layout
        ? { id: args.layout.id, name: args.layout.name }
        : { id: null, name: null },
    };
  }, [
    args.preset,
    args.presetRange,
    args.brushRange,
    args.charts,
    args.logsContainer,
    args.lastFetchedLogs,
    args.layout,
  ]);
}
