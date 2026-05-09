// Serializa um grupo de CVEs (mesmo source_id) em prompt Markdown pro Claude
// Code analisar e propor upgrade unificado. Sprint B1.5.

import type { VulnerabilityRow } from "../types/security";

const HOME = "/home/falcao";

/**
 * Decide diretório alvo pro Claude Code abrir baseado no source_id da CVE.
 *
 * Convenção:
 *   - Imagem Docker (tem `:` ou `@`): contexto não é repo nenhum → launcher.
 *   - Senão: assume nome de repo → `~/Projects/<source_id>`. O Rust faz
 *     fallback automático ao launcher se o path não existir.
 */
export function resolveSecurityTargetDir(sourceId: string): string {
  const isImage = sourceId.includes(":") || sourceId.includes("@");
  if (isImage) return `${HOME}/Projects/falcao-launcher`;
  return `${HOME}/Projects/${sourceId}`;
}

/**
 * Constrói prompt Markdown estruturado com todas as CVEs de um source_id.
 * Pede pro Claude propor um plano de upgrade unificado (não fix individual
 * por CVE, que seria fragmentado).
 */
export function serializeSecurityGroup(
  sourceId: string,
  vulns: VulnerabilityRow[],
): string {
  const isImage = sourceId.includes(":") || sourceId.includes("@");
  const kind = isImage ? "imagem Docker" : "repositório";

  const sortedVulns = [...vulns].sort(
    (a, b) => severityRank(a.severity) - severityRank(b.severity),
  );

  const counts = countBySeverity(vulns);
  const totalCritical = counts.critical;
  const totalHigh = counts.high;

  const lines: string[] = [];
  lines.push(`# Análise de vulnerabilidades — \`${sourceId}\``);
  lines.push("");
  lines.push(`**Tipo:** ${kind}`);
  lines.push(
    `**Total:** ${vulns.length} CVE${vulns.length === 1 ? "" : "s"} aberto${vulns.length === 1 ? "" : "s"} ` +
      `(${totalCritical} critical, ${totalHigh} high, ${counts.medium} medium, ${counts.low} low)`,
  );
  lines.push("");
  lines.push("## Vulnerabilidades");
  lines.push("");
  lines.push(
    "| Severity | ID | Pacote | Versão atual | Versão com fix | Título |",
  );
  lines.push("|---|---|---|---|---|---|");
  for (const v of sortedVulns) {
    const id = v.cve_id ?? v.ghsa_id ?? "—";
    const pkg = v.package_name ?? "—";
    const cur = v.package_version ?? "—";
    const fix = v.fix_version ?? "—";
    const title = (v.title ?? "—").replace(/\|/g, "\\|");
    lines.push(
      `| **${v.severity.toUpperCase()}** | ${id} | \`${pkg}\` | \`${cur}\` | \`${fix}\` | ${title} |`,
    );
  }
  lines.push("");
  lines.push("## URLs (referência)");
  lines.push("");
  for (const v of sortedVulns) {
    if (v.url) {
      const id = v.cve_id ?? v.ghsa_id ?? "ref";
      lines.push(`- [${id}](${v.url})`);
    }
  }

  lines.push("");
  lines.push("## O que fazer");
  lines.push("");
  if (isImage) {
    lines.push(
      "Esta é uma imagem Docker rodando na VM. Verifique:",
      "",
      "1. Qual a tag mais recente que fecha o maior número dessas CVEs?",
      "2. O `docker-compose.yml` em `/opt/apps/<stack>/` precisa atualização?",
      "3. Há breaking changes entre a tag atual e a nova? Cheque release notes.",
      "4. Proponha o comando `sed` ou edição manual + restart.",
    );
  } else {
    lines.push(
      `Esta é uma análise do repositório \`${sourceId}\`. Verifique:`,
      "",
      "1. O lockfile (package-lock.json / pnpm-lock.yaml / Cargo.lock / poetry.lock) tem as versões vulneráveis?",
      "2. Quais dependências bumpadas em conjunto resolveriam o maior subset (>=80% das CVEs)?",
      "3. Há breaking changes? Cheque CHANGELOGs das libs principais.",
      "4. Proponha o(s) comando(s) de upgrade + valide com testes locais antes de commit.",
    );
  }
  lines.push("");
  lines.push("**Pergunta:** Qual o plano de upgrade unificado mais econômico (fewest version bumps possible) que resolve a maioria dessas CVEs? Liste os comandos exatos a rodar.");

  return lines.join("\n");
}

const SEV_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  unknown: 4,
};
function severityRank(s: string): number {
  return SEV_RANK[s] ?? 5;
}

function countBySeverity(vulns: VulnerabilityRow[]) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const v of vulns) c[v.severity] += 1;
  return c;
}
