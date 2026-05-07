import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

/**
 * Overlay de loading reutilizável pra drawers/modais que demoram pra trazer dados.
 *
 * - Backdrop com blur sobre o conteúdo atrás
 * - Spinner SVG rotacionando
 * - Mensagem ciclando a cada `messageRotateMs` (default 3s)
 * - Reticências animadas (1 → 2 → 3 pontos) a cada 500ms
 *
 * Some com fade quando `loading` vira false.
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

interface Props {
  loading: boolean;
  messages?: string[];
  messageRotateMs?: number;
}

export function DrawerLoadingOverlay({
  loading,
  messages = DEFAULT_MESSAGES,
  messageRotateMs = 3000,
}: Props) {
  const [messageIdx, setMessageIdx] = useState(0);
  const [dots, setDots] = useState(1);

  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => {
      setMessageIdx((i) => (i + 1) % messages.length);
    }, messageRotateMs);
    return () => clearInterval(id);
  }, [loading, messages.length, messageRotateMs]);

  useEffect(() => {
    if (!loading) return;
    const id = setInterval(() => {
      setDots((d) => (d % 3) + 1);
    }, 500);
    return () => clearInterval(id);
  }, [loading]);

  return (
    <AnimatePresence>
      {loading && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-5 backdrop-blur-md"
          style={{
            background:
              "linear-gradient(to bottom, var(--color-bg-secondary)cc, var(--color-bg-secondary)e6)",
          }}
        >
          <Spinner />
          <motion.p
            key={messageIdx}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.32, ease: "easeOut" }}
            className="font-mono text-sm text-[var(--color-text-secondary)]"
          >
            {messages[messageIdx]}
            <Dots count={dots} />
          </motion.p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Spinner() {
  return (
    <motion.svg
      width="44"
      height="44"
      viewBox="0 0 44 44"
      animate={{ rotate: 360 }}
      transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
    >
      <circle
        cx="22"
        cy="22"
        r="18"
        stroke="var(--color-border-subtle)"
        strokeWidth="3"
        fill="none"
      />
      <circle
        cx="22"
        cy="22"
        r="18"
        stroke="var(--color-accent-primary)"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeDasharray="113"
        strokeDashoffset="80"
      />
    </motion.svg>
  );
}

function Dots({ count }: { count: number }) {
  // Reserva espaço fixo (3 chars) pra texto não pular quando os pontos somem
  return (
    <span className="inline-block w-[1.5em] text-left">
      {".".repeat(count)}
    </span>
  );
}
