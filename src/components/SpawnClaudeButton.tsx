// src/components/SpawnClaudeButton.tsx
import { invoke } from "@tauri-apps/api/core";

type Props = {
  path: string;
};

export function SpawnClaudeButton({ path }: Props) {
  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("spawn_claude", { path });
    } catch (err) {
      console.error("spawn_claude:", err);
    }
  }
  return (
    <button
      onClick={handleClick}
      title="abrir Claude Code aqui"
      aria-label="abrir Claude Code aqui"
      className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
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
        className="text-[var(--color-claude-primary)]"
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
        <circle cx="20" cy="5" r="1.5" fill="currentColor" />
      </svg>
    </button>
  );
}
