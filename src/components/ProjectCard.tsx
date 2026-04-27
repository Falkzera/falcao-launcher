import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";
import vscodeIcon from "../assets/vscode.png";
import ghosttyIcon from "../assets/ghostty.png";
import { SystemIcon } from "./SystemIcon";
import { cardHover, cardVariants } from "../styles/animations";
import type { Project, ProjectStatus } from "../types";

type Props = {
  project: Project;
  status: ProjectStatus;
  port?: number;
  selected: boolean;
  onSelect: () => void;
  onConfigure: () => void;
  onToggleHidden: () => void;
};

function initials(name: string): string {
  const parts = name.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function colorFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 55% 45%)`;
}

const STATUS_COLORS: Record<ProjectStatus, string> = {
  idle: "var(--color-text-secondary)",
  running: "var(--color-success)",
  crashed: "var(--color-danger)",
};

export function ProjectCard({
  project,
  status,
  port,
  selected,
  onSelect,
  onConfigure,
  onToggleHidden,
}: Props) {
  const runnable = project.detected_script !== null;
  const isRunning = status === "running";

  async function handleAction(e: React.MouseEvent) {
    e.stopPropagation();
    if (!project.detected_script) return;
    try {
      if (isRunning) {
        await invoke("stop_project", { id: project.id });
      } else {
        await invoke("start_project", {
          id: project.id,
          path: project.path,
          script: project.detected_script,
          packageManager: project.package_manager,
        });
      }
    } catch (err) {
      console.error(err);
    }
  }

  async function handleOpenPort(e: React.MouseEvent) {
    e.stopPropagation();
    if (port) {
      try {
        await openUrl(`http://localhost:${port}`);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function handleConfigure(e: React.MouseEvent) {
    e.stopPropagation();
    onConfigure();
  }

  function handleToggleHidden(e: React.MouseEvent) {
    e.stopPropagation();
    onToggleHidden();
  }

  async function handleOpenEditor(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("open_in_editor", { path: project.path });
    } catch (err) {
      console.error(err);
    }
  }

  async function handleOpenTerminal(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("open_in_terminal", { path: project.path });
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <motion.div
      layout
      variants={cardVariants}
      whileHover={cardHover.whileHover}
      transition={cardHover.transition}
      onClick={onSelect}
      className={clsx(
        "group relative cursor-pointer rounded-2xl border p-4 backdrop-blur-md transition-colors",
        "bg-[var(--color-bg-card)] shadow-[0_4px_12px_rgba(0,0,0,0.18)]",
        selected && "border-[var(--color-accent-primary)]",
        !selected && !project.hidden &&
          "border-[var(--color-border-subtle)] hover:border-[var(--color-accent-primary)]/50",
        project.hidden && [
          "border-dashed border-[var(--color-border-default)]",
          "bg-[var(--color-bg-secondary)]/40 opacity-60 saturate-50",
          "hover:opacity-100 hover:saturate-100",
        ],
      )}
    >
      {project.hidden && (
        <span
          className="pointer-events-none absolute -top-2 left-4 rounded-md bg-[var(--color-bg-tertiary)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] ring-1 ring-[var(--color-border-default)]"
          aria-hidden
        >
          oculto
        </span>
      )}
      <div className="flex items-center gap-3">
        {project.favicon_data_uri ? (
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-bg-primary)]">
            <img
              src={project.favicon_data_uri}
              alt=""
              className="h-10 w-10 object-contain"
            />
          </div>
        ) : (
          <div
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg text-base font-semibold text-white"
            style={{ background: colorFromName(project.name) }}
          >
            {initials(project.name)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold tracking-tight">
            {project.name}
          </div>
          <div className="truncate font-mono text-[11px] text-[var(--color-text-muted)]">
            {project.path.replace(/^.*\/Projects\//, "~/Projects/")}
          </div>
        </div>
        <button
          onClick={handleToggleHidden}
          title={project.hidden ? "voltar a mostrar" : "ocultar projeto"}
          className="opacity-0 transition group-hover:opacity-100 text-[var(--color-text-secondary)] hover:text-[var(--color-accent-primary)]"
          aria-label={project.hidden ? "voltar a mostrar" : "ocultar projeto"}
        >
          {project.hidden ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
        <button
          onClick={handleConfigure}
          title="configurar portas"
          className="opacity-0 transition group-hover:opacity-100 text-[var(--color-text-secondary)] hover:text-[var(--color-accent-primary)]"
          aria-label="configurar portas"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <span
          className={clsx(
            "h-2.5 w-2.5 rounded-full transition",
            isRunning && "animate-pulse shadow-[0_0_8px_var(--color-success)]",
          )}
          style={{ background: STATUS_COLORS[status] }}
          title={status}
        />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          {project.has_package_json ? (
            runnable ? (
              <span className="truncate rounded-md bg-[var(--color-accent-soft)] px-2 py-1 font-mono text-[var(--color-accent-primary)]">
                {project.package_manager}{" "}
                {project.package_manager === "yarn"
                  ? project.detected_script
                  : `run ${project.detected_script}`}
              </span>
            ) : (
              <span>sem script padrão</span>
            )
          ) : (
            <span>sem package.json</span>
          )}
          {port && (
            <button
              onClick={handleOpenPort}
              className="shrink-0 rounded-md bg-[var(--color-success-soft)] px-2 py-1 font-mono text-[var(--color-success)] transition hover:opacity-80"
              title={`abrir http://localhost:${port}`}
            >
              :{port} ↗
            </button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={handleOpenEditor}
            title="abrir no VSCode"
            aria-label="abrir no VSCode"
            className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
          >
            <SystemIcon
              name="visual-studio-code"
              fallback={vscodeIcon}
              className="h-4 w-4"
            />
          </button>
          <button
            onClick={handleOpenTerminal}
            title="abrir terminal Ghostty"
            aria-label="abrir terminal Ghostty"
            className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
          >
            <SystemIcon
              name="com.mitchellh.ghostty"
              fallback={ghosttyIcon}
              className="h-4 w-4"
            />
          </button>
          <motion.button
            onClick={handleAction}
            disabled={!runnable}
            whileHover={!runnable ? undefined : { scale: 1.02 }}
            whileTap={!runnable ? undefined : { scale: 0.96 }}
            className={clsx(
              "relative isolate overflow-hidden rounded-xl px-3 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:bg-[var(--color-border-default)] disabled:text-[var(--color-text-secondary)]",
              !runnable && "bg-[var(--color-border-default)]",
              runnable && (isRunning ? "text-white" : "text-black"),
            )}
          >
            <AnimatePresence initial={false} mode="sync">
              <motion.span
                key={isRunning ? "stop" : "run"}
                aria-hidden
                className={clsx(
                  "absolute inset-0 -z-10",
                  isRunning
                    ? "bg-[var(--color-danger)]"
                    : "bg-[var(--color-accent-primary)]",
                )}
                initial={{ clipPath: "circle(0% at 50% 50%)" }}
                animate={{ clipPath: "circle(150% at 50% 50%)" }}
                exit={{ clipPath: "circle(0% at 50% 50%)" }}
                transition={{ duration: 0.45, ease: [0.4, 0, 0.2, 1] }}
              />
            </AnimatePresence>
            <span className="relative z-10">
              {isRunning ? "Stop" : "Run"}
            </span>
          </motion.button>
        </div>
      </div>
    </motion.div>
  );
}
