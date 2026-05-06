import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "framer-motion";
import { ProjectCard } from "./components/ProjectCard";
import { ProjectListItem } from "./components/ProjectListItem";
import { ProjectDetailDrawer } from "./components/ProjectDetailDrawer";
import { ProjectConfigModal } from "./components/ProjectConfigModal";
import { AddProjectModal } from "./components/AddProjectModal";
import { SettingsMenu } from "./components/SettingsMenu";
import { SkillsView } from "./components/SkillsView";
import { containerVariants } from "./styles/animations";
import type {
  AllocatedPortsPayload,
  ClaudeProjectState,
  LogLine,
  LogPayload,
  PortPayload,
  Project,
  ProjectStatus,
  StatusPayload,
  SystemListener,
} from "./types";
import "./App.css";

const MAX_LOG_LINES = 5000;
const AUTO_OPEN_KEY = "falcao-launcher.autoOpenBrowser";
const SHOW_HIDDEN_KEY = "falcao-launcher.showHidden";
const SHOW_OFFLINE_WORKTREES_KEY = "falcao-launcher.showOfflineWorktrees";
const VIEW_MODE_KEY = "falcao-launcher.viewMode";
const TOP_VIEW_KEY = "falcao-launcher.topView";

type TopView = "projects" | "skills";

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [ports, setPorts] = useState<Record<string, number>>({});
  const [systemPorts, setSystemPorts] = useState<SystemListener[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [autoOpen, setAutoOpen] = useState(() => {
    const saved = localStorage.getItem(AUTO_OPEN_KEY);
    return saved === null ? true : saved === "true";
  });
  const [showHidden, setShowHidden] = useState(() => {
    return localStorage.getItem(SHOW_HIDDEN_KEY) === "true";
  });
  const [showOfflineWorktrees, setShowOfflineWorktrees] = useState(() => {
    return localStorage.getItem(SHOW_OFFLINE_WORKTREES_KEY) === "true";
  });
  const [viewMode, setViewMode] = useState<"grid" | "list">(() => {
    const saved = localStorage.getItem(VIEW_MODE_KEY);
    return saved === "list" ? "list" : "grid";
  });
  const [topView, setTopView] = useState<TopView>(() => {
    return localStorage.getItem(TOP_VIEW_KEY) === "skills" ? "skills" : "projects";
  });
  const [addingPath, setAddingPath] = useState(false);
  const [claudeStates, setClaudeStates] = useState<ClaudeProjectState[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const seqRef = useRef(0);
  const autoOpenRef = useRef(autoOpen);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    autoOpenRef.current = autoOpen;
    localStorage.setItem(AUTO_OPEN_KEY, String(autoOpen));
  }, [autoOpen]);

  useEffect(() => {
    localStorage.setItem(SHOW_HIDDEN_KEY, String(showHidden));
  }, [showHidden]);

  useEffect(() => {
    localStorage.setItem(
      SHOW_OFFLINE_WORKTREES_KEY,
      String(showOfflineWorktrees),
    );
  }, [showOfflineWorktrees]);

  useEffect(() => {
    localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  useEffect(() => {
    localStorage.setItem(TOP_VIEW_KEY, topView);
  }, [topView]);

  async function refreshProjects() {
    try {
      const data = await invoke<Project[]>("scan_projects");
      setProjects(data);
    } catch (err) {
      setError(String(err));
    }
  }

  async function handleToggleHidden(id: string, current: boolean) {
    try {
      await invoke("set_project_hidden", { id, hidden: !current });
      await refreshProjects();
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    invoke<Project[]>("scan_projects")
      .then((data) => {
        setProjects(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(String(err));
        setLoading(false);
      });

    invoke<string[]>("running_ids")
      .then((ids) => {
        setStatuses((prev) => {
          const next = { ...prev };
          ids.forEach((id) => {
            next[id] = "running";
          });
          return next;
        });
      })
      .catch(() => {});

    invoke<SystemListener[]>("list_system_ports")
      .then(setSystemPorts)
      .catch(() => {});

    invoke<ClaudeProjectState[]>("claude_snapshot")
      .then(setClaudeStates)
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlistenLog = listen<LogPayload>("log", (event) => {
      const { id, stream, line } = event.payload;
      seqRef.current += 1;
      const entry: LogLine = { stream, line, ts: seqRef.current };
      setLogs((prev) => {
        const existing = prev[id] ?? [];
        const next = [...existing, entry];
        if (next.length > MAX_LOG_LINES) {
          next.splice(0, next.length - MAX_LOG_LINES);
        }
        return { ...prev, [id]: next };
      });
    });

    const unlistenStatus = listen<StatusPayload>("status", (event) => {
      const { id, status } = event.payload;
      setStatuses((prev) => ({
        ...prev,
        [id]:
          status === "running"
            ? "running"
            : status === "crashed"
              ? "crashed"
              : "idle",
      }));
      if (status !== "running") {
        setPorts((prev) => {
          if (!(id in prev)) return prev;
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    });

    const unlistenPort = listen<PortPayload>("port", (event) => {
      const { id, port, url } = event.payload;
      setPorts((prev) => ({ ...prev, [id]: port }));
      if (autoOpenRef.current) {
        openUrl(url).catch((err) => console.error("openUrl failed:", err));
      }
    });

    const unlistenAllocated = listen<AllocatedPortsPayload>(
      "port-allocated",
      (event) => {
        const { id, frontend_port, backend_port } = event.payload;
        const preview = frontend_port ?? backend_port;
        if (preview != null) {
          setPorts((prev) => (id in prev ? prev : { ...prev, [id]: preview }));
        }
      },
    );

    const unlistenSystem = listen<SystemListener[]>(
      "system-ports",
      (event) => {
        setSystemPorts(event.payload);
      },
    );

    const unlistenClaude = listen<ClaudeProjectState[]>(
      "claude-state",
      (event) => {
        setClaudeStates(event.payload);
      },
    );

    return () => {
      unlistenLog.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
      unlistenPort.then((fn) => fn());
      unlistenAllocated.then((fn) => fn());
      unlistenSystem.then((fn) => fn());
      unlistenClaude.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isTextInput =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement;
      if (e.key === "Escape") {
        if (isTextInput && (e.target as HTMLInputElement).value === "") {
          (e.target as HTMLInputElement).blur();
        } else if (selected) {
          setSelected(null);
        } else if (isTextInput) {
          setQuery("");
        }
      }
      if (
        (e.key === "/" || (e.key === "k" && (e.ctrlKey || e.metaKey))) &&
        !isTextInput
      ) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const externalByProject = useMemo(() => {
    const sorted = [...projects].sort((a, b) => b.path.length - a.path.length);
    const map: Record<string, Array<{ port: number; pid: number }>> = {};
    for (const listener of systemPorts) {
      if (!listener.cwd) continue;
      const match = sorted.find(
        (p) =>
          listener.cwd === p.path ||
          listener.cwd!.startsWith(p.path + "/"),
      );
      if (match) {
        (map[match.id] ??= []).push({
          port: listener.port,
          pid: listener.pid,
        });
      }
    }
    return map;
  }, [systemPorts, projects]);

  const claudeByProjectPath = useMemo(() => {
    const map: Record<string, ClaudeProjectState> = {};
    for (const s of claudeStates) {
      map[s.project_path] = s;
    }
    return map;
  }, [claudeStates]);

  const filteredProjects = useMemo(() => {
    let list = projects;
    if (!showHidden) {
      list = list.filter((p) => !p.hidden);
    }
    if (!showOfflineWorktrees) {
      list = list.filter((p) => {
        if (!p.worktree) return true;
        const launcherStatus = statuses[p.id] ?? "idle";
        if (launcherStatus === "running" || launcherStatus === "crashed")
          return true;
        if ((externalByProject[p.id]?.length ?? 0) > 0) return true;
        return false;
      });
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [projects, query, showHidden, showOfflineWorktrees, statuses, externalByProject]);

  const hiddenCount = useMemo(
    () => projects.filter((p) => p.hidden).length,
    [projects],
  );

  const offlineWorktreeCount = useMemo(
    () =>
      projects.filter((p) => {
        if (!p.worktree) return false;
        const launcherStatus = statuses[p.id] ?? "idle";
        if (launcherStatus === "running" || launcherStatus === "crashed")
          return false;
        if ((externalByProject[p.id]?.length ?? 0) > 0) return false;
        return true;
      }).length,
    [projects, statuses, externalByProject],
  );

  const selectedProject = selected
    ? (projects.find((p) => p.id === selected) ?? null)
    : null;

  const drawerOpen = selectedProject !== null;
  const runningCount = Object.values(statuses).filter(
    (s) => s === "running",
  ).length;
  const externalCount = Object.keys(externalByProject).filter(
    (id) => (statuses[id] ?? "idle") === "idle",
  ).length;

  return (
    <main
      className="min-h-screen transition-[padding] duration-200"
      style={{ paddingRight: drawerOpen && topView === "projects" ? "480px" : "0" }}
    >
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex items-center gap-1 border-b border-[var(--color-border-subtle)]">
          {(["projects", "skills"] as TopView[]).map((v) => {
            const isActive = topView === v;
            const label = v === "projects" ? "Projetos" : "Skills";
            return (
              <button
                key={v}
                onClick={() => setTopView(v)}
                className={
                  isActive
                    ? "relative px-4 py-2 text-sm font-semibold text-[var(--color-text-primary)]"
                    : "relative px-4 py-2 text-sm font-semibold text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)]"
                }
              >
                {label}
                {isActive && (
                  <motion.span
                    layoutId="top-view-underline"
                    className="absolute bottom-[-1px] left-3 right-3 h-[2px] bg-[var(--color-accent-primary)]"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}
              </button>
            );
          })}
        </div>

        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="page-title text-3xl">
              {topView === "projects" ? "Falcão Launcher" : "Skills"}
            </h1>
            <p className="mt-1 text-sm font-light text-[var(--color-text-secondary)]">
              {topView === "projects"
                ? loading
                  ? "Scanning ~/Projects…"
                  : `${projects.length} projects · ${runningCount} running${externalCount > 0 ? ` · ${externalCount} externos` : ""}${offlineWorktreeCount > 0 && !showOfflineWorktrees ? ` · ${offlineWorktreeCount} worktrees offline` : ""}${hiddenCount > 0 && !showHidden ? ` · ${hiddenCount} ocultos` : ""}`
                : "skills instaladas em ~/.claude/"}
            </p>
          </div>
          <div className={topView === "projects" ? "flex items-center gap-2" : "hidden"}>
            <div className="relative">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar…  (/)"
                className="w-64 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm placeholder:text-[var(--color-text-secondary)] focus:border-[var(--color-accent-primary)] focus:outline-none"
              />
            </div>
            <div className="flex overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
              <button
                onClick={() => setViewMode("grid")}
                title="grid"
                aria-label="grid"
                aria-pressed={viewMode === "grid"}
                className={
                  viewMode === "grid"
                    ? "bg-[var(--color-accent-primary)] px-2.5 py-2 text-black"
                    : "px-2.5 py-2 text-[var(--color-text-secondary)] transition hover:text-[var(--color-accent-primary)]"
                }
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" />
                  <rect x="14" y="3" width="7" height="7" />
                  <rect x="3" y="14" width="7" height="7" />
                  <rect x="14" y="14" width="7" height="7" />
                </svg>
              </button>
              <button
                onClick={() => setViewMode("list")}
                title="lista"
                aria-label="lista"
                aria-pressed={viewMode === "list"}
                className={
                  viewMode === "list"
                    ? "bg-[var(--color-accent-primary)] px-2.5 py-2 text-black"
                    : "px-2.5 py-2 text-[var(--color-text-secondary)] transition hover:text-[var(--color-accent-primary)]"
                }
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="8" y1="6" x2="21" y2="6" />
                  <line x1="8" y1="12" x2="21" y2="12" />
                  <line x1="8" y1="18" x2="21" y2="18" />
                  <line x1="3" y1="6" x2="3.01" y2="6" />
                  <line x1="3" y1="12" x2="3.01" y2="12" />
                  <line x1="3" y1="18" x2="3.01" y2="18" />
                </svg>
              </button>
            </div>
            <SettingsMenu
              groups={[
                {
                  title: "comportamento",
                  toggles: [
                    {
                      key: "auto",
                      label: "Abrir browser automaticamente",
                      hint: "ao detectar a porta nos logs",
                      checked: autoOpen,
                      onChange: setAutoOpen,
                    },
                  ],
                },
                {
                  title: "visualização",
                  toggles: [
                    {
                      key: "hidden",
                      label: "Mostrar projetos ocultos",
                      checked: showHidden,
                      onChange: setShowHidden,
                    },
                    {
                      key: "wt",
                      label: "Mostrar worktrees offline",
                      hint: "worktrees rodando aparecem sempre",
                      checked: showOfflineWorktrees,
                      onChange: setShowOfflineWorktrees,
                    },
                  ],
                },
              ]}
            />
            <button
              onClick={() => setAddingPath(true)}
              title="adicionar projeto por path"
              className="shrink-0 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
            >
              + projeto
            </button>
          </div>
        </header>

        {topView === "skills" ? (
          <SkillsView />
        ) : (
          <>
        {error && (
          <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-3 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            {filteredProjects.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--color-border-default)] py-12 text-center text-sm text-[var(--color-text-secondary)]">
                nenhum projeto bate com "{query}"
              </div>
            ) : (
              <motion.div
                variants={containerVariants}
                initial="initial"
                animate="animate"
                className={
                  viewMode === "grid"
                    ? "grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
                    : "flex flex-col gap-1.5"
                }
              >
                {filteredProjects.map((p) => {
                  const launcherStatus = statuses[p.id] ?? "idle";
                  const launcherPort = ports[p.id];
                  const externalListeners = externalByProject[p.id] ?? [];
                  const hasExternal = externalListeners.length > 0;
                  const effectiveStatus: ProjectStatus =
                    launcherStatus === "idle" && hasExternal
                      ? "external"
                      : launcherStatus;
                  const effectivePort =
                    launcherPort ??
                    (hasExternal ? externalListeners[0].port : undefined);
                  const propsCommon = {
                    project: p,
                    status: effectiveStatus,
                    port: effectivePort,
                    externalListeners:
                      launcherStatus === "idle" ? externalListeners : [],
                    selected: selected === p.id,
                    onSelect: () => setSelected(p.id),
                    onConfigure: () => setConfiguring(p.id),
                    onToggleHidden: () => handleToggleHidden(p.id, p.hidden),
                    claudeState: claudeByProjectPath[p.path] ?? null,
                    now,
                  };
                  return viewMode === "grid" ? (
                    <ProjectCard key={p.id} {...propsCommon} />
                  ) : (
                    <ProjectListItem key={p.id} {...propsCommon} />
                  );
                })}
              </motion.div>
            )}
          </>
        )}
          </>
        )}
      </div>

      {selectedProject && topView === "projects" && (
        <ProjectDetailDrawer
          project={selectedProject}
          status={statuses[selectedProject.id] ?? "idle"}
          port={ports[selectedProject.id]}
          logs={logs[selectedProject.id] ?? []}
          claudeState={claudeByProjectPath[selectedProject.path] ?? null}
          onClose={() => setSelected(null)}
          onClear={() =>
            setLogs((prev) => ({ ...prev, [selectedProject.id]: [] }))
          }
        />
      )}

      {configuring && (
        <ProjectConfigModal
          project={
            projects.find((p) => p.id === configuring) ?? {
              id: configuring,
              name: configuring,
              path: "",
              detected_script: null,
              available_scripts: [],
              has_package_json: false,
              package_manager: "pnpm",
              favicon_data_uri: null,
              hidden: false,
              extra: false,
              worktree: null,
              monorepo_parent: null,
            }
          }
          onClose={() => setConfiguring(null)}
          onSaved={refreshProjects}
        />
      )}

      {addingPath && (
        <AddProjectModal
          onClose={() => setAddingPath(false)}
          onAdded={refreshProjects}
        />
      )}
    </main>
  );
}

export default App;
