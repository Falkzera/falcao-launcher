interface Props {
  count: number;
}

/**
 * Chip compacto pra ProjectCard quando há CVE Critical/High open
 * & não-dismissado. Render `null` se count == 0 (sem ruído visual).
 *
 * Sprint B1 — Snyk-like.
 */
export function SecurityChip({ count }: Props) {
  if (count <= 0) return null;
  return (
    <span
      className="rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-[var(--color-danger)]"
      title={`${count} CVE${count === 1 ? "" : "s"} Critical/High aberto${count === 1 ? "" : "s"}`}
    >
      ⚠ {count} CVE
    </span>
  );
}
