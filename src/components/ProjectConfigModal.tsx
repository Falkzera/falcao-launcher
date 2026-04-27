import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import clsx from "clsx";
import { useEffect, useState } from "react";
import { modalVariants, overlayVariants } from "../styles/animations";
import type { IconCandidate, Project, ProjectConfig } from "../types";

type Props = {
  project: Project;
  onClose: () => void;
  onSaved?: () => void;
};

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return null;
  return n;
}

export function ProjectConfigModal({ project, onClose, onSaved }: Props) {
  const [frontendPort, setFrontendPort] = useState("");
  const [backendPort, setBackendPort] = useState("");
  const [customIcon, setCustomIcon] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<IconCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      invoke<ProjectConfig>("get_project_config", { id: project.id }),
      invoke<IconCandidate[]>("list_icon_candidates", {
        projectPath: project.path,
      }).catch(() => []),
    ])
      .then(([cfg, cands]) => {
        setFrontendPort(cfg.frontend_port?.toString() ?? "");
        setBackendPort(cfg.backend_port?.toString() ?? "");
        setCustomIcon(cfg.custom_icon_path ?? null);
        setCandidates(cands);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [project.id, project.path]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleSave() {
    const front = frontendPort.trim() ? parsePort(frontendPort) : null;
    const back = backendPort.trim() ? parsePort(backendPort) : null;

    if (frontendPort.trim() && front === null) {
      setError("Porta do frontend inválida (1024–65535).");
      return;
    }
    if (backendPort.trim() && back === null) {
      setError("Porta do backend inválida (1024–65535).");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await invoke("set_project_config", {
        id: project.id,
        config: {
          frontend_port: front,
          backend_port: back,
          custom_icon_path: customIcon,
        },
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div
      variants={overlayVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        variants={modalVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        className="w-full max-w-lg rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="page-title text-xl">Configurar projeto</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            {project.name}
          </p>
        </div>

        {loading ? (
          <div className="py-6 text-center text-sm text-[var(--color-text-secondary)]">
            Carregando…
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
                  Porta frontend (PORT)
                </span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={frontendPort}
                  onChange={(e) => setFrontendPort(e.target.value)}
                  placeholder="auto"
                  className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 font-mono text-sm focus:border-[var(--color-accent-primary)] focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
                  Porta backend (BACKEND_PORT)
                </span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={backendPort}
                  onChange={(e) => setBackendPort(e.target.value)}
                  placeholder="auto"
                  className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 font-mono text-sm focus:border-[var(--color-accent-primary)] focus:outline-none"
                />
              </label>
            </div>

            <p className="mt-3 text-xs text-[var(--color-text-secondary)]">
              Vazio = sem override. Se a porta preferida estiver ocupada, o
              launcher tenta a próxima livre.
            </p>

            <div className="mt-6">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
                  Logo do projeto
                </span>
                {customIcon && (
                  <button
                    onClick={() => setCustomIcon(null)}
                    className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] hover:text-[var(--color-accent-primary)]"
                  >
                    voltar ao auto
                  </button>
                )}
              </div>

              {candidates.length === 0 ? (
                <div className="rounded-md border border-dashed border-[var(--color-border-default)] p-4 text-center text-xs text-[var(--color-text-muted)]">
                  Nenhuma imagem candidata encontrada nas pastas comuns
                  (<span className="font-mono">public/</span>,{" "}
                  <span className="font-mono">src/assets/</span>,{" "}
                  <span className="font-mono">static/</span>). Adicione um
                  arquivo <span className="font-mono">favicon.svg</span>,{" "}
                  <span className="font-mono">logo.png</span> ou{" "}
                  <span className="font-mono">icon.svg</span> e reabra.
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {candidates.map((c) => {
                    const active = customIcon === c.relative_path;
                    return (
                      <button
                        key={c.relative_path}
                        onClick={() => setCustomIcon(c.relative_path)}
                        title={`${c.relative_path} (${Math.round(c.size_bytes / 1024)} KB)`}
                        className={clsx(
                          "group relative flex aspect-square items-center justify-center rounded-lg border bg-[var(--color-bg-primary)] p-2 transition",
                          active
                            ? "border-[var(--color-accent-primary)] ring-2 ring-[var(--color-accent-primary)]/30"
                            : "border-[var(--color-border-subtle)] hover:border-[var(--color-accent-primary)]/60",
                        )}
                      >
                        <img
                          src={c.data_uri}
                          alt=""
                          className="max-h-full max-w-full object-contain"
                        />
                      </button>
                    );
                  })}
                </div>
              )}
              {customIcon && (
                <p className="mt-2 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                  {customIcon}
                </p>
              )}
            </div>

            {error && (
              <div className="mt-3 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger)]/10 p-2 text-xs text-[var(--color-danger)]">
                {error}
              </div>
            )}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={saving}
                className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] transition hover:text-[var(--color-text-primary)] disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-[var(--color-accent-primary)] px-3 py-2 text-xs font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
