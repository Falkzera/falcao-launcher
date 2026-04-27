import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { modalVariants, overlayVariants } from "../styles/animations";
import type { Project, ProjectConfig } from "../types";

type Props = {
  project: Project;
  onClose: () => void;
};

function parsePort(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return null;
  return n;
}

export function ProjectConfigModal({ project, onClose }: Props) {
  const [frontendPort, setFrontendPort] = useState("");
  const [backendPort, setBackendPort] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<ProjectConfig>("get_project_config", { id: project.id })
      .then((cfg) => {
        setFrontendPort(cfg.frontend_port?.toString() ?? "");
        setBackendPort(cfg.backend_port?.toString() ?? "");
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [project.id]);

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
        config: { frontend_port: front, backend_port: back },
      });
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
        className="w-full max-w-md rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-6 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="page-title text-xl">Configurar portas</h2>
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
                  className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm focus:border-[var(--color-accent-primary)] focus:outline-none"
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
                  className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 text-sm focus:border-[var(--color-accent-primary)] focus:outline-none"
                />
              </label>
            </div>

            <p className="mt-3 text-xs text-[var(--color-text-secondary)]">
              Vazio = sem override. Se a porta preferida estiver ocupada, o
              launcher tenta a próxima livre.
            </p>

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
