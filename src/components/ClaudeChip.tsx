// src/components/ClaudeChip.tsx
import { motion } from "framer-motion";
import clsx from "clsx";
import type { ClaudeProjectState } from "../types";
import { humanizeTokens, totalTokens } from "../lib/claudeCost";

const TOKEN_THRESHOLD = 100_000;

type Props = {
  state: ClaudeProjectState | null;
  now: number;
};

function formatRelative(ms: number, now: number): string {
  const diff = now - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function ClaudeChip({ state, now }: Props) {
  if (!state || state.sessions.length === 0) return null;
  const isActive = state.active_session_id !== null;
  const tokens = totalTokens(state.total_usage);
  const showTokens = tokens >= TOKEN_THRESHOLD;
  const lastTs = state.sessions[0]?.last_activity ?? 0;
  const sessionCount = state.sessions.length;

  return (
    <span
      className={clsx(
        "flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1",
        isActive
          ? "bg-[var(--color-claude-soft)] text-[var(--color-claude-primary)] ring-[var(--color-claude-primary)]/40"
          : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ring-[var(--color-border-default)]",
      )}
      title={`${sessionCount} sessões · ${humanizeTokens(tokens)} tokens`}
    >
      <motion.span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: isActive ? "var(--color-claude-primary)" : "var(--color-text-muted)",
        }}
        animate={isActive ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
        transition={isActive ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      <span>claude</span>
      <span className="text-[var(--color-text-muted)]">·</span>
      {isActive ? (
        <span className="normal-case text-[var(--color-claude-primary)]">
          {formatRelative(lastTs, now)}
        </span>
      ) : (
        <span className="normal-case text-[var(--color-text-secondary)]">
          {sessionCount} {sessionCount === 1 ? "sessão" : "sessões"}
        </span>
      )}
      {showTokens && (
        <>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span className="normal-case text-[var(--color-text-secondary)]">
            {humanizeTokens(tokens)}
          </span>
        </>
      )}
    </span>
  );
}
