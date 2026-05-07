import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Primitivos de loading reutilizáveis.
 *
 * - <Spinner />: SVG rotativo (size variants md/sm)
 * - <LoadingMessages />: mensagem ciclando + reticências animadas
 * - <DrawerLoadingOverlay />: overlay com backdrop blur (pra drawers/modais)
 * - <InlineLoading />: placeholder centralizado pra grids/sections
 */

const DEFAULT_MESSAGES = [
  "Preparando",
  "Carregando informações",
  "Sincronizando com a VM",
  "Buscando deploys da Vercel",
  "Quase lá",
  "Estamos perto",
  "Mais um pouco",
  "Quase pronto",
];

// ─── Spinner ────────────────────────────────────────────────────────────────

interface SpinnerProps {
  size?: "md" | "sm";
}

export function Spinner({ size = "md" }: SpinnerProps) {
  const dim = size === "md" ? 44 : 28;
  const r = size === "md" ? 18 : 11;
  const dash = size === "md" ? 113 : 69;
  const off = size === "md" ? 80 : 49;
  const stroke = size === "md" ? 3 : 2.5;
  return (
    <motion.svg
      width={dim}
      height={dim}
      viewBox={`0 0 ${dim} ${dim}`}
      animate={{ rotate: 360 }}
      transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
    >
      <circle
        cx={dim / 2}
        cy={dim / 2}
        r={r}
        stroke="var(--color-border-subtle)"
        strokeWidth={stroke}
        fill="none"
      />
      <circle
        cx={dim / 2}
        cy={dim / 2}
        r={r}
        stroke="var(--color-accent-primary)"
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={dash}
        strokeDashoffset={off}
      />
    </motion.svg>
  );
}

// ─── LoadingMessages ────────────────────────────────────────────────────────

interface LoadingMessagesProps {
  messages?: string[];
  rotateMs?: number;
  className?: string;
}

export function LoadingMessages({
  messages = DEFAULT_MESSAGES,
  rotateMs = 3000,
  className = "font-mono text-sm text-[var(--color-text-secondary)]",
}: LoadingMessagesProps) {
  const [idx, setIdx] = useState(0);
  const [dots, setDots] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setIdx((i) => (i + 1) % messages.length);
    }, rotateMs);
    return () => clearInterval(id);
  }, [messages.length, rotateMs]);

  useEffect(() => {
    const id = setInterval(() => {
      setDots((d) => (d % 3) + 1);
    }, 500);
    return () => clearInterval(id);
  }, []);

  return (
    <motion.p
      key={idx}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.32, ease: "easeOut" }}
      className={className}
    >
      {messages[idx]}
      <span className="inline-block w-[1.5em] text-left">
        {".".repeat(dots)}
      </span>
    </motion.p>
  );
}

// ─── DrawerLoadingOverlay ───────────────────────────────────────────────────

interface DrawerLoadingOverlayProps {
  loading: boolean;
  messages?: string[];
}

export function DrawerLoadingOverlay({
  loading,
  messages,
}: DrawerLoadingOverlayProps) {
  return (
    <AnimatePresence>
      {loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.28 } }}
          transition={{ duration: 0.18 }}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-[var(--color-bg-secondary)]"
        >
          <Spinner size="md" />
          <LoadingMessages messages={messages} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ─── InlineLoading ──────────────────────────────────────────────────────────

interface InlineLoadingProps {
  /** Mensagens custom (default: ciclo padrão de "Preparando…") */
  messages?: string[];
  /** Altura mínima do placeholder. Default 8rem. */
  minHeight?: string;
  /** Tamanho do spinner. Default sm pra grids inline. */
  size?: "md" | "sm";
}

export function InlineLoading({
  messages,
  minHeight = "8rem",
  size = "sm",
}: InlineLoadingProps) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--color-border-subtle)] bg-[var(--color-bg-card)]/40"
      style={{ minHeight }}
    >
      <Spinner size={size} />
      <LoadingMessages
        messages={messages}
        className="font-mono text-xs text-[var(--color-text-muted)]"
      />
    </div>
  );
}
