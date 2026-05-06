import type { ContainerInfo } from "../types/monitor";

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
      className="flex w-full flex-col gap-2 rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 text-left shadow-sm transition hover:border-[var(--color-accent-primary)]/40 hover:shadow-md"
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
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="uppercase tracking-wide text-[var(--color-text-secondary)]">
            CPU
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {container.last_cpu_pct !== null
              ? `${container.last_cpu_pct.toFixed(2)}%`
              : "—"}
          </div>
        </div>
        <div>
          <div className="uppercase tracking-wide text-[var(--color-text-secondary)]">
            RAM
          </div>
          <div className="font-mono text-[var(--color-text-primary)]">
            {container.last_mem_pct !== null
              ? `${container.last_mem_pct.toFixed(1)}%`
              : "—"}
          </div>
        </div>
      </div>
    </button>
  );
}
