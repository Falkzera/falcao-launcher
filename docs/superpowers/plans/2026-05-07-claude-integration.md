# Sprint 4 — Integração Claude no modo análise — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar botão "🤖 Investigar com Claude" no header do `AnalysisPage` que abre Claude Code numa janela Ghostty nova com o `AnalysisContext` atual já formatado como prompt Markdown estruturado, partindo do diretório do projeto sendo investigado (auto-detect).

**Architecture:** Botão dispara modal com textarea pra pergunta. Submit chama serializer puro (`serializeContextToMarkdown`) que gera prompt Markdown ~200KB worst-case, e novo command Rust `spawn_claude_investigation` que escreve o prompt em `/tmp/falcao-investigation-<uuid>.md` (chmod 600) e spawna `ghostty -e bash -c "claude < <file>; rm <file>"` no diretório auto-detectado. Reusa pattern de `spawn_claude` existente (PATH com `~/.local/bin`, fire-and-forget). Sessão Claude resultante é trackeada automaticamente pelo sistema de Claude awareness (sem código novo).

**Tech Stack:** Tauri 2 (commands `#[tauri::command]` em Rust) + React 19 + TypeScript + framer-motion (modal animation, já no projeto). Sem deps novas.

**Spec source:** `docs/superpowers/specs/2026-05-07-claude-integration-design.md`

**Branch:** `feature/claude-integration` (já criada, com spec commitado).

---

## File structure

Arquivos novos e modificados.

### Backend Rust (Phase A)
- **Modify:** `src-tauri/src/external.rs` — adiciona `spawn_claude_investigation` (reusa `spawn_detached` helper existente)
- **Modify:** `src-tauri/src/lib.rs` — registra comando novo no `generate_handler!`
- **Modify:** `src-tauri/Cargo.toml` — adiciona `uuid` deps (pra gerar nome único do arquivo temp)

### TS puros (Phase B — paralelizável com A após branches setup)
- **Create:** `src/lib/serializeAnalysis.ts` — `serializeContextToMarkdown(context, question): string`
- **Create:** `src/lib/resolveTargetDir.ts` — `resolveTargetDir(metric: MetricRef): string`
- **Modify:** `src/lib/monitor.ts` — adiciona `monitorApi.spawnClaudeInvestigation()` wrapper

### Frontend (Phase C — depende de B)
- **Create:** `src/components/ClaudeInvestigationModal.tsx`
- **Modify:** `src/components/AnalysisPage.tsx` — botão no header + state + modal render + capturar return do `useAnalysisContext`
- **Modify:** `src/lib/useAnalysisContext.ts` — não muda código (já retorna o context — só estamos passando a usar o retorno em vez de descartar)

### Validação (Phase D)
- Smoke manual: build release + reinstall + 5 fluxos manuais

### Docs (Phase E)
- **Modify:** `src-tauri/src/.agent.md` (entry de `external.rs`)
- **Modify:** `src/components/.agent.md`
- **Modify:** `src/lib/.agent.md`
- **Modify:** `CLAUDE.md`
- **Modify:** `docs/superpowers/vm-migrations/VALIDATION.md`
- Push + PR pra `main`

---

## Phase A — Backend Rust (`spawn_claude_investigation`)

Comando novo em `external.rs`. Reusa pattern de `spawn_claude` (linhas 73-91) — mesmo Ghostty + PATH fix + `spawn_detached` helper.

### Task A1: Adicionar `uuid` ao workspace deps

**Files:**
- Modify: `src-tauri/Cargo.toml`

> **Por que UUID:** precisamos de nome único pro arquivo temp em `/tmp` (evitar colisão se user fizer múltiplos spawns paralelos). `uuid` v4 gera IDs aleatórios.

- [ ] **Step 1: Verificar se uuid já existe**

```bash
grep -n "uuid" src-tauri/Cargo.toml | head -5
```

Se já tiver no `[workspace.dependencies]`, pular pro step 4. Se não, seguir.

- [ ] **Step 2: Adicionar uuid no workspace**

Edita `src-tauri/Cargo.toml`. No bloco `[workspace.dependencies]`, adiciona:

```toml
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 3: Adicionar uuid ao crate principal (lib)**

No mesmo `Cargo.toml`, no bloco `[dependencies]` do crate principal (não do `monitor-agent`/`monitor-shared` — o crate root):

```toml
uuid = { workspace = true }
```

- [ ] **Step 4: Build smoke**

```bash
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: `Finished dev profile`, sem erros.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore: add uuid v4 dep pra arquivo temp do spawn Claude investigation"
```

### Task A2: Comando `spawn_claude_investigation`

**Files:**
- Modify: `src-tauri/src/external.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Adicionar imports + helper de cleanup**

Edita `src-tauri/src/external.rs`. No topo, adiciona ao bloco de uses:

```rust
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use uuid::Uuid;
```

(Os imports `use std::path::PathBuf` e `use std::process::{Command, Stdio}` já existem.)

- [ ] **Step 2: Escrever testes ANTES da implementação (TDD)**

Adiciona ao final de `external.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_existing_directory_returns_same() {
        // /tmp existe e é diretório — deve passar
        let result = validate_or_fallback_dir(&PathBuf::from("/tmp"));
        assert_eq!(result, PathBuf::from("/tmp"));
    }

    #[test]
    fn falls_back_when_target_missing() {
        // Diretório inexistente → fallback ao launcher
        let nonexistent = PathBuf::from("/tmp/this-path-does-not-exist-9zX");
        let result = validate_or_fallback_dir(&nonexistent);
        // Fallback é home do user + Projects/falcao-launcher
        let home = dirs::home_dir().unwrap();
        assert_eq!(result, home.join("Projects").join("falcao-launcher"));
    }

    #[test]
    fn falls_back_when_target_is_file_not_dir() {
        // Cria um arquivo temp e tenta validar como dir
        let file_path = std::env::temp_dir().join("test-not-a-dir.txt");
        std::fs::write(&file_path, b"not a dir").unwrap();
        let result = validate_or_fallback_dir(&file_path);
        let home = dirs::home_dir().unwrap();
        assert_eq!(result, home.join("Projects").join("falcao-launcher"));
        std::fs::remove_file(&file_path).ok();
    }

    #[test]
    fn writes_prompt_with_secure_permissions() {
        let prompt = "## Test prompt\n\nHello Claude.";
        let path = write_prompt_to_tmp(prompt).expect("should write");
        // Confirma conteúdo
        let content = std::fs::read_to_string(&path).unwrap();
        assert_eq!(content, prompt);
        // Confirma permissões 600 (só user lê/escreve)
        let metadata = std::fs::metadata(&path).unwrap();
        let mode = metadata.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        // Cleanup
        std::fs::remove_file(&path).ok();
    }
}
```

- [ ] **Step 3: Rodar testes pra verificar que falham (helpers ainda não existem)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p falcao-launcher external::tests 2>&1 | tail -10
```

Expected: erros de compilação (`validate_or_fallback_dir` e `write_prompt_to_tmp` não definidos).

- [ ] **Step 4: Implementar helpers + comando**

Edita `external.rs`. Adiciona os helpers privados antes do `mod tests` (mas depois do `spawn_claude` existente):

```rust
/// Valida que `target_dir` existe e é um diretório.
/// Se inválido, faz fallback pra `~/Projects/falcao-launcher` (sempre existe
/// pelo nosso ambiente). Retorna o caminho efetivo a usar.
fn validate_or_fallback_dir(target: &std::path::Path) -> PathBuf {
    if target.is_dir() {
        return target.to_path_buf();
    }
    // Fallback ao launcher dir
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let fallback = home.join("Projects").join("falcao-launcher");
    eprintln!(
        "[spawn_claude_investigation] target_dir inválido ({:?}), usando fallback: {:?}",
        target, fallback
    );
    fallback
}

/// Escreve o prompt em /tmp/falcao-investigation-<uuid>.md com chmod 600
/// (só user lê/escreve). Retorna o path do arquivo gerado.
fn write_prompt_to_tmp(prompt: &str) -> Result<PathBuf, String> {
    let id = Uuid::new_v4();
    let path = std::env::temp_dir().join(format!("falcao-investigation-{}.md", id));

    let mut file = fs::File::create(&path)
        .map_err(|e| format!("não foi possível criar {:?}: {}", path, e))?;
    file.write_all(prompt.as_bytes())
        .map_err(|e| format!("não foi possível escrever em {:?}: {}", path, e))?;

    // chmod 600 (só user)
    let mut perms = file.metadata().map_err(|e| e.to_string())?.permissions();
    perms.set_mode(0o600);
    fs::set_permissions(&path, perms)
        .map_err(|e| format!("não foi possível setar permissions: {}", e))?;

    Ok(path)
}

/// Spawna Claude Code numa janela Ghostty nova, com prompt pré-formatado
/// vindo do `AnalysisContext` do modo análise. Auto-fallback do diretório
/// se o destino sugerido pela UI não existir.
///
/// Fluxo:
///   1. Resolve target_dir (existe? senão fallback launcher dir)
///   2. Escreve prompt em /tmp/falcao-investigation-<uuid>.md (chmod 600)
///   3. Spawna ghostty fire-and-forget executando:
///        bash -c "claude < /tmp/<file>; rm -f /tmp/<file>"
///      (cleanup automático após Claude consumir o stdin)
///   4. Retorna ok — UI fecha modal
#[tauri::command]
pub fn spawn_claude_investigation(
    prompt_markdown: String,
    target_dir: String,
) -> Result<(), String> {
    let target = PathBuf::from(&target_dir);
    let effective_dir = validate_or_fallback_dir(&target);
    let prompt_path = write_prompt_to_tmp(&prompt_markdown)?;

    // bash -c lê arquivo via stdin (driblando argv limit ~128KB) e remove
    // depois. ; em vez de && garante remove mesmo se claude falhar.
    let bash_cmd = format!(
        "claude < {0:?}; rm -f {0:?}",
        prompt_path.display().to_string()
    );

    let mut cmd = Command::new("ghostty");
    cmd.arg(format!("--working-directory={}", effective_dir.display()))
        .arg("-e")
        .arg("bash")
        .arg("-c")
        .arg(&bash_cmd);

    // PATH com ~/.local/bin (mesmo fix do spawn_claude)
    if let Some(home) = dirs::home_dir() {
        let local_bin = home.join(".local").join("bin");
        let current_path = std::env::var("PATH")
            .unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into());
        cmd.env("PATH", format!("{}:{}", local_bin.display(), current_path));
    }

    spawn_detached(&mut cmd).map_err(|e| format!("falha ao spawnar Claude investigation: {}", e))
}
```

- [ ] **Step 5: Registrar comando em `lib.rs`**

```bash
grep -n "spawn_claude\|generate_handler" src-tauri/src/lib.rs | head -5
```

Confirma onde está o `tauri::generate_handler!`. Edita `src-tauri/src/lib.rs` adicionando `external::spawn_claude_investigation,` na lista, logo após `external::spawn_claude,` (ou no padrão da seção de comandos external).

- [ ] **Step 6: Rodar todos os testes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p falcao-launcher external::tests 2>&1 | tail -15
```

Expected: 4 testes novos passando + qualquer existente do mesmo módulo. Full suite (`-p falcao-launcher` sem filtro): todos os ~33 testes passam, sem regressões.

- [ ] **Step 7: Build smoke**

```bash
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: build limpo, sem warnings novos.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/external.rs src-tauri/src/lib.rs
git commit -m "feat(claude): comando spawn_claude_investigation

- Aceita prompt_markdown + target_dir
- validate_or_fallback_dir: fallback automático a ~/Projects/falcao-launcher
  se target_dir não existe ou não é dir
- write_prompt_to_tmp: /tmp/falcao-investigation-<uuid>.md chmod 600
- Spawn fire-and-forget: ghostty + bash -c 'claude < file; rm -f file'
  (stdin redirect dribla argv limit pra prompts grandes; cleanup auto)
- PATH inclui ~/.local/bin (mesmo fix do spawn_claude existente)
- 4 testes unitários (validate dir + fallback + permissions)"
```

---

## Phase B — TS puros (paralelizável com Phase A)

### Task B1: `serializeAnalysis.ts` — gerador do prompt Markdown

**Files:**
- Create: `src/lib/serializeAnalysis.ts`

- [ ] **Step 1: Criar arquivo**

Cria `src/lib/serializeAnalysis.ts`:

```typescript
import type { AnalysisContext, MetricRef } from "../types/analysis";
import type { MetricPoint } from "../types/monitor";

const MAX_POINTS_PER_CHART = 1000;
const MAX_LOG_CHARS = 200_000;

/**
 * Serializa o `AnalysisContext` em prompt Markdown estruturado pro Claude
 * Code consumir como primeira mensagem da conversa.
 *
 * Template:
 *   # Investigação · <métrica primária> · <ISO timestamp>
 *   ## Contexto
 *   ## Métricas observadas (uma seção por chart, série em CSV)
 *   ## Logs do período
 *   ## Pergunta
 *
 * Truncamento defensivo:
 *   - Séries com > MAX_POINTS_PER_CHART são truncadas com nota
 *   - Logs > MAX_LOG_CHARS são truncados com nota
 */
export function serializeContextToMarkdown(
  context: AnalysisContext,
  question: string,
): string {
  const sections: string[] = [];

  // Header
  const primaryLabel = formatMetricLabel(context.charts[0]?.metric);
  const now = new Date().toISOString();
  sections.push(`# Investigação · ${primaryLabel} · ${now}`);

  // Seção: Contexto
  sections.push(formatContextSection(context));

  // Seção: Métricas observadas
  sections.push(formatMetricsSection(context));

  // Seção: Logs (se houver)
  if (context.logs.text != null) {
    sections.push(formatLogsSection(context));
  }

  // Seção: Pergunta
  sections.push(`## Pergunta\n\n${question.trim() || "(sem pergunta — analise os dados acima)"}`);

  // Footer
  sections.push("---\n\n*Investigação gerada pelo falcao-launcher · modo análise*");

  return sections.join("\n\n");
}

// ─── Helpers (não exportados) ─────────────────────────────────────────────

function formatMetricLabel(metric: MetricRef | undefined): string {
  if (!metric) return "(sem métrica)";
  if (metric.kind === "container") {
    return `container ${metric.resource} · ${metric.metric}`;
  }
  return `${metric.kind.toUpperCase()} · ${metric.metric}`;
}

function formatContextSection(context: AnalysisContext): string {
  const lines: string[] = ["## Contexto", ""];

  const startIso = context.range.start.toISOString();
  const endIso = context.range.end.toISOString();
  const durationMs = context.range.end.getTime() - context.range.start.getTime();
  const durationMin = Math.round(durationMs / 60_000);

  lines.push(`- **Range:** ${startIso} → ${endIso} (${durationMin} min)`);
  lines.push(`- **Preset:** ${context.preset} carregado`);
  lines.push(`- **Layout:** ${context.layout.name ?? "rascunho não salvo"}`);
  lines.push(`- **Charts visíveis:** ${context.charts.length}`);

  return lines.join("\n");
}

function formatMetricsSection(context: AnalysisContext): string {
  const lines: string[] = ["## Métricas observadas", ""];

  for (const chart of context.charts) {
    const label = formatMetricLabel(chart.metric);
    const bucket = chart.bucket ?? "raw";
    const totalPoints = chart.series.length;

    lines.push(`### ${label}`);
    lines.push(`Bucket: ${bucket} · ${totalPoints} pontos`);
    lines.push("");
    lines.push("```csv");
    lines.push("ts,value");

    const truncated = totalPoints > MAX_POINTS_PER_CHART;
    const points = truncated
      ? chart.series.slice(0, MAX_POINTS_PER_CHART)
      : chart.series;

    for (const p of points) {
      lines.push(`${p.ts},${p.value ?? ""}`);
    }
    if (truncated) {
      lines.push(`... (truncated, ${totalPoints} pontos no total)`);
    }

    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}

function formatLogsSection(context: AnalysisContext): string {
  const lines: string[] = [];
  const containerLabel = context.logs.container ?? "(sem container)";
  lines.push(`## Logs do período · container: ${containerLabel}`);
  lines.push("");

  let text = context.logs.text ?? "";
  let truncated = false;

  if (text.length > MAX_LOG_CHARS) {
    text = text.slice(0, MAX_LOG_CHARS);
    truncated = true;
  }

  lines.push("```");
  lines.push(text);
  if (truncated) {
    lines.push("... (truncated by launcher — refine o range pra ver mais)");
  }
  if (context.logs.truncated) {
    lines.push("... (também truncated em 2000 linhas pelo docker --tail)");
  }
  lines.push("```");

  return lines.join("\n");
}

/** Estima tamanho do prompt sem gerar ele inteiro — usado pra preview no modal. */
export function estimatePromptSize(context: AnalysisContext): {
  bytes: number;
  charts: number;
  logLines: number;
} {
  let bytes = 1000; // overhead de header/seções
  let logLines = 0;

  for (const chart of context.charts) {
    // ~30 bytes por linha CSV
    bytes += Math.min(chart.series.length, MAX_POINTS_PER_CHART) * 30;
    bytes += 100; // overhead de seção
  }

  if (context.logs.text != null) {
    const text = context.logs.text.slice(0, MAX_LOG_CHARS);
    bytes += text.length;
    logLines = text.split("\n").length;
  }

  return {
    bytes,
    charts: context.charts.length,
    logLines,
  };
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/serializeAnalysis.ts
git commit -m "feat(claude): serializeContextToMarkdown — Markdown estruturado pro prompt

- Header com métrica primária + timestamp
- Seções: Contexto / Métricas (CSV por chart) / Logs / Pergunta
- Truncamento defensivo: 1000 pontos por chart, 200KB de logs
- estimatePromptSize() pra preview no modal (sem gerar tudo)"
```

### Task B2: `resolveTargetDir.ts` — auto-detect do diretório

**Files:**
- Create: `src/lib/resolveTargetDir.ts`

- [ ] **Step 1: Criar arquivo**

Cria `src/lib/resolveTargetDir.ts`:

```typescript
import type { MetricRef } from "../types/analysis";

/**
 * Decide em qual diretório o Claude Code deve abrir baseado na métrica
 * primária da investigação.
 *
 * Convenção: nome do container Docker == nome do projeto local em ~/Projects.
 *   - container.resource = "falcao-financas" → ~/Projects/falcao-financas
 *   - kind vm/hetzner → fallback ~/Projects/falcao-launcher (overall context)
 *
 * O home é hardcoded pra Falcão. Se for portar pra outra máquina, mover pra
 * config (ex: monitorApi.getHomeDir() retorna do Rust).
 *
 * O Rust faz fallback automático ao launcher dir se este diretório não existe
 * — frontend não precisa checar fs.
 */
const HOME = "/home/falcao";

export function resolveTargetDir(metric: MetricRef): string {
  if (metric.kind === "container") {
    return `${HOME}/Projects/${metric.resource}`;
  }
  return `${HOME}/Projects/falcao-launcher`;
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/resolveTargetDir.ts
git commit -m "feat(claude): resolveTargetDir — auto-detect diretório baseado na métrica

- container.resource → ~/Projects/<name>
- vm/hetzner → ~/Projects/falcao-launcher (fallback overall)
- Rust faz validação fs (path inexistente → fallback launcher)"
```

### Task B3: `monitorApi.spawnClaudeInvestigation` wrapper

**Files:**
- Modify: `src/lib/monitor.ts`

- [ ] **Step 1: Adicionar método ao monitorApi**

Edita `src/lib/monitor.ts`. Encontra o objeto `monitorApi` e adiciona depois de `fetchLogsRange`:

```typescript
  spawnClaudeInvestigation: (promptMarkdown: string, targetDir: string) =>
    invoke<void>("spawn_claude_investigation", {
      promptMarkdown,
      targetDir,
    }),
```

> **Nota Tauri:** `invoke` no JS converte camelCase pra snake_case automaticamente (`promptMarkdown` → `prompt_markdown`).

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/monitor.ts
git commit -m "feat(claude): monitorApi.spawnClaudeInvestigation wrapper"
```

---

## Phase C — Frontend integration

### Task C1: `ClaudeInvestigationModal.tsx`

**Files:**
- Create: `src/components/ClaudeInvestigationModal.tsx`

- [ ] **Step 1: Criar componente**

Cria `src/components/ClaudeInvestigationModal.tsx`:

```tsx
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

const PLACEHOLDER = "Ex: Por que o pico de CPU às 14:35? Quais erros aparecem nos logs nesse período?";

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
      // Autofocus depois da animação
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
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Verificar tokens CSS usados**

```bash
grep -E "color-danger-soft|color-bg-card|color-bg-primary|color-bg-secondary|color-accent-primary|color-accent-secondary|color-border-subtle|color-text-primary|color-text-secondary|color-text-muted|color-danger" src/App.css | head -10
```

Confirma que todos existem. Se faltar `color-accent-secondary`: trocar por `bg-[var(--color-accent-primary)]/80` no Step 1.

- [ ] **Step 4: Commit**

```bash
git add src/components/ClaudeInvestigationModal.tsx
git commit -m "feat(claude): ClaudeInvestigationModal — textarea pra pergunta + spawn

- Resumo do contexto: charts/range/logs lines + tamanho estimado do prompt
- textarea autofocus ~5 linhas, placeholder com sugestão
- Botão Spawnar disabled enquanto pergunta vazia ou loading
- Esc/click overlay fecha (exceto durante loading)
- Erro inline (mantém modal aberto pra retentar)
- Reusa modalVariants/overlayVariants do animations.ts"
```

### Task C2: Integração no `AnalysisPage` (botão + state + capturar context)

**Files:**
- Modify: `src/components/AnalysisPage.tsx`

- [ ] **Step 1: Capturar return do useAnalysisContext + state do modal**

Edita `src/components/AnalysisPage.tsx`. Encontra a linha 68-80 (chamada de `useAnalysisContext`) e modifica pra capturar o retorno:

```tsx
// Context serializável (consumido pelo ClaudeInvestigationModal — Sprint 4)
const analysisContext = useAnalysisContext({
  preset,
  presetRange,
  brushRange,
  charts: charts.map((slot) => ({
    slot,
    bucket: params.bucket,
    series: chartSeriesById[slot.id] ?? [],
  })),
  logsContainer: lastFetchedLogs?.container ?? null,
  lastFetchedLogs,
  layout: layoutsApi.currentLayout,
});
```

- [ ] **Step 2: Adicionar import + state do modal**

No topo do arquivo, perto dos outros imports de componentes:

```tsx
import { ClaudeInvestigationModal } from "./ClaudeInvestigationModal";
```

E dentro da função `AnalysisPage`, perto dos outros `useState` (logo após `lastFetchedLogs`):

```tsx
const [claudeModalOpen, setClaudeModalOpen] = useState(false);
```

- [ ] **Step 3: Estado derivado `analysisReady`**

Adicionar abaixo das declarações de state, antes dos handlers:

```tsx
// Pronto pra investigar quando todos os charts retornaram série (mesmo vazia).
// Charts em loading retornam null pelo polling; só populam quando fetch ok.
const analysisReady = charts.every(
  (slot) => chartSeriesById[slot.id] !== undefined,
);
```

- [ ] **Step 4: Adicionar botão no header**

Encontra o bloco header com `← Voltar pra VM` e `<AnalysisLayoutPicker>`. Adiciona o botão entre eles:

```tsx
<div className="flex flex-wrap items-center justify-between gap-3">
  <button
    onClick={onBack}
    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-1 text-sm text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
  >
    ← Voltar pra VM
  </button>

  {/* Botão Investigar com Claude */}
  <button
    onClick={() => setClaudeModalOpen(true)}
    disabled={!analysisReady}
    className="rounded-md border border-[var(--color-accent-primary)]/40 bg-[var(--color-bg-secondary)] px-3 py-1 text-sm text-[var(--color-accent-primary)] transition hover:bg-[var(--color-accent-primary)]/10 disabled:cursor-not-allowed disabled:opacity-40"
    title={analysisReady ? "Abrir Claude Code com este contexto" : "Aguardando dados…"}
  >
    🤖 Investigar com Claude
  </button>

  <AnalysisLayoutPicker
    layouts={layoutsApi.layouts}
    {/* ...existente... */}
  />
</div>
```

- [ ] **Step 5: Renderizar o modal no fim da árvore JSX**

Encontra o `return` do componente. Antes do `</div>` final que fecha o wrapper externo, adiciona:

```tsx
<ClaudeInvestigationModal
  context={analysisContext}
  primaryMetric={charts[0]?.metric ?? initialMetric}
  open={claudeModalOpen}
  onClose={() => setClaudeModalOpen(false)}
/>
```

- [ ] **Step 6: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros. Se houver erro com `analysisContext` undefined, conferir Step 1 — precisa ter capturado o return.

- [ ] **Step 7: Commit**

```bash
git add src/components/AnalysisPage.tsx
git commit -m "feat(claude): botão Investigar com Claude no header do AnalysisPage

- useAnalysisContext agora retorna o context (em vez de descartado)
- State claudeModalOpen + analysisReady (todos charts populados)
- Botão entre 'Voltar' e LayoutPicker, disabled enquanto charts carregam
- ClaudeInvestigationModal renderizado no fim da árvore"
```

---

## Phase D — Validação manual

### Task D1: Smoke build + reinstall + 5 fluxos

> **Não é task de código** — é checkpoint de validação. Falcão executa.

- [ ] **Step 1: Build release + reinstall**

```bash
pnpm tauri build --bundles deb,rpm 2>&1 | tail -3
rm -f ~/.local/bin/falcao-launcher
cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher
echo "binário reinstalado: $(ls -la ~/.local/bin/falcao-launcher | awk '{print $5, $9}')"
```

Expected: bundles gerados, binário copiado.

- [ ] **Step 2: Smoke fluxo 1 — botão disabled enquanto carrega**

Falcão abre o launcher, vai na aba VM, click num chart pra entrar em análise. **Imediatamente** (antes dos charts populerem) o botão "🤖 Investigar com Claude" deve estar disabled com tooltip "Aguardando dados…".

Após ~1-2s (quando charts populerem) → botão fica enabled.

- [ ] **Step 3: Smoke fluxo 2 — modal abre + textarea autofocus**

Click no botão "🤖 Investigar com Claude". Modal abre, textarea recebe foco (cursor pisca). Pode digitar. Botão "Spawnar" fica disabled enquanto textarea vazio.

- [ ] **Step 4: Smoke fluxo 3 — spawn com auto-detect container**

Volta pra dashboard, click num container `falcao-financas` (`VmContainerCard` → `VmContainerDrawer` → botão "🔍 Investigar período"). Análise abre com chart de CPU do container.

Click "🤖 Investigar com Claude" → modal abre → digita "Por que esse pico?" → click Spawnar.

Expected:
- Modal fecha
- Janela Ghostty nova abre em `~/Projects/falcao-financas/`
- Claude Code consome o prompt e responde
- Após segundos, ClaudeChip do projeto `falcao-financas` na aba Projetos mostra a sessão nova

- [ ] **Step 5: Smoke fluxo 4 — spawn com fallback (VM Load)**

Volta pra dashboard. Click no chart "Load 1m" da seção VM geral → análise abre.

Click "🤖 Investigar com Claude" → digita "Spike incomum?" → Spawnar.

Expected:
- Janela Ghostty abre em `~/Projects/falcao-launcher/` (fallback do `kind: "vm"`)
- Claude consome prompt

- [ ] **Step 6: Smoke fluxo 5 — prompt grande**

Na análise, configura preset 24h, brusha um período largo, busca logs (max 2000 linhas), adiciona 6 charts no grid. Click Investigar com Claude.

Expected: prompt provavelmente >100KB. Spawn deve funcionar (stdin redirect dribla argv limit). Janela Ghostty abre, Claude consome.

Confere `/tmp/falcao-investigation-*.md` durante o spawn — arquivo existe com chmod 600. Após Claude consumir, arquivo é removido (cleanup do `bash -c`).

```bash
ls -la /tmp/falcao-investigation-*.md 2>&1 | tail -3
```

- [ ] **Step 7: Reportar**

Se algum fluxo falhar — report e corrige antes de Phase E. Se todos verdes — Phase E.

---

## Phase E — Docs + PR

### Task E1: Atualizar agent.md

**Files:**
- Modify: `src-tauri/src/.agent.md`
- Modify: `src/components/.agent.md`
- Modify: `src/lib/.agent.md`

- [ ] **Step 1: `src-tauri/src/.agent.md`**

Procura a entrada de `external.rs`. Se houver "Decisões recentes" no arquivo do módulo, adiciona:

```markdown
- 2026-05-07 (Sprint 4 — integração Claude): comando novo `spawn_claude_investigation(prompt_markdown, target_dir)`. Reusa pattern de `spawn_claude` (Ghostty + PATH `~/.local/bin`). Helpers: `validate_or_fallback_dir` (fallback ao launcher se target inválido), `write_prompt_to_tmp` (UUID v4, chmod 600). Spawn `bash -c "claude < /tmp/<id>.md; rm -f /tmp/<id>.md"` — stdin redirect dribla argv limit pra prompts grandes (~200KB). 4 testes unitários nos helpers.
```

- [ ] **Step 2: `src/components/.agent.md`**

Adiciona nova seção:

```markdown
### Sprint 4 — Integração Claude

- **`ClaudeInvestigationModal.tsx`** — modal pequeno chamado pelo header do AnalysisPage. Resumo do contexto (charts/range/logs/tamanho estimado) + textarea autofocus pra pergunta + botão "🚀 Spawnar Claude". Submit chama `serializeContextToMarkdown` + `monitorApi.spawnClaudeInvestigation`. Esc/overlay click fecha exceto durante loading.
- **Mods Sprint 4:**
  - `AnalysisPage.tsx`: `useAnalysisContext` agora retorna o context (deixa de ser descartado). State `claudeModalOpen`, derivado `analysisReady` (todos charts populados). Botão "🤖 Investigar com Claude" no header, disabled enquanto carrega.
```

- [ ] **Step 3: `src/lib/.agent.md`**

Adiciona arquivos novos:

```markdown
- `serializeAnalysis.ts` — Sprint 4: `serializeContextToMarkdown(context, question)` gera prompt Markdown estruturado (Contexto / Métricas em CSV / Logs / Pergunta). Truncamento: 1000 pontos por chart, 200KB de logs. `estimatePromptSize()` pra preview no modal.
- `resolveTargetDir.ts` — Sprint 4: auto-detect do diretório onde Claude Code abre. Convenção: `container.resource` → `~/Projects/<name>`; `vm`/`hetzner` → `~/Projects/falcao-launcher`. Rust faz fallback se path inexistente.
- `monitorApi.spawnClaudeInvestigation(promptMarkdown, targetDir)` — Sprint 4.
```

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/.agent.md src/components/.agent.md src/lib/.agent.md
git commit -m "docs(agent): Sprint 4 — integração Claude"
```

### Task E2: Atualizar CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Adicionar seção após "Feature: Modo análise (Sprint 3)"**

Edita `CLAUDE.md`. Encontra a seção da Sprint 3 e adiciona depois:

```markdown
## Feature: Investigar com Claude (Sprint 4)

Botão no header do `AnalysisPage` que abre Claude Code numa janela Ghostty nova com o `AnalysisContext` atual já formatado como prompt Markdown estruturado, partindo do diretório do projeto sendo investigado (auto-detect).

- **Spec:** `docs/superpowers/specs/2026-05-07-claude-integration-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-07-claude-integration.md`
- **Backend novo:** `spawn_claude_investigation` em `src-tauri/src/external.rs`. Reusa pattern de `spawn_claude` (Ghostty + PATH fix `~/.local/bin`). Mecanismo: `/tmp/falcao-investigation-<uuid>.md` chmod 600 + `bash -c "claude < <file>; rm -f <file>"` (stdin redirect dribla argv limit pra prompts grandes ~200KB).
- **Auto-detect:** `container.resource` → `~/Projects/<name>`; `vm`/`hetzner` → `~/Projects/falcao-launcher` (fallback).
- **Reuso:** `useAnalysisContext` (Sprint 3) consumido literalmente. Sessão Claude resultante é trackeada automaticamente pelo sistema de Claude awareness via `ClaudeChip`.

### Componentes/hooks novos (Sprint 4)
- `src/components/ClaudeInvestigationModal.tsx` — modal com textarea pra pergunta.
- `src/lib/serializeAnalysis.ts` — gerador do prompt Markdown.
- `src/lib/resolveTargetDir.ts` — auto-detect do diretório.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md ganhou seção Sprint 4 — integração Claude"
```

### Task E3: Atualizar VALIDATION.md

**Files:**
- Modify: `docs/superpowers/vm-migrations/VALIDATION.md`

- [ ] **Step 1: Adicionar seção ao final**

```bash
cat >> docs/superpowers/vm-migrations/VALIDATION.md <<'EOF'

---

## Sprint 4 — Integração Claude (2026-05-07)

Spec: `docs/superpowers/specs/2026-05-07-claude-integration-design.md`
Plan: `docs/superpowers/plans/2026-05-07-claude-integration.md`

### Acceptance criteria (12 itens do spec)

- [x] Botão "🤖 Investigar com Claude" aparece no header do AnalysisPage
- [x] Botão fica disabled enquanto charts carregam
- [x] Click abre ClaudeInvestigationModal com textarea autofocus
- [x] Resumo do contexto correto (N charts · range · M linhas de logs)
- [x] serializeContextToMarkdown produz markdown válido com 4 seções
- [x] Tamanho do prompt sem limite efetivo (testado >100KB via stdin redirect)
- [x] Spawnar abre Ghostty + Claude no diretório correto (auto-detect funciona)
- [x] Fallback ao launcher dir funciona se auto-detect aponta pra dir inexistente
- [x] Prompt temp em /tmp/falcao-investigation-<uuid>.md chmod 600, deletado após Claude consumir
- [x] Sessão Claude aparece no ClaudeChip do projeto destino (sistema existente)
- [x] cargo test passa (4 testes Rust novos: validate dir + fallback + permissions)
- [x] Documentação atualizada (3 agent.md + CLAUDE.md)

### Observações operacionais

- **stdin redirect via `bash -c`** funcionou bem com Claude Code v1+. Não testado com versão diferente.
- **Cleanup automático** do `/tmp` via `; rm -f` — se Claude crashar antes de consumir, arquivo fica até reboot do OS (aceito).
- **PATH fix** reusado de `spawn_claude` — `~/.local/bin` prepended explicitamente porque GNOME-launched apps herdam PATH minimalista.
- **chmod 600** no arquivo temp — só user lê/escreve. Logs com tokens em stack traces ficam protegidos de outros users (não-vetor real, mas higiene).

### Phase 5 backlog reconhecido

- **Web App PWA** (alta prioridade — Falcão pediu desde o início) — versão browser do launcher pra acesso pelo celular.
- **Alertas + Telegram bot** — push notifications pra alertas configuráveis.
- **Sumário estatístico do contexto** (toggle no modal) — pra reduzir custo de tokens em prompts grandes.
- **Filtro de logs sensíveis** — redact tokens/senhas antes de mandar pro Claude.
EOF
echo "OK"
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/vm-migrations/VALIDATION.md
git commit -m "docs(validation): seção Sprint 4 — integração Claude (12 acceptance criteria)"
```

### Task E4: Push branch + abrir PR pra main

- [ ] **Step 1: Push**

```bash
git push -u origin feature/claude-integration 2>&1 | tail -5
```

- [ ] **Step 2: Abrir PR**

```bash
gh pr create --base main --head feature/claude-integration \
  --title "feat(monitor): Sprint 4 — integração Claude no modo análise" \
  --body "$(cat <<'EOF'
## Summary

Botão **"🤖 Investigar com Claude"** no header do `AnalysisPage` que abre Claude Code numa janela Ghostty nova com o `AnalysisContext` atual já formatado como prompt Markdown estruturado, partindo do diretório do projeto sendo investigado (auto-detect).

## Spec & plan

- Spec: `docs/superpowers/specs/2026-05-07-claude-integration-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-claude-integration.md`
- Validation: `docs/superpowers/vm-migrations/VALIDATION.md` (seção Sprint 4)

## O que entrou

### Backend Rust
- Comando `spawn_claude_investigation(prompt_markdown, target_dir)` em `src-tauri/src/external.rs`
- Helpers: `validate_or_fallback_dir`, `write_prompt_to_tmp` (UUID v4, chmod 600)
- 4 testes unitários (validate dir, fallback, file→dir, permissions)
- Reusa `spawn_detached` + PATH fix `~/.local/bin` do `spawn_claude` existente
- Mecanismo: `/tmp/falcao-investigation-<uuid>.md` + `bash -c "claude < <file>; rm -f <file>"` (stdin redirect dribla argv limit pra prompts ~200KB)

### Frontend
- `src/lib/serializeAnalysis.ts` — gerador Markdown estruturado (Contexto/Métricas em CSV/Logs/Pergunta) + estimatePromptSize
- `src/lib/resolveTargetDir.ts` — auto-detect (container.resource → ~/Projects/<name>; vm/hetzner → ~/Projects/falcao-launcher)
- `src/components/ClaudeInvestigationModal.tsx` — modal com textarea autofocus + botão Spawnar
- `monitorApi.spawnClaudeInvestigation` wrapper
- `AnalysisPage`: useAnalysisContext agora retorna context, state do modal, botão no header

### Stack
- `uuid` v4 adicionado às deps Rust (workspace)
- Sem deps frontend novas

## Decisões D1-D6 (do spec)

| | |
|---|---|
| D1 | Spawn Claude Code CLI (não API/MCP) |
| D2 | Contexto inteiro serializado (séries cruas + logs completos) |
| D3 | Auto-detect target_dir (container → projeto local, fallback launcher) |
| D4 | Markdown estruturado |
| D5 | Modal pequeno com textarea |
| D6 | Único botão no header do AnalysisPage |

## Acceptance

12 critérios validados — ver VALIDATION.md.

## Test plan

- [x] cargo test (4 testes novos passando)
- [x] tsc --noEmit clean
- [x] Build release sem warnings novos
- [x] Smoke manual: 5 fluxos (disabled durante load, modal autofocus, spawn auto-detect container, spawn fallback VM, prompt grande >100KB)

## Phase 5 backlog reconhecido

- Web App PWA (próxima Sprint)
- Alertas + Telegram bot
- Toggle resumo estatístico (reduzir tokens)
- Filtro de logs sensíveis (redact tokens)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: URL do PR retornado.

---

## Resumo das fases

| Phase | Escopo | Tempo estimado |
|---|---|---|
| **A** | Backend Rust (uuid + spawn_claude_investigation + 4 testes) | ~30 min |
| **B** | TS puros (serializeAnalysis + resolveTargetDir + monitorApi wrapper) | ~30 min |
| **C** | Modal + integração no AnalysisPage | ~45 min |
| **D** | Smoke manual (5 fluxos) | ~30 min |
| **E** | Docs (3 agent.md + CLAUDE.md + VALIDATION) + PR | ~30 min |
| **Total sequencial** | | **~3h** |
| **Com paralelização** | A ‖ B (em worktrees isolados — pastas disjuntas) | **~2h** |

## Paralelização recomendada

**Round 1 (paralelo):** Phase A (Rust) ‖ Phase B (TS puros) — pastas totalmente disjuntas (`src-tauri/` vs `src/lib/`)
**Round 2 (sequencial):** Phase C (depende de B + A já mergeados pra integration testar)
**Round 3 (sequencial):** Phase D (Falcão valida) → Phase E (docs + PR)

## Riscos de execução

1. **Claude Code CLI não consome bem stdin >100KB** — em teoria deveria, mas não testado. Mitigação: se detectar quebra, fallback pra escrever prompt num arquivo e abrir Claude com `claude --file <path>` (se a flag existir) ou copy-paste manual pelo user.
2. **Ghostty `--working-directory` flag mudou** — testado em `spawn_claude` atual, vale validar. Se mudou, sintaxe nova fica como nota.
3. **PATH `~/.local/bin` injection** — pattern já validado em `spawn_claude`. Se quebrar lá, quebra aqui.
4. **`uuid` crate API mudou** — versão 1.x estável, baixíssimo risco.
5. **Auto-detect errado pra container `caddy`** — não tem projeto local, fallback ao launcher cobre. Aceito.
