import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import { useEffect, useState } from "react";
import { modalVariants, overlayVariants } from "../styles/animations";

type Props = {
  onClose: () => void;
  onAdded: () => void;
};

export function AddProjectModal({ onClose, onAdded }: Props) {
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleAdd() {
    const trimmed = path.trim();
    if (!trimmed) {
      setError("Cole o caminho absoluto do projeto.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await invoke("add_extra_path", { path: trimmed });
      onAdded();
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
          <h2 className="page-title text-xl">Adicionar projeto</h2>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
            Cole o caminho absoluto da pasta. Útil pra projetos fora de
            <span className="font-mono"> ~/Projects</span>.
          </p>
        </div>

        <label className="block">
          <span className="block text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
            Caminho
          </span>
          <input
            type="text"
            autoFocus
            value={path}
            onChange={(e) => setPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAdd();
            }}
            placeholder="/home/falcao/Projects/algum-projeto"
            className="mt-1 w-full rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-2 font-mono text-sm focus:border-[var(--color-accent-primary)] focus:outline-none"
          />
        </label>

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
            onClick={handleAdd}
            disabled={saving}
            className="rounded-md bg-[var(--color-accent-primary)] px-3 py-2 text-xs font-semibold text-black transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? "Adicionando…" : "Adicionar"}
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}
