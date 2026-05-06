import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { monitorApi, usePolling } from "../lib/monitor";
import type { MetricBucket, MetricPoint, MetricSource } from "../types/monitor";

interface Props {
  title: string;
  source: MetricSource;
  resource?: string | null;
  metric: string;
  unit?: string;
  windowMinutes: number;
  enabled: boolean;
  /** intervalo de polling (default 30s) */
  pollMs?: number;
  /** formatter custom pro Y-axis e tooltip */
  format?: (v: number) => string;
  /** agregação server-side (time_bucket); null = sem bucket, pontos crus */
  bucket?: MetricBucket;
  /**
   * Transform aplicado nos pontos depois do fetch e antes do render.
   * Útil pra derivar rate de counters cumulativos (ex: net_tx_bytes → MB/s).
   */
  transform?: (pts: MetricPoint[]) => MetricPoint[];
}

function formatTimeLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export function VmMetricChart({
  title,
  source,
  resource,
  metric,
  unit,
  windowMinutes,
  enabled,
  pollMs = 30_000,
  format,
  bucket = null,
  transform,
}: Props) {
  // sinceIso recalculado dentro do fetcher pra cada tick olhar a janela atual.
  const fetcher = () => {
    const sinceIso = new Date(
      Date.now() - windowMinutes * 60_000,
    ).toISOString();
    return monitorApi.metricSeries({
      source,
      resource,
      metric,
      sinceIso,
      bucket,
    });
  };

  const { data, error } = usePolling(fetcher, pollMs, enabled);

  const transformed = data && transform ? transform(data) : data;

  const chartData =
    transformed
      ?.filter((p) => p.value !== null)
      .map((p) => ({
        ts: new Date(p.ts).getTime(),
        value: p.value as number,
      })) ?? [];

  const fmt = format ?? ((v: number) => `${v.toFixed(1)}${unit ?? ""}`);

  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-secondary)]">
          {title}
        </span>
        {error && (
          <span className="text-xs text-[var(--color-danger)]">erro</span>
        )}
      </div>
      <div className="h-32">
        {chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-[var(--color-text-muted)]">
            {data === null ? "carregando…" : "sem dados na janela"}
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                stroke="var(--color-border-subtle)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatTimeLabel}
                stroke="var(--color-border-default)"
                tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
              />
              <YAxis
                tickFormatter={fmt}
                stroke="var(--color-border-default)"
                tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
                width={56}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--color-bg-secondary)",
                  border: "1px solid var(--color-border-default)",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelStyle={{ color: "var(--color-text-secondary)" }}
                labelFormatter={(t) =>
                  new Date(t as number).toLocaleString("pt-BR")
                }
                formatter={(v: number) => [fmt(v), title]}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent-primary)"
                fill="var(--color-accent-primary)"
                fillOpacity={0.18}
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
