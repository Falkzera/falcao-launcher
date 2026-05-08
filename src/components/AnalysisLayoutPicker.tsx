import { useRef, useState } from "react";
import type { AnalysisLayout } from "../types/analysis";

interface Props {
  layouts: AnalysisLayout[];
  currentLayoutId: string | null;
  onSelect: (id: string | null) => void;
  onSave: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
  errorMessage: string | null;
}

export function AnalysisLayoutPicker({
  layouts,
  currentLayoutId,
  onSelect,
  onSave,
  onRename,
  onDelete,
  onDuplicate,
  onExport,
  onImport,
  errorMessage,
}: Props) {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [draftName, setDraftName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    onSelect(v === "" ? null : v);
  };

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setDraftName("");
    setShowSaveDialog(false);
  };

  const handleRename = () => {
    if (!currentLayoutId) return;
    const cur = layouts.find((l) => l.id === currentLayoutId);
    if (!cur) return;
    const next = window.prompt("Novo nome:", cur.name);
    if (next && next.trim() && next.trim() !== cur.name) {
      onRename(currentLayoutId, next.trim());
    }
  };

  const handleDelete = () => {
    if (!currentLayoutId) return;
    const cur = layouts.find((l) => l.id === currentLayoutId);
    if (!cur) return;
    if (window.confirm(`Excluir layout "${cur.name}"?`)) {
      onDelete(currentLayoutId);
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImport(file);
    e.target.value = ""; // permite re-selecionar mesmo arquivo
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={currentLayoutId ?? ""}
        onChange={handleSelect}
        className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]"
        aria-label="Layout salvo"
      >
        <option value="">— rascunho não salvo —</option>
        {layouts.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>

      <button onClick={() => setShowSaveDialog(true)} className={btnClass}>
        + Salvar como
      </button>
      {currentLayoutId && (
        <>
          <button onClick={handleRename} className={btnClass} title="Renomear">
            Renomear
          </button>
          <button onClick={() => onDuplicate(currentLayoutId)} className={btnClass}>
            Duplicar
          </button>
          <button
            onClick={handleDelete}
            className={btnClass + " hover:!text-[var(--color-danger)]"}
          >
            Excluir
          </button>
          <button onClick={() => onExport(currentLayoutId)} className={btnClass}>
            Export ↗
          </button>
        </>
      )}
      <button onClick={handleImportClick} className={btnClass}>
        Import ↙
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleFileChange}
      />

      {errorMessage && (
        <span className="text-[10px] text-[var(--color-danger)]">{errorMessage}</span>
      )}

      {showSaveDialog && (
        <form onSubmit={handleSaveSubmit} className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            placeholder="nome do layout"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs"
          />
          <button type="submit" className={btnClass + " bg-[var(--color-accent-primary)] text-black"}>
            Salvar
          </button>
          <button
            type="button"
            onClick={() => {
              setShowSaveDialog(false);
              setDraftName("");
            }}
            className={btnClass}
          >
            Cancelar
          </button>
        </form>
      )}
    </div>
  );
}

const btnClass =
  "rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]";
