// src/components/SessionsList.tsx
import clsx from "clsx";
import type { ClaudeSession } from "../types";
import { costUsd, formatCost, humanizeTokens, totalTokens } from "../lib/claudeCost";

type Props = {
  sessions: ClaudeSession[];
  activeSessionId: string | null;
};

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function SessionsList({ sessions, activeSessionId }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border-default)] py-8 text-center text-xs text-[var(--color-text-muted)]">
        nenhuma sessão Claude ainda neste projeto
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {sessions.map((s) => {
        const isActive = s.session_id === activeSessionId;
        const tokens = totalTokens(s.usage);
        const cost = costUsd(s.usage, s.model);
        return (
          <div
            key={s.session_id}
            className="border-b border-[var(--color-border-subtle)] py-2 last:border-b-0"
          >
            <div className="flex items-baseline gap-2">
              <span
                className={clsx(
                  "mt-1 h-2 w-2 shrink-0 rounded-full",
                  isActive
                    ? "bg-[var(--color-claude-primary)] shadow-[0_0_6px_var(--color-claude-primary)]"
                    : "border border-[var(--color-text-muted)] bg-transparent",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-[var(--color-text-primary)]">
                  {s.title ?? "(sessão sem título)"}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                  {formatDate(s.last_activity)}
                  {s.model && ` · ${s.model.replace(/^claude-/, "")}`}
                  {tokens > 0 && ` · ${humanizeTokens(tokens)}`}
                  {cost >= 0.01 && (
                    <>
                      {" "}
                      <span className="text-[var(--color-text-secondary)]">≡</span>{" "}
                      {formatCost(cost)}
                    </>
                  )}
                  {s.duration_ms > 0 && ` · ${formatDuration(s.duration_ms)}`}
                  {s.git_branch && (
                    <span className="ml-1 normal-case text-[var(--color-text-secondary)]">
                      · {s.git_branch.replace(/^worktree-/, "")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
