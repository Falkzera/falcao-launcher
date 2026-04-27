import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "framer-motion";
import { ProjectCard } from "./components/ProjectCard";
import { LogsDrawer } from "./components/LogsDrawer";
import { ProjectConfigModal } from "./components/ProjectConfigModal";
import { AddProjectModal } from "./components/AddProjectModal";
import { Checkbox } from "./components/Checkbox";
import { containerVariants } from "./styles/animations";
import type {
  AllocatedPortsPayload,
  LogLine,
  LogPayload,
  PortPayload,
  Project,
  ProjectStatus,
  StatusPayload,
} from "./types";
import "./App.css";

const MAX_LOG_LINES = 5000;
const AUTO_OPEN_KEY = "falcao-launcher.autoOpenBrowser";
const SHOW_HIDDEN_KEY = "falcao-launcher.showHidden";

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [ports, setPorts] = useState<Record<string, number>>({});
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
  const [addingPath, setAddingPath] = useState(false);
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

    return () => {
      unlistenLog.then((fn) => fn());
      unlistenStatus.then((fn) => fn());
      unlistenPort.then((fn) => fn());
      unlistenAllocated.then((fn) => fn());
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

  const filteredProjects = useMemo(() => {
    let list = projects;
    if (!showHidden) {
      list = list.filter((p) => !p.hidden);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    return list;
  }, [projects, query, showHidden]);

  const hiddenCount = useMemo(
    () => projects.filter((p) => p.hidden).length,
    [projects],
  );

  const selectedProject = selected
    ? (projects.find((p) => p.id === selected) ?? null)
    : null;

  const drawerOpen = selectedProject !== null;
  const runningCount = Object.values(statuses).filter(
    (s) => s === "running",
  ).length;

  return (
    <main
      className="min-h-screen transition-[padding] duration-200"
      style={{ paddingRight: drawerOpen ? "480px" : "0" }}
    >
      <div className="mx-auto max-w-6xl px-6 py-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="page-title text-3xl">Falcão Launcher</h1>
            <p className="mt-1 text-sm font-light text-[var(--color-text-secondary)]">
              {loading
                ? "Scanning ~/Projects…"
                : `${projects.length} projects · ${runningCount} running${hiddenCount > 0 ? ` · ${hiddenCount} ocultos` : ""}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative">
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar…  (/)"
                className="w-64 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm placeholder:text-[var(--color-text-secondary)] focus:border-[var(--color-accent-primary)] focus:outline-none"
              />
            </div>
            <Checkbox
              checked={autoOpen}
              onChange={setAutoOpen}
              label="browser auto"
            />
            <Checkbox
              checked={showHidden}
              onChange={setShowHidden}
              label="mostrar ocultos"
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
                className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
              >
                {filteredProjects.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    status={statuses[p.id] ?? "idle"}
                    port={ports[p.id]}
                    selected={selected === p.id}
                    onSelect={() => setSelected(p.id)}
                    onConfigure={() => setConfiguring(p.id)}
                    onToggleHidden={() => handleToggleHidden(p.id, p.hidden)}
                  />
                ))}
              </motion.div>
            )}
          </>
        )}
      </div>

      {selectedProject && (
        <LogsDrawer
          project={selectedProject}
          status={statuses[selectedProject.id] ?? "idle"}
          port={ports[selectedProject.id]}
          logs={logs[selectedProject.id] ?? []}
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
            }
          }
          onClose={() => setConfiguring(null)}
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
