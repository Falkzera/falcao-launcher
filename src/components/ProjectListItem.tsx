import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "framer-motion";
import clsx from "clsx";
import vscodeIcon from "../assets/vscode.png";
import ghosttyIcon from "../assets/ghostty.png";
import nautilusIcon from "../assets/nautilus.png";
import { SystemIcon } from "./SystemIcon";
import type { Project, ProjectStatus } from "../types";

type ExternalListener = { port: number; pid: number };

type Props = {
  project: Project;
  status: ProjectStatus;
  port?: number;
  externalListeners?: ExternalListener[];
  selected: boolean;
  onSelect: () => void;
  onConfigure: () => void;
  onToggleHidden: () => void;
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
  idle: "var(--color-text-secondary)",
  running: "var(--color-success)",
  crashed: "var(--color-danger)",
  external: "#38bdf8",
};

function accentFromName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 60%)`;
}

function shortBranch(branch: string): string {
  return branch.replace(/^worktree-/, "");
}

export function ProjectListItem({
  project,
  status,
  port,
  externalListeners = [],
  selected,
  onSelect,
  onConfigure,
  onToggleHidden,
}: Props) {
  const runnable = project.detected_script !== null;
  const isRunning = status === "running";
  const isExternal = status === "external";
  const canStop = isRunning || isExternal;
  const worktree = project.worktree;
  const monorepo = project.monorepo_parent;
  const familyKey = worktree?.parent_id ?? monorepo?.id ?? null;
  const familyAccent = familyKey ? accentFromName(familyKey) : null;
  const extraPorts = externalListeners
    .map((l) => l.port)
    .filter((p) => p !== port);

  async function handleAction(e: React.MouseEvent) {
    e.stopPropagation();
    if (isRunning) {
      try {
        await invoke("stop_project", { id: project.id });
      } catch (err) {
        console.error(err);
      }
      return;
    }
    if (isExternal) {
      const pids = Array.from(new Set(externalListeners.map((l) => l.pid)));
      for (const pid of pids) {
        try {
          await invoke("kill_pid", { pid });
        } catch (err) {
          console.error(`kill ${pid}:`, err);
        }
      }
      return;
    }
    if (!project.detected_script) return;
    try {
      await invoke("start_project", {
        id: project.id,
        path: project.path,
        script: project.detected_script,
        packageManager: project.package_manager,
      });
    } catch (err) {
      console.error(err);
    }
  }

  return (
    <motion.div
      layout
      onClick={onSelect}
      whileHover={{ scale: 1.002 }}
      style={
        familyAccent ? { borderLeft: `3px solid ${familyAccent}` } : undefined
      }
      className={clsx(
        "group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 backdrop-blur-md transition-colors",
        "bg-[var(--color-bg-card)]",
        selected && "border-[var(--color-accent-primary)]",
        !selected &&
          !project.hidden &&
          "border-[var(--color-border-subtle)] hover:border-[var(--color-accent-primary)]/50",
        project.hidden && [
          "border-dashed border-[var(--color-border-default)]",
          "opacity-60 saturate-50 hover:opacity-100 hover:saturate-100",
        ],
      )}
    >
      <span
        className={clsx(
          "h-2 w-2 shrink-0 rounded-full",
          isRunning && "animate-pulse shadow-[0_0_6px_var(--color-success)]",
          isExternal && "animate-pulse shadow-[0_0_6px_#38bdf8]",
        )}
        style={{ background: STATUS_COLORS[status] }}
      />
      {project.favicon_data_uri ? (
        <img
          src={project.favicon_data_uri}
          alt=""
          className="h-7 w-7 shrink-0 rounded object-contain"
        />
      ) : (
        <div className="h-7 w-7 shrink-0 rounded bg-[var(--color-bg-tertiary)]" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate text-sm font-semibold tracking-tight">
          <span className="truncate">{project.name}</span>
          {(worktree || monorepo) && (
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1 ring-[var(--color-border-default)]"
              aria-hidden
            >
              <span
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: familyAccent ?? "currentColor" }}
              />
              <span className="normal-case text-[var(--color-text-primary)]">
                {worktree ? shortBranch(worktree.branch) : monorepo?.name}
              </span>
            </span>
          )}
          {isExternal && (
            <span className="shrink-0 rounded bg-[#38bdf8]/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#38bdf8] ring-1 ring-[#38bdf8]/40">
              ext
            </span>
          )}
          {project.hidden && (
            <span className="shrink-0 rounded bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
              oculto
            </span>
          )}
        </div>
        <div className="truncate font-mono text-[10px] text-[var(--color-text-muted)]">
          {project.path.replace(/^.*\/Projects\//, "~/Projects/")}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-xs">
        {port && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              openUrl(`http://localhost:${port}`).catch(console.error);
            }}
            className={clsx(
              "rounded-md px-2 py-1 font-mono transition hover:opacity-80",
              isExternal
                ? "bg-[#38bdf8]/15 text-[#38bdf8]"
                : "bg-[var(--color-success-soft)] text-[var(--color-success)]",
            )}
          >
            :{port}
          </button>
        )}
        {extraPorts.map((p) => (
          <button
            key={p}
            onClick={(e) => {
              e.stopPropagation();
              openUrl(`http://localhost:${p}`).catch(console.error);
            }}
            className="rounded-md bg-[#38bdf8]/15 px-2 py-1 font-mono text-[#38bdf8] transition hover:opacity-80"
          >
            :{p}
          </button>
        ))}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggleHidden();
          }}
          title={project.hidden ? "voltar a mostrar" : "ocultar"}
          className="rounded-md p-1.5 text-[var(--color-text-secondary)] opacity-0 transition hover:bg-[var(--color-bg-primary)] group-hover:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {project.hidden ? (
              <>
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </>
            ) : (
              <>
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </svg>
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onConfigure();
          }}
          title="configurar"
          className="rounded-md p-1.5 text-[var(--color-text-secondary)] opacity-0 transition hover:bg-[var(--color-bg-primary)] group-hover:opacity-100"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await invoke("open_in_editor", { path: project.path });
            } catch (err) {
              console.error(err);
            }
          }}
          title="abrir no VSCode"
          className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
        >
          <SystemIcon name="visual-studio-code" fallback={vscodeIcon} className="h-4 w-4" />
        </button>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await invoke("open_in_terminal", { path: project.path });
            } catch (err) {
              console.error(err);
            }
          }}
          title="abrir terminal Ghostty"
          className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
        >
          <SystemIcon name="com.mitchellh.ghostty" fallback={ghosttyIcon} className="h-4 w-4" />
        </button>
        <button
          onClick={async (e) => {
            e.stopPropagation();
            try {
              await invoke("open_in_files", { path: project.path });
            } catch (err) {
              console.error(err);
            }
          }}
          title="abrir no Files (Nautilus)"
          className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
        >
          <SystemIcon name="org.gnome.Nautilus" fallback={nautilusIcon} className="h-4 w-4" />
        </button>
        <button
          onClick={handleAction}
          disabled={!runnable && !canStop}
          className={clsx(
            "rounded-lg px-2.5 py-1 text-xs font-semibold transition disabled:cursor-not-allowed disabled:bg-[var(--color-border-default)] disabled:text-[var(--color-text-secondary)]",
            !runnable && !canStop && "bg-[var(--color-border-default)]",
            canStop && "bg-[var(--color-danger)] text-white hover:opacity-90",
            runnable && !canStop && "bg-[var(--color-accent-primary)] text-black hover:opacity-90",
          )}
        >
          {canStop ? "Stop" : "Run"}
        </button>
      </div>
    </motion.div>
  );
}
