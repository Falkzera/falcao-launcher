import type { HealthCheckSummary } from "../types/monitor";
import { formatRelative, pickUptimeColor } from "../lib/format";

interface Props {
  summary: HealthCheckSummary;
}

export function HealthCheckRow({ summary }: Props) {
  const isDown = summary.last_ok === false;
  const isUnknown = summary.last_ok === null;

  return (
    <div
      className={`rounded-lg border p-3 transition ${
        isDown
          ? "border-2 border-[var(--color-danger)] bg-[var(--color-danger)]/5"
          : "border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)]"
      }`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot ok={summary.last_ok} />
          <span className="truncate font-mono text-xs text-[var(--color-text-primary)]">
            {summary.endpoint}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {isUnknown ? (
            <span className="text-[var(--color-text-tertiary)]">—</span>
          ) : isDown ? (
            <span className="font-mono text-[var(--color-danger)]">
              ✗ {summary.last_error ?? "down"}
            </span>
          ) : (
            <span className="font-mono text-[var(--color-success)]">
              ✓ {summary.last_response_ms}ms
            </span>
          )}
          <span className="text-[var(--color-text-tertiary)]">·</span>
          <span className="text-[var(--color-text-tertiary)]">
            {summary.last_ts ? formatRelative(new Date(summary.last_ts)) : "nunca"}
          </span>
        </div>
      </div>

      <div className="mt-2 flex gap-3 text-xs">
        <UptimePill label="24h" value={summary.uptime_24h} />
        <UptimePill label="7d" value={summary.uptime_7d} />
        <UptimePill label="30d" value={summary.uptime_30d} />
      </div>
    </div>
  );
}

function StatusDot({ ok }: { ok: boolean | null }) {
  const color =
    ok === true
      ? "var(--color-success)"
      : ok === false
        ? "var(--color-danger)"
        : "var(--color-text-tertiary)";
  return (
    <span
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: color }}
      aria-label={ok === true ? "ok" : ok === false ? "down" : "unknown"}
    />
  );
}

function UptimePill({ label, value }: { label: string; value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return (
      <span className="text-[var(--color-text-tertiary)]">
        {label}: —
      </span>
    );
  }
  const color = pickUptimeColor(value);
  return (
    <span>
      <span className="text-[var(--color-text-tertiary)]">{label}:</span>{" "}
      <span className="font-mono" style={{ color }}>
        {value.toFixed(2)}%
      </span>
    </span>
  );
}
