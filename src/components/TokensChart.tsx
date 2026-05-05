// src/components/TokensChart.tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Granularity, TokenBucket } from "../types";
import { costUsd, formatCost, humanizeTokens, totalTokens } from "../lib/claudeCost";

type Props = {
  projectPath: string;
  model: string | null;
  granularity: Granularity;
};

function formatBucketLabel(ms: number, granularity: Granularity): string {
  const d = new Date(ms);
  if (granularity === "year") return String(d.getFullYear());
  if (granularity === "month") {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${m}/${String(d.getFullYear()).slice(2)}`;
  }
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function TokensChart({ projectPath, model, granularity }: Props) {
  const [buckets, setBuckets] = useState<TokenBucket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<TokenBucket[]>("aggregate_tokens", {
      projectPath,
      granularity,
    })
      .then((data) => {
        setBuckets(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("aggregate_tokens:", err);
        setLoading(false);
      });
  }, [projectPath, granularity]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-[var(--color-text-muted)]">
        carregando…
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-[var(--color-text-muted)]">
        sem dados nesse período
      </div>
    );
  }

  const data = buckets.map((b) => ({
    label: formatBucketLabel(b.bucket_start, granularity),
    tokens: totalTokens(b.usage),
    cost: costUsd(b.usage, model),
    raw: b,
  }));

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
            stroke="var(--color-border-default)"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
            stroke="var(--color-border-default)"
            tickFormatter={(v) => humanizeTokens(v as number)}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-bg-secondary)",
              border: "1px solid var(--color-border-default)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--color-text-secondary)" }}
            formatter={(value: number, _name, item) => {
              const cost = (item.payload as { cost: number }).cost;
              return [
                `${humanizeTokens(value)} ≡ ${formatCost(cost)}`,
                "tokens",
              ];
            }}
          />
          <Line
            type="monotone"
            dataKey="tokens"
            stroke="var(--color-claude-primary)"
            strokeWidth={2}
            dot={{ fill: "var(--color-claude-primary)", r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
