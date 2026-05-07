import { motion } from "framer-motion";
import type { VercelState } from "../types/monitor";

interface Props {
  state: VercelState;
  /** Variante visual: padrão (compacta com dot+label) ou só o dot. */
  compact?: boolean;
}

interface VisualSpec {
  color: string;
  label: string;
  pulse: boolean;
}

function specFor(state: VercelState): VisualSpec {
  switch (state) {
    case "READY":
      return { color: "var(--color-success)", label: "READY", pulse: false };
    case "ERROR":
      return { color: "var(--color-danger)", label: "ERROR", pulse: false };
    case "BUILDING":
      return {
        color: "var(--color-accent-primary)",
        label: "BUILDING",
        pulse: true,
      };
    case "QUEUED":
      return {
        color: "var(--color-accent-primary)",
        label: "QUEUED",
        pulse: true,
      };
    case "CANCELED":
      return {
        color: "var(--color-text-secondary)",
        label: "CANCELED",
        pulse: false,
      };
    default:
      return {
        color: "var(--color-text-secondary)",
        label: String(state).toUpperCase(),
        pulse: false,
      };
  }
}

export function VercelStatusBadge({ state, compact = false }: Props) {
  const { color, label, pulse } = specFor(state);

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-glass)] px-2 py-0.5"
      style={{ minWidth: compact ? undefined : 80 }}
      aria-label={`Vercel state: ${label}`}
    >
      {pulse ? (
        <motion.span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
        />
      ) : (
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
      )}
      <span
        className="font-mono text-[10px] font-semibold uppercase tracking-wider"
        style={{ color }}
      >
        {label}
      </span>
    </span>
  );
}
