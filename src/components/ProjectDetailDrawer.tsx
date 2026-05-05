import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "framer-motion";
import clsx from "clsx";
import { slideInRight } from "../styles/animations";
import { Tabs } from "./Tabs";
import { ClaudeTab } from "./ClaudeTab";
import type {
  ClaudeProjectState,
  LogLine,
  Project,
  ProjectStatus,
} from "../types";

type Props = {
  project: Project;
  status: ProjectStatus;
  port?: number;
  logs: LogLine[];
  claudeState: ClaudeProjectState | null;
  onClose: () => void;
  onClear: () => void;
};

const TAB_KEY = (id: string) => `falcao-launcher.drawerTab.${id}`;

export function ProjectDetailDrawer({
  project,
  status,
  port,
  logs,
  claudeState,
  onClose,
  onClear,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const [activeTab, setActiveTab] = useState<string>(() => {
    return localStorage.getItem(TAB_KEY(project.id)) ?? "logs";
  });

  useEffect(() => {
    localStorage.setItem(TAB_KEY(project.id), activeTab);
  }, [project.id, activeTab]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
    stickyRef.current = distFromBottom < 40;
  }

  useEffect(() => {
    if (activeTab !== "logs") return;
    if (!stickyRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [logs.length, activeTab]);

  return (
    <motion.aside
      variants={slideInRight}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed top-0 right-0 z-30 flex h-full w-[480px] flex-col border-l border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
    >
      <header className="flex items-center justify-between gap-2 border-b border-[var(--color-border-subtle)] px-4 py-3">
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
                      : status === "external"
                        ? "#38bdf8"
                        : "var(--color-text-secondary)",
              }}
            />
            <h2 className="page-title truncate text-base">{project.name}</h2>
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
          <div className="truncate text-xs text-[var(--color-text-secondary)]">
            {project.path.replace(/^.*\/Projects\//, "~/Projects/")}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {activeTab === "logs" && (
            <button
              onClick={onClear}
              className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)] hover:text-[var(--color-text-primary)]"
              title="Limpar logs"
            >
              clear
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded-md border border-[var(--color-border-default)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
            title="Fechar"
          >
            ✕
          </button>
        </div>
      </header>

      <Tabs
        tabs={[
          { key: "logs", label: "Logs" },
          { key: "claude", label: "Claude" },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === "logs" ? (
        <>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="flex-1 overflow-y-auto bg-[var(--color-bg-primary)] px-3 py-2 font-mono text-[12px] leading-relaxed"
          >
            {logs.length === 0 ? (
              <div className="py-8 text-center text-[var(--color-text-secondary)]">
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
                      : "text-[var(--color-text-primary)]/90",
                  )}
                >
                  {log.line}
                </div>
              ))
            )}
          </div>
          <footer className="border-t border-[var(--color-border-default)] px-4 py-2 text-[11px] text-[var(--color-text-secondary)]">
            {logs.length} linhas · stdout/stderr
          </footer>
        </>
      ) : (
        <ClaudeTab state={claudeState} projectPath={project.path} />
      )}
    </motion.aside>
  );
}
