import { useEffect, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import clsx from "clsx";
import type { LogLine, Project, ProjectStatus } from "../types";

type Props = {
  project: Project;
  status: ProjectStatus;
  port?: number;
  logs: LogLine[];
  onClose: () => void;
  onClear: () => void;
};

export function LogsDrawer({
  project,
  status,
  port,
  logs,
  onClose,
  onClear,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickyRef.current = distFromBottom < 40;
  }

  useEffect(() => {
    if (!stickyRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs.length]);

  return (
    <aside className="fixed top-0 right-0 z-30 flex h-full w-[480px] flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className={clsx(
                "h-2 w-2 rounded-full",
                status === "running" && "animate-pulse",
              )}
              style={{
                background:
                  status === "running"
                    ? "var(--color-success)"
                    : status === "crashed"
                      ? "var(--color-danger)"
                      : "var(--color-muted)",
              }}
            />
            <h2 className="truncate text-sm font-semibold">{project.name}</h2>
            {port && (
              <button
                onClick={() => openUrl(`http://localhost:${port}`).catch(() => {})}
                className="shrink-0 rounded-md bg-[var(--color-success-soft)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-success)] transition hover:opacity-80"
                title={`abrir http://localhost:${port}`}
              >
                :{port} ↗
              </button>
            )}
          </div>
          <div className="truncate text-xs text-[var(--color-muted)]">
            {project.path.replace(/^.*\/Projects\//, "~/Projects/")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={onClear}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] transition hover:border-[var(--color-accent)] hover:text-[var(--color-text)]"
            title="Limpar logs"
          >
            clear
          </button>
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-muted)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            title="Fechar"
          >
            ✕
          </button>
        </div>
      </header>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-[var(--color-bg)] px-3 py-2 font-mono text-[12px] leading-relaxed"
      >
        {logs.length === 0 ? (
          <div className="py-8 text-center text-[var(--color-muted)]">
            {status === "running"
              ? "aguardando primeira saída…"
              : "nenhum log ainda. clique em Run pra começar."}
          </div>
        ) : (
          logs.map((log, i) => (
            <div
              key={i}
              className={clsx(
                "whitespace-pre-wrap break-words",
                log.stream === "stderr"
                  ? "text-[var(--color-danger)]/90"
                  : "text-[var(--color-text)]/90",
              )}
            >
              {log.line}
            </div>
          ))
        )}
      </div>

      <footer className="border-t border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-muted)]">
        {logs.length} linhas · stdout/stderr
      </footer>
    </aside>
  );
}
