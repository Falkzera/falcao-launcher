import { fmtBytes } from "../lib/format";
import type { ContainerInfo } from "../types/monitor";
import { UsageBar } from "./UsageBar";

interface Props {
  container: ContainerInfo;
  onClick: () => void;
}

export function VmContainerCard({ container, onClick }: Props) {
  const ageSec = container.last_seen
    ? Math.round((Date.now() - Date.parse(container.last_seen)) / 1000)
    : null;
  const stale = ageSec === null || ageSec > 60;

  return (
    <button
      onClick={onClick}
      className="flex w-full flex-col gap-3 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 text-left shadow-sm transition hover:border-[var(--color-accent-primary)]/40 hover:shadow-md"
    >
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 rounded-full"
          style={{
            background: stale
              ? "var(--color-danger)"
              : "var(--color-success)",
          }}
          aria-label={stale ? "stale" : "fresh"}
        />
        <span className="font-semibold text-[var(--color-text-primary)]">
          {container.name}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <UsageBar
          label="CPU"
          value={container.last_cpu_pct}
          max={100}
          formatValue={(v) => `${v.toFixed(1)}%`}
          formatMax={() => "100%"}
        />
        <UsageBar
          label="RAM"
          value={container.last_mem_used_bytes}
          max={container.last_mem_limit_bytes}
          formatValue={fmtBytes}
          formatMax={fmtBytes}
        />
      </div>
    </button>
  );
}
