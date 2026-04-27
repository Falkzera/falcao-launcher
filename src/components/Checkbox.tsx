import { AnimatePresence, motion } from "framer-motion";
import clsx from "clsx";

type Props = {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  className?: string;
};

export function Checkbox({ checked, onChange, label, className }: Props) {
  return (
    <label
      className={clsx(
        "inline-flex cursor-pointer items-center gap-2 rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 py-2 text-xs text-[var(--color-text-secondary)] transition select-none",
        "hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-text-primary)]",
        className,
      )}
    >
      <motion.span
        whileTap={{ scale: 0.88 }}
        transition={{ duration: 0.1 }}
        className="relative flex h-4 w-4 shrink-0 items-center justify-center"
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span
          aria-hidden
          className={clsx(
            "flex h-4 w-4 items-center justify-center rounded border transition-colors duration-200",
            "peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--color-accent-primary)]/30",
            checked
              ? "border-[var(--color-accent-primary)] bg-[var(--color-accent-primary)]"
              : "border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)]",
          )}
        >
          <AnimatePresence initial={false}>
            {checked && (
              <motion.svg
                key="check"
                width="11"
                height="11"
                viewBox="0 0 24 24"
                fill="none"
                stroke="black"
                strokeWidth={3.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.5 }}
                transition={{ duration: 0.18 }}
                aria-hidden
              >
                <motion.path
                  d="M20 6 L9 17 L4 12"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  exit={{ pathLength: 0 }}
                  transition={{ duration: 0.22, delay: 0.06 }}
                />
              </motion.svg>
            )}
          </AnimatePresence>
        </span>
      </motion.span>
      {label}
    </label>
  );
}
