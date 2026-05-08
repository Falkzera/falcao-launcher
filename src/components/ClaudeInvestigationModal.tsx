import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { monitorApi } from "../lib/monitor";
import { resolveTargetDir } from "../lib/resolveTargetDir";
import {
  estimatePromptSize,
  serializeContextToMarkdown,
} from "../lib/serializeAnalysis";
import { modalVariants, overlayVariants } from "../styles/animations";
import type { AnalysisContext, MetricRef } from "../types/analysis";

interface Props {
  context: AnalysisContext;
  primaryMetric: MetricRef;
  open: boolean;
  onClose: () => void;
}

const PLACEHOLDER =
  "Ex: Por que o pico de CPU às 14:35? Quais erros aparecem nos logs nesse período?";

export function ClaudeInvestigationModal({
  context,
  primaryMetric,
  open,
  onClose,
}: Props) {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset state quando modal abre/fecha
  useEffect(() => {
    if (open) {
      setQuestion("");
      setError(null);
      setLoading(false);
      // Autofocus após animação
      const t = setTimeout(() => textareaRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Esc fecha (quando não está em loading)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, loading, onClose]);

  const estimate = estimatePromptSize(context);
  const canSpawn = question.trim().length > 0 && !loading;

  const handleSpawn = async () => {
    if (!canSpawn) return;
    setLoading(true);
    setError(null);
    try {
      const prompt = serializeContextToMarkdown(context, question);
      const targetDir = resolveTargetDir(primaryMetric);
      await monitorApi.spawnClaudeInvestigation(prompt, targetDir);
      onClose();
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            variants={overlayVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed inset-0 z-40 bg-black/60"
            onClick={() => !loading && onClose()}
          />
          <motion.div
            variants={modalVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="fixed left-1/2 top-1/2 z-50 w-[min(540px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] p-5 shadow-[0_8px_32px_rgba(0,0,0,0.5)]"
            role="dialog"
            aria-labelledby="claude-modal-title"
          >
            <header className="mb-4">
              <div className="text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
                investigar com claude
              </div>
              <h3
                id="claude-modal-title"
                className="page-title mt-1 text-xl text-[var(--color-text-primary)]"
              >
                {formatMetricLabel(primaryMetric)}
              </h3>
            </header>

            <div className="mb-3 rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 text-xs">
              <div className="font-mono text-[var(--color-text-secondary)]">
                {estimate.charts} chart{estimate.charts !== 1 ? "s" : ""} ·{" "}
                {context.range.start.toLocaleTimeString("pt-BR")} →{" "}
                {context.range.end.toLocaleTimeString("pt-BR")} ·{" "}
                {estimate.logLines > 0
                  ? `${estimate.logLines} linha${estimate.logLines !== 1 ? "s" : ""} de logs`
                  : "sem logs fetched"}
              </div>
              <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
                prompt ~{(estimate.bytes / 1024).toFixed(0)} KB · vai pra{" "}
                <code className="text-[var(--color-text-secondary)]">
                  {resolveTargetDir(primaryMetric).replace("/home/falcao", "~")}
                </code>
              </div>
            </div>

            <label className="block">
              <span className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
                O que investigar?
              </span>
              <textarea
                ref={textareaRef}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder={PLACEHOLDER}
                rows={5}
                disabled={loading}
                className="mt-1 w-full rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-2 font-sans text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent-primary)]/60 focus:outline-none disabled:opacity-50"
              />
            </label>

            {error && (
              <div className="mt-3 rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-2 text-xs text-[var(--color-danger)]">
                {error}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={onClose}
                disabled={loading}
                className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)] disabled:opacity-50"
              >
                Cancelar
              </button>
              <button
                onClick={handleSpawn}
                disabled={!canSpawn}
                className="rounded-md bg-[var(--color-accent-primary)] px-3 py-1.5 text-xs font-semibold text-black transition hover:bg-[var(--color-accent-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? "Spawnando…" : "🚀 Spawnar Claude"}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function formatMetricLabel(metric: MetricRef): string {
  if (metric.kind === "container") {
    return `container ${metric.resource} · ${metric.metric}`;
  }
  return `${metric.kind.toUpperCase()} · ${metric.metric}`;
}
