import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { monitorApi } from "../lib/monitor";
import {
  formatCostValue,
  SERVICE_LABEL,
  type CostHistoryPoint,
  type CostService,
  type CostUnit,
  type CostUsage,
} from "../types/costs";

interface Props {
  /** Lista atual de métricas (pra popular o selectbox). */
  summary: CostUsage[];
  /** Habilitado quando o tunnel está pronto. */
  ready: boolean;
}

export function CostHistoryChart({ summary, ready }: Props) {
  const [selected, setSelected] = useState<{
    service: CostService;
    metric: string;
    unit: CostUnit;
  } | null>(null);
  const [points, setPoints] = useState<CostHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selected || summary.length === 0) return;
    const alarmed = summary.find((m) => (m.pct ?? 0) >= 70);
    const bandwidth = summary.find(
      (m) => m.service === "vercel" && m.metric === "bandwidth_bytes",
    );
    const fallback = alarmed ?? bandwidth ?? summary[0];
    setSelected({
      service: fallback.service,
      metric: fallback.metric,
      unit: fallback.unit,
    });
  }, [summary, selected]);

  useEffect(() => {
    if (!ready || !selected) return;
    let cancelled = false;
    const until = new Date();
    const since = new Date(until.getTime() - 30 * 24 * 3600 * 1000);
    setLoading(true);
    monitorApi
      .costHistory(selected.service, selected.metric, since.toISOString(), until.toISOString())
      .then((data) => {
        if (!cancelled) setPoints(data);
      })
      .catch((e) => console.warn("costHistory failed:", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, selected]);

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        ts: new Date(p.ts).getTime(),
        value: p.value,
      })),
    [points],
  );

  const yFmt = useMemo(() => {
    if (!selected) return (v: number) => String(v);
    return (v: number) => formatCostValue(v, selected.unit);
  }, [selected]);

  return (
    <section className="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-[var(--color-text-primary)]">
          Histórico (30 dias)
        </h3>
        <select
          value={selected ? `${selected.service}::${selected.metric}` : ""}
          onChange={(e) => {
            const [service, metric] = e.target.value.split("::") as [CostService, string];
            const m = summary.find((x) => x.service === service && x.metric === metric);
            if (m) setSelected({ service, metric, unit: m.unit });
          }}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs"
        >
          {summary.map((m) => (
            <option key={`${m.service}::${m.metric}`} value={`${m.service}::${m.metric}`}>
              {SERVICE_LABEL[m.service]} · {m.metric}
            </option>
          ))}
        </select>
      </header>

      <div className="h-56 w-full">
        {loading && (
          <p className="text-xs text-[var(--color-text-muted)]">carregando…</p>
        )}
        {!loading && chartData.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">
            sem dados ainda — primeira amostra chega em até 1h
          </p>
        )}
        {!loading && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => new Date(t).toLocaleDateString("pt-BR", { month: "short", day: "2-digit" })}
                stroke="var(--color-text-muted)"
                fontSize={10}
              />
              <YAxis tickFormatter={yFmt} stroke="var(--color-text-muted)" fontSize={10} width={70} />
              <Tooltip
                labelFormatter={(t) => new Date(t).toLocaleString("pt-BR")}
                formatter={(v: number) => yFmt(v)}
                contentStyle={{
                  background: "var(--color-bg-card)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 6,
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent-primary)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
