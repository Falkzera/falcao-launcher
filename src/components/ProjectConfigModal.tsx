import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h2 className="text-lg font-semibold">Configurar portas</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {project.name}
          </p>
        </div>

        {loading ? (
          <div className="py-6 text-center text-sm text-[var(--color-muted)]">
            Carregando…
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-[var(--color-muted)]">
                  Porta frontend (PORT)
                </span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={frontendPort}
                  onChange={(e) => setFrontendPort(e.target.value)}
                  placeholder="auto"
                  className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                />
              </label>

              <label className="block">
                <span className="block text-xs uppercase tracking-wide text-[var(--color-muted)]">
                  Porta backend (BACKEND_PORT)
                </span>
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={backendPort}
                  onChange={(e) => setBackendPort(e.target.value)}
                  placeholder="auto"
                  className="mt-1 w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm focus:border-[var(--color-accent)] focus:outline-none"
                />
              </label>
            </div>

            <p className="mt-3 text-xs text-[var(--color-muted)]">
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
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2 text-xs font-semibold text-[var(--color-muted)] transition hover:text-[var(--color-text)] disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="rounded-md bg-[var(--color-accent)] px-3 py-2 text-xs font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
              >
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
