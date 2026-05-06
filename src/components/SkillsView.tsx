import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { motion } from "framer-motion";
import clsx from "clsx";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Skill, SkillSource } from "../types";

type SourceFilter = "all" | "user" | "plugin";

function pluginColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 65% 60%)`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeDate(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  const day = 24 * 60 * 60 * 1000;
  if (diff < day) return "hoje";
  if (diff < 2 * day) return "ontem";
  const days = Math.floor(diff / day);
  if (days < 30) return `${days}d atrás`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}m atrás`;
  return `${Math.floor(months / 12)}a atrás`;
}

const SOURCE_LABELS: Record<SkillSource, string> = {
  user: "user",
  plugin: "plugin",
};

export function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SourceFilter>("all");

  useEffect(() => {
    invoke<Skill[]>("list_skills")
      .then((data) => {
        setSkills(data);
        setLoading(false);
        if (data.length > 0 && !selectedId) {
          setSelectedId(data[0].id);
        }
      })
      .catch((err) => {
        console.error("list_skills:", err);
        setLoading(false);
      });
  }, []);

  const selected = useMemo(
    () => skills.find((s) => s.id === selectedId) ?? null,
    [skills, selectedId],
  );

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    setContentLoading(true);
    setContentError(null);
    invoke<string>("read_skill_content", { path: selected.path })
      .then((text) => {
        setContent(text);
        setContentLoading(false);
      })
      .catch((err) => {
        setContentError(String(err));
        setContentLoading(false);
      });
  }, [selected?.path]);

  const filtered = useMemo(() => {
    let list = skills;
    if (filter !== "all") {
      list = list.filter((s) => s.source === filter);
    }
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (s) =>
          s.id.toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          (s.description?.toLowerCase().includes(q) ?? false),
      );
    }
    return list;
  }, [skills, query, filter]);

  const counts = useMemo(() => {
    const u = skills.filter((s) => s.source === "user").length;
    const p = skills.filter((s) => s.source === "plugin").length;
    return { all: skills.length, user: u, plugin: p };
  }, [skills]);

  async function handleOpenInEditor() {
    if (!selected) return;
    try {
      // open_in_editor espera diretório, então passamos o dir do SKILL.md
      const dir = selected.path.replace(/\/SKILL\.md$/, "");
      await invoke("open_in_editor", { path: dir });
    } catch (err) {
      console.error(err);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-[var(--color-text-secondary)]">
        Scanning ~/.claude/skills…
      </div>
    );
  }

  return (
    <div className="flex flex-1 gap-4">
      {/* Lista esquerda */}
      <aside className="flex w-[340px] shrink-0 flex-col gap-3">
        <div className="flex flex-col gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar skill…"
            className="rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-sm placeholder:text-[var(--color-text-secondary)] focus:border-[var(--color-accent-primary)] focus:outline-none"
          />
          <div className="flex overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] text-[11px]">
            {(["all", "user", "plugin"] as SourceFilter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={clsx(
                  "flex-1 px-2 py-1.5 font-mono uppercase tracking-wider transition",
                  filter === f
                    ? "bg-[var(--color-accent-primary)] text-black"
                    : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
                )}
              >
                {f === "all" ? `todas · ${counts.all}` : `${f} · ${counts[f]}`}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border-default)] py-8 text-center text-xs text-[var(--color-text-secondary)]">
              nada encontrado
            </div>
          ) : (
            filtered.map((s) => {
              const isSelected = s.id === selectedId;
              const accent = s.plugin ? pluginColor(s.plugin) : null;
              return (
                <motion.button
                  key={s.id}
                  onClick={() => setSelectedId(s.id)}
                  whileHover={{ scale: 1.005 }}
                  className={clsx(
                    "group flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition",
                    isSelected
                      ? "border-[var(--color-accent-primary)] bg-[var(--color-bg-secondary)]"
                      : "border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] hover:border-[var(--color-accent-primary)]/40",
                  )}
                  style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
                >
                  <div className="flex w-full items-center gap-2">
                    <span className="truncate text-xs font-semibold tracking-tight text-[var(--color-text-primary)]">
                      {s.id}
                    </span>
                    <span
                      className={clsx(
                        "ml-auto shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider ring-1",
                        s.source === "user"
                          ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-primary)] ring-[var(--color-accent-primary)]/40"
                          : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ring-[var(--color-border-default)]",
                      )}
                    >
                      {SOURCE_LABELS[s.source]}
                    </span>
                  </div>
                  {s.description && (
                    <div className="line-clamp-2 text-[11px] text-[var(--color-text-secondary)]">
                      {s.description}
                    </div>
                  )}
                </motion.button>
              );
            })
          )}
        </div>
      </aside>

      {/* Painel direito */}
      <main className="flex flex-1 flex-col overflow-hidden rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] backdrop-blur-md">
        {!selected ? (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-secondary)]">
            selecione uma skill
          </div>
        ) : (
          <>
            <header className="flex items-start justify-between gap-3 border-b border-[var(--color-border-subtle)] px-5 py-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="page-title truncate text-xl">{selected.id}</h2>
                  <span
                    className={clsx(
                      "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1",
                      selected.source === "user"
                        ? "bg-[var(--color-accent-soft)] text-[var(--color-accent-primary)] ring-[var(--color-accent-primary)]/40"
                        : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ring-[var(--color-border-default)]",
                    )}
                  >
                    {SOURCE_LABELS[selected.source]}
                  </span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-[var(--color-text-muted)]">
                  {selected.path.replace(/^.*\/\.claude\//, "~/.claude/")}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[10px] text-[var(--color-text-muted)]">
                  <span>{selected.line_count} linhas</span>
                  <span>·</span>
                  <span>{formatBytes(selected.size_bytes)}</span>
                  <span>·</span>
                  <span>modificado {formatRelativeDate(selected.modified_at)}</span>
                </div>
              </div>
              <button
                onClick={handleOpenInEditor}
                className="shrink-0 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs font-semibold text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)] hover:text-[var(--color-accent-primary)]"
              >
                Abrir no VSCode
              </button>
            </header>
            <div className="prose prose-invert flex-1 overflow-y-auto px-5 py-4 text-sm">
              {contentLoading ? (
                <div className="text-xs text-[var(--color-text-secondary)]">carregando…</div>
              ) : contentError ? (
                <div className="text-xs text-[var(--color-danger)]">erro: {contentError}</div>
              ) : content ? (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              ) : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
