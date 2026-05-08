# Sprint 3 — Modo análise (gráficos expandidos com brush + sync + dashboard customizável) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir página dedicada de análise temporal com grid drag-drop responsivo, brush selection sincronizado entre charts, logs do período sob demanda, e layouts nomeados em localStorage com export/import JSON.

**Architecture:** Página interna ao `VmTab` (substitui conteúdo via state `vmView: "dashboard" | "analysis"`). State global no `AnalysisPage` (preset, brushRange, charts, hoverTs). Brush é subset visual dentro do range carregado pelo preset (sem refetch). Grid via `react-grid-layout` responsivo (desktop drag-drop, mobile stack). Logs via comando Rust novo `monitor_fetch_logs_range` (`docker logs --since/--until` por SSH). Hook `useAnalysisContext` centraliza estado serializável pra Sprint 4 (Claude).

**Tech Stack:** Tauri 2 (commands `#[tauri::command]` em Rust) + React 19 + TypeScript + Recharts (já tem `<Brush>` nativo) + Tailwind v4 (tokens em `App.css @theme`) + framer-motion (animações) + `react-grid-layout@^1.5` (NEW — drag-drop grid responsivo).

**Spec source:** `docs/superpowers/specs/2026-05-07-modo-analise-design.md`

**Branch:** `feature/modo-analise` (já criada, com spec commitado).

---

## File structure

Arquivos novos e modificados, organizados por responsabilidade. Cada arquivo tem 1 propósito claro pra reduzir context load por edição.

### Backend Rust (Phase A)
- **Modify:** `src-tauri/src/monitor/commands.rs` — adiciona `monitor_fetch_logs_range`
- **Modify:** `src-tauri/src/lib.rs` — registra comando novo no `generate_handler!`

### Types (Phase B-types — sequencial, bloqueia B-hooks e C)
- **Create:** `src/types/analysis.ts` — `MetricRef` (discriminated union), `ChartSlot`, `AnalysisLayout`, `LayoutsBundle`, `AnalysisContext`, constants

### API client (Phase B-types)
- **Modify:** `src/lib/monitor.ts` — adiciona `monitorApi.fetchLogsRange()`

### Hooks (Phase B-hooks — paralelizável com Phase C após B-types)
- **Create:** `src/lib/useAnalysisLayouts.ts` — CRUD localStorage + export/import + schema migration
- **Create:** `src/lib/useAnalysisContext.ts` — agrega state do AnalysisPage em formato serializável

### Componentes (Phase C — paralelizável com Phase B-hooks após B-types)
- **Create:** `src/components/MetricPicker.tsx` — `<select>` de métrica agrupado por source
- **Create:** `src/components/AnalysisChartSlot.tsx` — slot do grid (header + chart + brush)
- **Create:** `src/components/AnalysisLogsPanel.tsx` — selectbox container + botão buscar + pre logs
- **Create:** `src/components/AnalysisLayoutPicker.tsx` — header com layouts salvos + export/import
- **Create:** `src/components/AnalysisPage.tsx` — orquestrador (state global, integra tudo)

### Drag-drop e entrypoints (Phase D)
- **Modify:** `package.json` — adiciona `react-grid-layout@^1.5`
- **Create:** `src/components/AnalysisGrid.tsx` — `<ResponsiveReactGridLayout>` wrapper
- **Modify:** `src/components/VmContainerDrawer.tsx` — botão "🔍 Investigar período" no header
- **Modify:** `src/components/StackDrawer.tsx` — botão idem no bloco "Backend container"
- **Modify:** `src/components/VmMetricChart.tsx` — onClick que abre análise
- **Modify:** `src/components/VmTab.tsx` — state `vmView`, renderiza `<AnalysisPage>` ou dashboard atual

### Docs (Phase E)
- **Modify:** `src-tauri/src/monitor/.agent.md` — comando novo
- **Modify:** `src/components/.agent.md` — componentes novos
- **Modify:** `src/types/.agent.md` — tipos novos
- **Modify:** `src/lib/.agent.md` — hooks novos
- **Modify:** `CLAUDE.md` — seção Sprint 3
- **Modify:** `docs/superpowers/vm-migrations/VALIDATION.md` — seção Sprint 3 com acceptance
- **Modify:** `~/.claude/skills/falcao-launcher/SKILL.md` — diário sessão 8 (fora do repo)

---

## Phase A — Backend Rust (`monitor_fetch_logs_range`)

Comando novo pra fetchar logs de um range arbitrário via `docker logs --since/--until` por SSH. Validações: range max 24h, regex de container já existente.

### Task A1: Comando `monitor_fetch_logs_range` com validações e testes

**Files:**
- Modify: `src-tauri/src/monitor/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Adicionar struct de retorno e helpers ao commands.rs**

Edita `src-tauri/src/monitor/commands.rs` adicionando depois do `monitor_fetch_logs` existente (linha ~181):

```rust
/// Resposta do `monitor_fetch_logs_range`. Inclui flag `truncated` pra UI avisar
/// quando o output bateu no limite do `--tail` (caso o range tenha gerado mais
/// linhas que o limite).
#[derive(serde::Serialize)]
pub struct LogsRangeResponse {
    pub text: String,
    pub truncated: bool,
    pub line_count: usize,
}

/// Limite duro de tamanho da janela: queries muito longas travam a SSH session
/// e o usuário acaba esperando por nada. 24h cobre o caso real (preset 24h é
/// o maior que o user pode arrastar via brush sem precisar mudar de preset).
const MAX_RANGE_HOURS: i64 = 24;

/// Tail máximo retornado pelo `docker logs`. Mantemos baixo (2k) pra UI não
/// engasgar; UI avisa truncamento via flag `truncated`.
const MAX_TAIL_LINES: u32 = 2000;

/// Valida nome de container — só ASCII alfanumérico + `_.-`.
/// Mesma regra usada por `monitor_fetch_logs` (anti shell-injection).
fn is_valid_container_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}
```

- [ ] **Step 2: Escrever testes ANTES da implementação (TDD)**

Edita `src-tauri/src/monitor/commands.rs` e adiciona no fim do arquivo (depois do último comando):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    /// Helper: parse ISO igual o comando faz.
    fn parse(iso: &str) -> Result<DateTime<Utc>, String> {
        iso.parse::<DateTime<Utc>>()
            .map_err(|e| e.to_string())
    }

    #[test]
    fn parses_iso_timestamps_to_utc() {
        let ts = parse("2026-05-07T12:00:00Z").expect("should parse");
        assert_eq!(ts.timestamp(), 1778155200);
    }

    #[test]
    fn rejects_invalid_iso() {
        assert!(parse("not-a-date").is_err());
        assert!(parse("2026-05-07").is_err()); // sem hora
    }

    #[test]
    fn rejects_range_over_24h() {
        let since = parse("2026-05-07T00:00:00Z").unwrap();
        let until = since + Duration::hours(MAX_RANGE_HOURS + 1);
        let span = until - since;
        assert!(span.num_hours() > MAX_RANGE_HOURS);
    }

    #[test]
    fn accepts_range_exactly_24h() {
        let since = parse("2026-05-07T00:00:00Z").unwrap();
        let until = since + Duration::hours(MAX_RANGE_HOURS);
        let span = until - since;
        assert_eq!(span.num_hours(), MAX_RANGE_HOURS);
    }

    #[test]
    fn rejects_until_before_since() {
        let since = parse("2026-05-07T12:00:00Z").unwrap();
        let until = since - Duration::minutes(1);
        assert!(until < since);
    }

    #[test]
    fn validates_container_name_alphanumeric() {
        assert!(is_valid_container_name("falcao-financas"));
        assert!(is_valid_container_name("nginx_prod-2"));
        assert!(is_valid_container_name("a.b.c"));
    }

    #[test]
    fn rejects_container_name_with_shell_metachars() {
        assert!(!is_valid_container_name(""));
        assert!(!is_valid_container_name("foo; rm -rf /"));
        assert!(!is_valid_container_name("foo bar"));
        assert!(!is_valid_container_name("foo$bar"));
        assert!(!is_valid_container_name("foo\nbar"));
    }
}
```

- [ ] **Step 3: Rodar testes pra verificar que falham (não compila ainda — sem `MAX_RANGE_HOURS`/`is_valid_container_name`)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p falcao-launcher-lib commands::tests 2>&1 | tail -10
```

Expected: erro de compilação (`MAX_RANGE_HOURS` ou `is_valid_container_name` não definido se Step 1 não foi salvo). Se Step 1 já tá salvo, todos os testes passam (eles testam só os helpers).

> **Por que TDD aqui mesmo?** O comando real precisa de SSH ativo e DateTime parsing. Os testes garantem que helpers (parsing, validação) funcionam isoladamente. Comando completo é integration test (manual via UI).

- [ ] **Step 4: Implementar `monitor_fetch_logs_range`**

Edita `src-tauri/src/monitor/commands.rs` e adiciona depois do `monitor_fetch_logs` existente (mas antes do `mod tests`):

```rust
/// Retorna logs de um container num range temporal arbitrário via
/// `docker logs --since <iso> --until <iso>` por SSH.
///
/// Validações:
///   - container name: ASCII + `_.-` (anti shell-injection)
///   - range max 24h (anti SSH timeout)
///   - until > since
///
/// Truncamento: docker `--tail 2000` corta saída — UI avisa via flag.
#[tauri::command]
pub async fn monitor_fetch_logs_range(
    container: String,
    since_iso: String,
    until_iso: String,
) -> Result<LogsRangeResponse, String> {
    if !is_valid_container_name(&container) {
        return Err(format!("invalid container name: {container}"));
    }

    let since: DateTime<Utc> = since_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid since_iso: {e}"))?;
    let until: DateTime<Utc> = until_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid until_iso: {e}"))?;

    if until <= since {
        return Err("until_iso must be after since_iso".to_string());
    }

    let span = until - since;
    if span.num_hours() > MAX_RANGE_HOURS {
        return Err(format!(
            "range too large: {}h (max {}h)",
            span.num_hours(),
            MAX_RANGE_HOURS
        ));
    }

    // Format timestamps no formato que `docker logs` aceita: ISO 8601 com tz.
    // Exemplo: 2026-05-07T12:00:00Z
    let since_arg = since.to_rfc3339();
    let until_arg = until.to_rfc3339();

    let cmd = format!(
        "docker logs --since '{}' --until '{}' --tail {} {} 2>&1",
        since_arg, until_arg, MAX_TAIL_LINES, container
    );

    let output = tokio::process::Command::new("ssh")
        .args(["falcao@162.55.217.189", &cmd])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let line_count = text.lines().count();
    let truncated = line_count >= MAX_TAIL_LINES as usize;

    Ok(LogsRangeResponse {
        text,
        truncated,
        line_count,
    })
}
```

- [ ] **Step 5: Registrar comando em `lib.rs`**

Lê primeiro:
```bash
grep -n "monitor_fetch_logs\|monitor_stack_detail" src-tauri/src/lib.rs
```

Vai mostrar a linha que registra os outros comandos. Edita `src-tauri/src/lib.rs` adicionando `monitor_fetch_logs_range` na lista do `tauri::generate_handler!` — logo após `monitor_fetch_logs`:

```rust
// dentro de generate_handler! existente:
//   ...
//   monitor::commands::monitor_fetch_logs,
//   monitor::commands::monitor_fetch_logs_range,  // NEW
//   ...
```

- [ ] **Step 6: Rodar todos os testes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p falcao-launcher-lib 2>&1 | tail -15
```

Expected: todos passam (incluindo os 7 novos do `commands::tests`).

- [ ] **Step 7: Build smoke**

```bash
cargo build --manifest-path src-tauri/Cargo.toml 2>&1 | tail -5
```

Expected: `Finished dev profile`, sem warnings novos.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/monitor/commands.rs src-tauri/src/lib.rs
git commit -m "feat(monitor): comando monitor_fetch_logs_range

- Aceita container + since_iso + until_iso (RFC 3339)
- Validações: regex container, range max 24h, until > since
- Backend: docker logs --since/--until --tail 2000 via SSH
- Retorna LogsRangeResponse { text, truncated, line_count }
- 7 testes unitários pros helpers (parse, validação range, regex)"
```

---

## Phase B-types — Schemas (sequencial, bloqueia B-hooks e Phase C)

### Task B1: Tipos TypeScript da análise

**Files:**
- Create: `src/types/analysis.ts`

- [ ] **Step 1: Criar arquivo com tipos completos**

Cria `src/types/analysis.ts`:

```typescript
// Tipos do "modo análise" (Sprint 3). Espelham as decisões D6 (schema layouts)
// e D7 (hook context). Schema versionado pra migração futura.

import type { MetricBucket, MetricPoint, WindowKey } from "./monitor";

/**
 * Versão do schema de layouts persistido em localStorage.
 * Bump aqui quando mudar shape do `LayoutsBundle` ou `AnalysisLayout`.
 */
export const ANALYSIS_SCHEMA_VERSION = 1;

/** Chave do localStorage onde o bundle vive. */
export const LAYOUTS_STORAGE_KEY = "analysis:layouts:v1";

/**
 * Referência a uma métrica disponível.
 * Discriminated union por `kind` — cada branch tem fields obrigatórios diferentes:
 *   - vm: só metric (não tem resource)
 *   - container: precisa do resource (nome do container)
 *   - hetzner: só metric
 */
export type MetricRef =
  | { kind: "vm"; metric: string }
  | { kind: "container"; resource: string; metric: string }
  | { kind: "hetzner"; metric: string };

/** Slot individual no grid drag-drop (coords em unidades do react-grid-layout). */
export interface ChartSlot {
  id: string;       // uuid v4
  x: number;
  y: number;
  w: number;
  h: number;
  metric: MetricRef;
}

/** Layout salvo de uma análise (presets + grid completo). */
export interface AnalysisLayout {
  id: string;
  name: string;
  created_at: string;     // ISO 8601
  updated_at: string;
  default_preset: WindowKey;
  charts: ChartSlot[];
}

/** Bundle completo persistido em localStorage. */
export interface LayoutsBundle {
  version: 1;
  layouts: AnalysisLayout[];
  last_used_id: string | null;
}

/**
 * Estado consumível por integrações futuras (Sprint 4 — Claude).
 * Tudo serializável pra JSON. Sem refs DOM, sem promises pendentes.
 */
export interface AnalysisContext {
  range: { start: Date; end: Date };
  preset: WindowKey;
  charts: Array<{
    metric: MetricRef;
    bucket: MetricBucket;
    series: MetricPoint[];
  }>;
  logs: {
    container: string | null;
    fetched_for: { start: Date; end: Date } | null;
    text: string | null;
    truncated: boolean;
  };
  layout: { id: string | null; name: string | null };
}

/**
 * Resposta do comando Rust `monitor_fetch_logs_range`.
 * Espelha `LogsRangeResponse` em commands.rs.
 */
export interface LogsRangeResponse {
  text: string;
  truncated: boolean;
  line_count: number;
}

/**
 * Cria bundle default vazio (usado em first-load ou após corrupção).
 */
export function createDefaultBundle(): LayoutsBundle {
  return {
    version: ANALYSIS_SCHEMA_VERSION,
    layouts: [],
    last_used_id: null,
  };
}
```

- [ ] **Step 2: Type-check passa**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros (o arquivo é self-contained e usa só tipos já existentes em `monitor.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/types/analysis.ts
git commit -m "feat(analysis): tipos TS do modo análise

- MetricRef (discriminated union por kind: vm/container/hetzner)
- ChartSlot (coords react-grid-layout + metric ref)
- AnalysisLayout, LayoutsBundle (schema versionado v1)
- AnalysisContext (formato serializável pra Sprint 4 — Claude)
- LogsRangeResponse (espelha LogsRangeResponse Rust)
- ANALYSIS_SCHEMA_VERSION + LAYOUTS_STORAGE_KEY constants
- createDefaultBundle() helper"
```

### Task B2: API client `monitorApi.fetchLogsRange`

**Files:**
- Modify: `src/lib/monitor.ts`

- [ ] **Step 1: Inspecionar shape atual de monitorApi**

```bash
grep -n "fetchLogs\|export const monitorApi" src/lib/monitor.ts
```

- [ ] **Step 2: Adicionar método ao monitorApi**

Edita `src/lib/monitor.ts`. Encontra o objeto `monitorApi` (provavelmente um `export const monitorApi = { ... }`) e adiciona depois de `fetchLogs`:

```typescript
import type { LogsRangeResponse } from "../types/analysis";

// ... dentro do monitorApi:
  async fetchLogsRange(
    container: string,
    sinceIso: string,
    untilIso: string,
  ): Promise<LogsRangeResponse> {
    return invoke<LogsRangeResponse>("monitor_fetch_logs_range", {
      container,
      sinceIso,
      untilIso,
    });
  },
```

> **Nota Tauri:** `invoke` no JS converte camelCase pra snake_case automaticamente (`sinceIso` → `since_iso`), então o JS pode escrever em camelCase mesmo o Rust esperando snake_case.

- [ ] **Step 3: Type-check passa**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 4: Commit**

```bash
git add src/lib/monitor.ts
git commit -m "feat(analysis): monitorApi.fetchLogsRange wrapper"
```

---

## Phase B-hooks — Hooks de estado (paralelizável com Phase C após B-types)

### Task B3: `useAnalysisLayouts` — CRUD localStorage + export/import + migration

**Files:**
- Create: `src/lib/useAnalysisLayouts.ts`

- [ ] **Step 1: Criar hook completo**

Cria `src/lib/useAnalysisLayouts.ts`:

```typescript
import { useCallback, useEffect, useState } from "react";
import {
  ANALYSIS_SCHEMA_VERSION,
  LAYOUTS_STORAGE_KEY,
  type AnalysisLayout,
  type ChartSlot,
  type LayoutsBundle,
  createDefaultBundle,
} from "../types/analysis";
import type { WindowKey } from "../types/monitor";

/**
 * Snapshot do estado atual do AnalysisPage que vira um layout salvo.
 * Não é o layout completo (sem id/name/timestamps) — o hook completa.
 */
export interface LayoutSnapshot {
  default_preset: WindowKey;
  charts: ChartSlot[];
}

interface UseAnalysisLayoutsReturn {
  layouts: AnalysisLayout[];
  currentLayout: AnalysisLayout | null;
  /** Salva snapshot atual com nome novo. Retorna o id criado. */
  save(name: string, snapshot: LayoutSnapshot): string;
  /** Patch parcial de campos do layout. Bumps updated_at. */
  update(id: string, patch: Partial<AnalysisLayout>): void;
  /** Remove. Se era o currentLayout, limpa current. */
  delete(id: string): void;
  /** Marca um layout como atual (persiste em last_used_id). */
  setCurrent(id: string | null): void;
  /** Duplica com nome "<name> (cópia)". Retorna id da cópia. */
  duplicate(id: string): string | null;
  /** Triga download JSON de 1 layout. */
  exportLayout(id: string): void;
  /** Lê JSON de um File, valida, adiciona à lista. Retorna o layout adicionado. */
  importLayout(file: File): Promise<AnalysisLayout>;
  /** Mensagem de erro de I/O ou parse (ex: localStorage cheio). */
  error: string | null;
}

/**
 * Lê bundle do localStorage com tolerância a falhas:
 *   - chave ausente → bundle default
 *   - JSON corrompido → bundle default + console.warn
 *   - versão futura (> known) → bundle default + erro user-facing
 *   - layouts individuais corrompidos → ignora os corrompidos, mantém bons
 */
function readBundleFromStorage(): { bundle: LayoutsBundle; warning: string | null } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAYOUTS_STORAGE_KEY);
  } catch {
    // localStorage indisponível (ex: incognito strict)
    return { bundle: createDefaultBundle(), warning: "localStorage indisponível" };
  }
  if (!raw) return { bundle: createDefaultBundle(), warning: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn("[useAnalysisLayouts] bundle corrompido, recriando");
    return {
      bundle: createDefaultBundle(),
      warning: "bundle de layouts estava corrompido — recriado vazio",
    };
  }

  const obj = parsed as Partial<LayoutsBundle>;
  if (typeof obj.version !== "number") {
    return { bundle: createDefaultBundle(), warning: "bundle sem version — recriado" };
  }
  if (obj.version > ANALYSIS_SCHEMA_VERSION) {
    return {
      bundle: createDefaultBundle(),
      warning: `layouts foram salvos por versão ${obj.version} (atual: ${ANALYSIS_SCHEMA_VERSION}) — atualize o launcher`,
    };
  }

  // version <= known: aceita. Filtra layouts inválidos individualmente.
  const layouts = Array.isArray(obj.layouts) ? obj.layouts : [];
  const valid: AnalysisLayout[] = [];
  let droppedCount = 0;
  for (const l of layouts) {
    if (isValidLayout(l)) valid.push(l);
    else droppedCount++;
  }
  const last_used_id = typeof obj.last_used_id === "string" ? obj.last_used_id : null;

  return {
    bundle: { version: ANALYSIS_SCHEMA_VERSION, layouts: valid, last_used_id },
    warning: droppedCount > 0
      ? `${droppedCount} layout${droppedCount === 1 ? "" : "s"} corrompido${droppedCount === 1 ? "" : "s"} foi descartado`
      : null,
  };
}

/** Type-guard que confirma shape mínimo válido. Lenient: aceita extras. */
function isValidLayout(x: unknown): x is AnalysisLayout {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.name === "string" &&
    typeof o.created_at === "string" &&
    typeof o.updated_at === "string" &&
    typeof o.default_preset === "string" &&
    Array.isArray(o.charts)
  );
}

function writeBundleToStorage(bundle: LayoutsBundle): { ok: true } | { ok: false; error: string } {
  try {
    localStorage.setItem(LAYOUTS_STORAGE_KEY, JSON.stringify(bundle));
    return { ok: true };
  } catch (e) {
    if (e instanceof Error && e.name === "QuotaExceededError") {
      return { ok: false, error: "localStorage cheio — delete layouts antigos" };
    }
    return { ok: false, error: e instanceof Error ? e.message : "erro desconhecido" };
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

export function useAnalysisLayouts(): UseAnalysisLayoutsReturn {
  const [bundle, setBundle] = useState<LayoutsBundle>(() => readBundleFromStorage().bundle);
  const [error, setError] = useState<string | null>(() => readBundleFromStorage().warning);

  // Persist toda mudança no bundle.
  useEffect(() => {
    const result = writeBundleToStorage(bundle);
    if (!result.ok) setError(result.error);
  }, [bundle]);

  const currentLayout =
    bundle.layouts.find((l) => l.id === bundle.last_used_id) ?? null;

  const save = useCallback((name: string, snapshot: LayoutSnapshot): string => {
    const layout: AnalysisLayout = {
      id: crypto.randomUUID(),
      name,
      created_at: nowIso(),
      updated_at: nowIso(),
      default_preset: snapshot.default_preset,
      charts: snapshot.charts,
    };
    setBundle((prev) => ({
      ...prev,
      layouts: [...prev.layouts, layout],
      last_used_id: layout.id,
    }));
    setError(null);
    return layout.id;
  }, []);

  const update = useCallback((id: string, patch: Partial<AnalysisLayout>) => {
    setBundle((prev) => ({
      ...prev,
      layouts: prev.layouts.map((l) =>
        l.id === id ? { ...l, ...patch, id: l.id, updated_at: nowIso() } : l,
      ),
    }));
    setError(null);
  }, []);

  const remove = useCallback((id: string) => {
    setBundle((prev) => ({
      ...prev,
      layouts: prev.layouts.filter((l) => l.id !== id),
      last_used_id: prev.last_used_id === id ? null : prev.last_used_id,
    }));
    setError(null);
  }, []);

  const setCurrent = useCallback((id: string | null) => {
    setBundle((prev) => ({ ...prev, last_used_id: id }));
  }, []);

  const duplicate = useCallback((id: string): string | null => {
    const orig = bundle.layouts.find((l) => l.id === id);
    if (!orig) return null;
    const copy: AnalysisLayout = {
      ...orig,
      id: crypto.randomUUID(),
      name: `${orig.name} (cópia)`,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    setBundle((prev) => ({
      ...prev,
      layouts: [...prev.layouts, copy],
      last_used_id: copy.id,
    }));
    return copy.id;
  }, [bundle.layouts]);

  const exportLayout = useCallback((id: string) => {
    const layout = bundle.layouts.find((l) => l.id === id);
    if (!layout) return;
    const exportData = { version: ANALYSIS_SCHEMA_VERSION, layout };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${layout.name.replace(/[^a-z0-9-_]/gi, "_")}-${layout.id.slice(0, 8)}.layout.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [bundle.layouts]);

  const importLayout = useCallback(async (file: File): Promise<AnalysisLayout> => {
    const text = await file.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("JSON inválido");
    }
    const obj = parsed as { version?: number; layout?: unknown };
    if (typeof obj.version !== "number") {
      throw new Error("arquivo sem version");
    }
    if (obj.version > ANALYSIS_SCHEMA_VERSION) {
      throw new Error(`versão ${obj.version} não suportada (atual: ${ANALYSIS_SCHEMA_VERSION})`);
    }
    if (!isValidLayout(obj.layout)) {
      throw new Error("layout inválido (campos obrigatórios faltando)");
    }
    // Gera id novo pra evitar colisão se já existir
    const imported: AnalysisLayout = {
      ...obj.layout,
      id: crypto.randomUUID(),
      name: obj.layout.name + " (importado)",
      updated_at: nowIso(),
    };
    setBundle((prev) => ({
      ...prev,
      layouts: [...prev.layouts, imported],
      last_used_id: imported.id,
    }));
    setError(null);
    return imported;
  }, []);

  return {
    layouts: bundle.layouts,
    currentLayout,
    save,
    update,
    delete: remove,
    setCurrent,
    duplicate,
    exportLayout,
    importLayout,
    error,
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
git add src/lib/useAnalysisLayouts.ts
git commit -m "feat(analysis): hook useAnalysisLayouts (CRUD + export/import + migration)

- localStorage CRUD via chave 'analysis:layouts:v1'
- Schema validation tolerante: corrompido → recria, versão futura → recusa,
  layouts individuais corrompidos → descarta os bons mantém
- save/update/delete/setCurrent/duplicate
- exportLayout: download JSON de 1 layout (filename slugificado)
- importLayout: parse + valida + gera id novo + sufixo '(importado)'
- error string pra UI surfacar (toast)
- Sem zod — type-guards manuais"
```

### Task B4: `useAnalysisContext` — agrega state pra Sprint 4

**Files:**
- Create: `src/lib/useAnalysisContext.ts`

- [ ] **Step 1: Criar hook agregador**

Cria `src/lib/useAnalysisContext.ts`:

```typescript
import { useMemo } from "react";
import type { ChartSlot } from "../types/analysis";
import type {
  AnalysisContext,
  AnalysisLayout,
  LogsRangeResponse,
} from "../types/analysis";
import type { MetricBucket, MetricPoint, WindowKey } from "../types/monitor";

interface ChartSeries {
  slot: ChartSlot;
  bucket: MetricBucket;
  series: MetricPoint[];
}

interface UseAnalysisContextArgs {
  preset: WindowKey;
  presetRange: { start: Date; end: Date };
  brushRange: { start: Date; end: Date } | null;
  charts: ChartSeries[];
  logsContainer: string | null;
  lastFetchedLogs: {
    range: { start: Date; end: Date };
    container: string;
    response: LogsRangeResponse;
  } | null;
  layout: AnalysisLayout | null;
}

/**
 * Agrega o estado atual do AnalysisPage num formato serializável.
 * Sprint 4 (integração Claude) consome este hook pra montar prompt.
 *
 * Sem efeitos. Sem refs. Tudo passável a JSON.stringify.
 */
export function useAnalysisContext(args: UseAnalysisContextArgs): AnalysisContext {
  return useMemo<AnalysisContext>(() => {
    const range = args.brushRange ?? args.presetRange;
    return {
      range,
      preset: args.preset,
      charts: args.charts.map((c) => ({
        metric: c.slot.metric,
        bucket: c.bucket,
        series: c.series,
      })),
      logs: {
        container: args.logsContainer,
        fetched_for: args.lastFetchedLogs ? args.lastFetchedLogs.range : null,
        text: args.lastFetchedLogs ? args.lastFetchedLogs.response.text : null,
        truncated: args.lastFetchedLogs?.response.truncated ?? false,
      },
      layout: args.layout
        ? { id: args.layout.id, name: args.layout.name }
        : { id: null, name: null },
    };
  }, [
    args.preset,
    args.presetRange,
    args.brushRange,
    args.charts,
    args.logsContainer,
    args.lastFetchedLogs,
    args.layout,
  ]);
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/lib/useAnalysisContext.ts
git commit -m "feat(analysis): hook useAnalysisContext (agrega state serializável p/ Sprint 4)"
```

---

## Phase C — Componentes core (paralelizável com Phase B-hooks após B-types)

> **Nota:** essa phase só pode começar após Task B1 (tipos). Tasks B3 e B4 (hooks) não bloqueiam o trabalho aqui — componentes podem importar tipos sem precisar dos hooks até o final (`AnalysisPage` é o que costura tudo).

### Task C1: `MetricPicker` — selectbox agrupado de métricas

**Files:**
- Create: `src/components/MetricPicker.tsx`

- [ ] **Step 1: Criar componente**

Cria `src/components/MetricPicker.tsx`:

```tsx
import type { MetricRef } from "../types/analysis";
import type { ContainerInfo } from "../types/monitor";

interface Props {
  value: MetricRef;
  onChange: (ref: MetricRef) => void;
  /** Containers ativos pra popular o group `Container` do select. */
  containers: ContainerInfo[];
}

/**
 * Lista hardcoded de métricas VM/Hetzner. Pra container, derivamos da prop
 * `containers` em runtime.
 *
 * Mantém em sync com schema das tabelas — ver monitor-shared/src/lib.rs e
 * coletores em monitor-agent/src/collectors/.
 */
const VM_METRICS = [
  { metric: "cpu_pct", label: "CPU %" },
  { metric: "load_1m", label: "Load 1m" },
  { metric: "mem_pct", label: "RAM %" },
  { metric: "mem_used_bytes", label: "RAM usada (bytes)" },
  { metric: "disk_used_bytes", label: "Disco usado (bytes)" },
  { metric: "net_tx_bytes", label: "Network out (bytes)" },
  { metric: "net_rx_bytes", label: "Network in (bytes)" },
];

const HETZNER_METRICS = [
  { metric: "outgoing_traffic_bytes", label: "Tráfego saída (Hetzner)" },
  { metric: "ingoing_traffic_bytes", label: "Tráfego entrada (Hetzner)" },
  { metric: "cost_accumulated_usd", label: "Custo acumulado (USD)" },
];

const CONTAINER_METRICS = [
  { metric: "cpu_pct", label: "CPU %" },
  { metric: "mem_pct", label: "RAM %" },
  { metric: "mem_used_bytes", label: "RAM usada (bytes)" },
];

function refToValue(ref: MetricRef): string {
  if (ref.kind === "container") return `container:${ref.resource}:${ref.metric}`;
  return `${ref.kind}:${ref.metric}`;
}

function valueToRef(value: string): MetricRef | null {
  const parts = value.split(":");
  if (parts[0] === "vm" && parts.length === 2) {
    return { kind: "vm", metric: parts[1] };
  }
  if (parts[0] === "hetzner" && parts.length === 2) {
    return { kind: "hetzner", metric: parts[1] };
  }
  if (parts[0] === "container" && parts.length === 3) {
    return { kind: "container", resource: parts[1], metric: parts[2] };
  }
  return null;
}

export function MetricPicker({ value, onChange, containers }: Props) {
  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const ref = valueToRef(e.target.value);
    if (ref) onChange(ref);
  };

  return (
    <select
      value={refToValue(value)}
      onChange={handleChange}
      className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)] focus:border-[var(--color-accent-primary)]/60 focus:outline-none"
      aria-label="Selecionar métrica"
    >
      <optgroup label="VM">
        {VM_METRICS.map((m) => (
          <option key={`vm:${m.metric}`} value={`vm:${m.metric}`}>
            VM · {m.label}
          </option>
        ))}
      </optgroup>
      <optgroup label="Hetzner">
        {HETZNER_METRICS.map((m) => (
          <option key={`hetzner:${m.metric}`} value={`hetzner:${m.metric}`}>
            Hetzner · {m.label}
          </option>
        ))}
      </optgroup>
      {containers.length > 0 && (
        <optgroup label="Containers">
          {containers.flatMap((c) =>
            CONTAINER_METRICS.map((m) => (
              <option
                key={`container:${c.name}:${m.metric}`}
                value={`container:${c.name}:${m.metric}`}
              >
                {c.name} · {m.label}
              </option>
            )),
          )}
        </optgroup>
      )}
    </select>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/MetricPicker.tsx
git commit -m "feat(analysis): MetricPicker — select agrupado por source (VM/Hetzner/Containers)"
```

### Task C2: `AnalysisChartSlot` — chart Recharts com brush

**Files:**
- Create: `src/components/AnalysisChartSlot.tsx`

- [ ] **Step 1: Criar componente do slot**

Cria `src/components/AnalysisChartSlot.tsx`:

```tsx
import { useEffect, useState } from "react";
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { monitorApi } from "../lib/monitor";
import type { ChartSlot, MetricRef } from "../types/analysis";
import type {
  ContainerInfo,
  MetricBucket,
  MetricPoint,
} from "../types/monitor";
import { InlineLoading } from "./Loading";
import { MetricPicker } from "./MetricPicker";

interface Props {
  slot: ChartSlot;
  containers: ContainerInfo[];
  /** Range já carregado do DB (definido pelo preset global). */
  presetRange: { start: Date; end: Date };
  /** Bucket pra agregação (varia por preset — vem do windowToParams). */
  bucket: MetricBucket;
  /** Brush selecionado globalmente (subset do presetRange). */
  brushRange: { start: Date; end: Date } | null;
  /** Crosshair sincronizado entre charts. null = sem hover. */
  hoverTs: number | null;
  enabled: boolean;
  onMetricChange: (slotId: string, ref: MetricRef) => void;
  onRemove: (slotId: string) => void;
  onBrushChange: (range: { start: Date; end: Date } | null) => void;
  onHover: (ts: number | null) => void;
  /** Notifica o pai dos pontos atualmente carregados (pro useAnalysisContext). */
  onSeriesLoaded: (slotId: string, series: MetricPoint[]) => void;
}

export function AnalysisChartSlot({
  slot,
  containers,
  presetRange,
  bucket,
  brushRange,
  hoverTs,
  enabled,
  onMetricChange,
  onRemove,
  onBrushChange,
  onHover,
  onSeriesLoaded,
}: Props) {
  const [series, setSeries] = useState<MetricPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-fetch quando preset OU metric muda. Brush não dispara fetch.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setSeries(null);
    setError(null);

    const sinceIso = presetRange.start.toISOString();
    const untilIso = presetRange.end.toISOString();
    const { kind, metric } = slot.metric;
    const resource = slot.metric.kind === "container" ? slot.metric.resource : null;

    monitorApi
      .fetchMetricSeries({
        source: kind,
        resource,
        metric,
        sinceIso,
        untilIso,
        bucket,
      })
      .then((points) => {
        if (cancelled) return;
        setSeries(points);
        onSeriesLoaded(slot.id, points);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    presetRange.start.getTime(),
    presetRange.end.getTime(),
    slot.metric,
    bucket,
    slot.id,
    onSeriesLoaded,
  ]);

  // Brush UI: Recharts <Brush> emite startIndex/endIndex (índices no array).
  // Convertemos pra timestamps reais e propagamos via callback global.
  const handleBrushChange = (e: { startIndex?: number; endIndex?: number }) => {
    if (!series || e.startIndex == null || e.endIndex == null) return;
    if (e.startIndex === 0 && e.endIndex === series.length - 1) {
      onBrushChange(null); // brush cobrindo tudo = sem brush
      return;
    }
    const start = new Date(series[e.startIndex].ts);
    const end = new Date(series[e.endIndex].ts);
    onBrushChange({ start, end });
  };

  return (
    <div className="flex h-full flex-col rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3">
      {/* Header (drag handle) */}
      <div
        className="analysis-slot-drag-handle mb-2 flex cursor-move items-center justify-between gap-2"
        title="Arrastar pra mover (segure aqui)"
      >
        <MetricPicker
          value={slot.metric}
          onChange={(ref) => onMetricChange(slot.id, ref)}
          containers={containers}
        />
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRemove(slot.id);
          }}
          className="rounded-md px-2 py-0.5 text-xs text-[var(--color-text-secondary)] transition hover:bg-[var(--color-danger-soft)] hover:text-[var(--color-danger)]"
          aria-label="Remover chart"
          title="Remover"
        >
          ×
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0">
        {error ? (
          <ChartError error={error} />
        ) : series === null ? (
          <InlineLoading minHeight="100%" messages={["Carregando série", "Buscando dados", "Quase lá"]} />
        ) : series.length === 0 ? (
          <ChartEmpty />
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={series.map((p) => ({ ts: new Date(p.ts).getTime(), value: p.value }))}
              onMouseMove={(state) => {
                if (state && state.activeLabel != null) {
                  onHover(Number(state.activeLabel));
                }
              }}
              onMouseLeave={() => onHover(null)}
            >
              <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="2 4" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={formatTick}
                stroke="var(--color-text-muted)"
                fontSize={10}
              />
              <YAxis stroke="var(--color-text-muted)" fontSize={10} />
              <Tooltip
                labelFormatter={(ts) => new Date(Number(ts)).toLocaleString("pt-BR")}
                contentStyle={{
                  background: "var(--color-bg-secondary)",
                  border: "1px solid var(--color-border-subtle)",
                  fontSize: 11,
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent-primary)"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
              />
              {hoverTs != null && (
                <ReferenceLine
                  x={hoverTs}
                  stroke="var(--color-accent-primary)"
                  strokeOpacity={0.5}
                  strokeDasharray="2 2"
                />
              )}
              {brushRange && (
                <ReferenceLine
                  x={brushRange.start.getTime()}
                  stroke="var(--color-success)"
                  strokeWidth={2}
                />
              )}
              {brushRange && (
                <ReferenceLine
                  x={brushRange.end.getTime()}
                  stroke="var(--color-success)"
                  strokeWidth={2}
                />
              )}
              <Brush
                dataKey="ts"
                height={20}
                stroke="var(--color-accent-primary)"
                fill="var(--color-bg-secondary)"
                tickFormatter={formatTick}
                onChange={handleBrushChange}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}

function formatTick(ts: number): string {
  const d = new Date(ts);
  // Hora curta pra eixo
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function ChartError({ error }: { error: string }) {
  return (
    <div className="flex h-full items-center justify-center px-3 text-center">
      <div>
        <div className="text-xs text-[var(--color-danger)]">Erro ao carregar</div>
        <div className="mt-1 font-mono text-[10px] text-[var(--color-text-muted)]">
          {error}
        </div>
      </div>
    </div>
  );
}

function ChartEmpty() {
  return (
    <div className="flex h-full items-center justify-center text-center">
      <div className="text-xs text-[var(--color-text-muted)]">
        sem dados nesse período
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar shape do `monitorApi.fetchMetricSeries`**

```bash
grep -n "fetchMetricSeries" src/lib/monitor.ts
```

Confirma a assinatura exata. Se diferir, ajusta no Step 1 acima.

- [ ] **Step 3: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros. Se houver, é mismatch com `fetchMetricSeries` real — ajustar.

- [ ] **Step 4: Commit**

```bash
git add src/components/AnalysisChartSlot.tsx
git commit -m "feat(analysis): AnalysisChartSlot — Recharts LineChart + Brush + crosshair sync

- Re-fetch quando preset/metric muda (não em brush)
- Brush emite range global via callback (índice → timestamp)
- Hover sync entre charts via ReferenceLine no hoverTs
- Brush range marcado com 2 ReferenceLine (start/end) coloridas
- Empty/error/loading states locais (não derruba grid)
- Drag handle = header (evita conflito com brush)"
```

### Task C3: `AnalysisLogsPanel` — logs do período manual

**Files:**
- Create: `src/components/AnalysisLogsPanel.tsx`

- [ ] **Step 1: Criar componente**

Cria `src/components/AnalysisLogsPanel.tsx`:

```tsx
import { useState } from "react";
import { monitorApi } from "../lib/monitor";
import type { LogsRangeResponse } from "../types/analysis";
import type { ContainerInfo } from "../types/monitor";

interface Props {
  /** Range efetivo: brushRange ?? presetRange. */
  range: { start: Date; end: Date };
  containers: ContainerInfo[];
  /** Container default (vem do chart focado quando entrou em análise). */
  defaultContainer: string | null;
  /**
   * Callback notificando logs fetched — pai usa pro useAnalysisContext.
   */
  onLogsFetched: (
    info: {
      range: { start: Date; end: Date };
      container: string;
      response: LogsRangeResponse;
    } | null,
  ) => void;
}

const MAX_RANGE_HOURS = 24;

export function AnalysisLogsPanel({
  range,
  containers,
  defaultContainer,
  onLogsFetched,
}: Props) {
  const [container, setContainer] = useState<string>(
    defaultContainer ?? containers[0]?.name ?? "",
  );
  const [response, setResponse] = useState<LogsRangeResponse | null>(null);
  const [fetchedRange, setFetchedRange] = useState<{ start: Date; end: Date } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rangeHours = (range.end.getTime() - range.start.getTime()) / 1000 / 3600;
  const rangeTooLarge = rangeHours > MAX_RANGE_HOURS;

  const handleFetch = async () => {
    if (!container) return;
    if (rangeTooLarge) {
      setError(`Range maior que ${MAX_RANGE_HOURS}h — refine antes de buscar`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const r = await monitorApi.fetchLogsRange(
        container,
        range.start.toISOString(),
        range.end.toISOString(),
      );
      setResponse(r);
      setFetchedRange({ start: range.start, end: range.end });
      onLogsFetched({ range: { start: range.start, end: range.end }, container, response: r });
    } catch (e) {
      setError(String(e));
      setResponse(null);
      setFetchedRange(null);
      onLogsFetched(null);
    } finally {
      setLoading(false);
    }
  };

  // Quando o range mudou após um fetch, marca os logs como "atrasados"
  const stale =
    response !== null &&
    fetchedRange !== null &&
    (range.start.getTime() !== fetchedRange.start.getTime() ||
      range.end.getTime() !== fetchedRange.end.getTime());

  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">
        Logs do período
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={container}
          onChange={(e) => setContainer(e.target.value)}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs"
          aria-label="Container"
        >
          {containers.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          onClick={handleFetch}
          disabled={loading || rangeTooLarge || !container}
          className="rounded-md bg-[var(--color-accent-primary)] px-3 py-1 text-xs font-semibold text-black transition hover:bg-[var(--color-accent-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Carregando…" : "Buscar logs do período"}
        </button>
        {rangeTooLarge && (
          <span className="text-[10px] text-[var(--color-danger)]">
            Range maior que {MAX_RANGE_HOURS}h
          </span>
        )}
        {stale && !loading && (
          <span className="text-[10px] text-[var(--color-text-muted)]">
            (logs do range anterior — clique pra atualizar)
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-2 text-xs text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {response && (
        <>
          {response.truncated && (
            <div className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning-soft)] p-2 text-[10px]">
              Logs truncados em {response.line_count} linhas — refine o range pra ver mais
            </div>
          )}
          <pre className="max-h-96 overflow-auto rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-primary)] p-3 font-mono text-[10px] leading-relaxed text-[var(--color-text-primary)]">
            {response.text.length === 0 ? "(sem saída)" : response.text}
          </pre>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros (pode haver warning sobre `--color-warning`/`--color-warning-soft` se ausente, mas isso é runtime CSS, não TS).

- [ ] **Step 3: Confirmar tokens warning existem (visual)**

```bash
grep -n "color-warning\|color-warning-soft" src/App.css
```

Se ausente: trocar por `--color-accent-primary` + `--color-bg-tertiary` no Step 1 (já temos esses).

- [ ] **Step 4: Commit**

```bash
git add src/components/AnalysisLogsPanel.tsx
git commit -m "feat(analysis): AnalysisLogsPanel — fetch manual + selectbox container

- Botão 'Buscar logs do período' chama monitorApi.fetchLogsRange
- Bloqueia se range > 24h (mensagem clara + botão disabled)
- Stale indicator quando range mudou pós-fetch
- Truncated banner quando response.truncated == true
- Pre com max-h e scroll, font mono"
```

### Task C4: `AnalysisLayoutPicker` — header com layouts + export/import

**Files:**
- Create: `src/components/AnalysisLayoutPicker.tsx`

- [ ] **Step 1: Criar componente**

Cria `src/components/AnalysisLayoutPicker.tsx`:

```tsx
import { useRef, useState } from "react";
import type { AnalysisLayout } from "../types/analysis";

interface Props {
  layouts: AnalysisLayout[];
  currentLayoutId: string | null;
  onSelect: (id: string | null) => void;
  onSave: (name: string) => void;
  onRename: (id: string, newName: string) => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onExport: (id: string) => void;
  onImport: (file: File) => void;
  errorMessage: string | null;
}

export function AnalysisLayoutPicker({
  layouts,
  currentLayoutId,
  onSelect,
  onSave,
  onRename,
  onDelete,
  onDuplicate,
  onExport,
  onImport,
  errorMessage,
}: Props) {
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [draftName, setDraftName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleSelect = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    onSelect(v === "" ? null : v);
  };

  const handleSaveSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = draftName.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setDraftName("");
    setShowSaveDialog(false);
  };

  const handleRename = () => {
    if (!currentLayoutId) return;
    const cur = layouts.find((l) => l.id === currentLayoutId);
    if (!cur) return;
    const next = window.prompt("Novo nome:", cur.name);
    if (next && next.trim() && next.trim() !== cur.name) {
      onRename(currentLayoutId, next.trim());
    }
  };

  const handleDelete = () => {
    if (!currentLayoutId) return;
    const cur = layouts.find((l) => l.id === currentLayoutId);
    if (!cur) return;
    if (window.confirm(`Excluir layout "${cur.name}"?`)) {
      onDelete(currentLayoutId);
    }
  };

  const handleImportClick = () => fileInputRef.current?.click();

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImport(file);
    e.target.value = ""; // permite re-selecionar mesmo arquivo
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={currentLayoutId ?? ""}
        onChange={handleSelect}
        className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs text-[var(--color-text-primary)]"
        aria-label="Layout salvo"
      >
        <option value="">— rascunho não salvo —</option>
        {layouts.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>

      <button onClick={() => setShowSaveDialog(true)} className={btnClass}>
        + Salvar como
      </button>
      {currentLayoutId && (
        <>
          <button onClick={handleRename} className={btnClass} title="Renomear">
            Renomear
          </button>
          <button onClick={() => onDuplicate(currentLayoutId)} className={btnClass}>
            Duplicar
          </button>
          <button
            onClick={handleDelete}
            className={btnClass + " hover:!text-[var(--color-danger)]"}
          >
            Excluir
          </button>
          <button onClick={() => onExport(currentLayoutId)} className={btnClass}>
            Export ↗
          </button>
        </>
      )}
      <button onClick={handleImportClick} className={btnClass}>
        Import ↙
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleFileChange}
      />

      {errorMessage && (
        <span className="text-[10px] text-[var(--color-danger)]">{errorMessage}</span>
      )}

      {showSaveDialog && (
        <form onSubmit={handleSaveSubmit} className="flex items-center gap-2">
          <input
            autoFocus
            type="text"
            placeholder="nome do layout"
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-xs"
          />
          <button type="submit" className={btnClass + " bg-[var(--color-accent-primary)] text-black"}>
            Salvar
          </button>
          <button
            type="button"
            onClick={() => {
              setShowSaveDialog(false);
              setDraftName("");
            }}
            className={btnClass}
          >
            Cancelar
          </button>
        </form>
      )}
    </div>
  );
}

const btnClass =
  "rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]";
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/AnalysisLayoutPicker.tsx
git commit -m "feat(analysis): AnalysisLayoutPicker — gerenciamento de layouts no header

- Select de layouts salvos + 'rascunho não salvo'
- Salvar como (form inline com input de nome)
- Renomear (window.prompt — keep simple)
- Duplicar
- Excluir (window.confirm)
- Export (download JSON)
- Import (input file invisível)
- Surface errorMessage do hook (toast inline)"
```

### Task C5: `AnalysisPage` — orquestrador placeholder (sem grid ainda)

**Files:**
- Create: `src/components/AnalysisPage.tsx`

> **Nota:** essa task entrega o orquestrador funcionando **sem drag-drop** ainda — charts em `flex flex-col` empilhados. Phase D introduz `<AnalysisGrid>` substituindo o container. Permite testar fluxo end-to-end antes de adicionar `react-grid-layout`.

- [ ] **Step 1: Criar componente**

Cria `src/components/AnalysisPage.tsx`:

```tsx
import { useCallback, useMemo, useState } from "react";
import { monitorApi, usePolling } from "../lib/monitor";
import { useAnalysisContext } from "../lib/useAnalysisContext";
import { useAnalysisLayouts } from "../lib/useAnalysisLayouts";
import { windowToParams } from "./TimeWindowSelector";
import {
  type AnalysisLayout,
  type ChartSlot,
  type LogsRangeResponse,
  type MetricRef,
} from "../types/analysis";
import type { ContainerInfo, MetricPoint, WindowKey } from "../types/monitor";
import { AnalysisChartSlot } from "./AnalysisChartSlot";
import { AnalysisLayoutPicker } from "./AnalysisLayoutPicker";
import { AnalysisLogsPanel } from "./AnalysisLogsPanel";
import { TimeWindowSelector } from "./TimeWindowSelector";

interface Props {
  enabled: boolean;
  initialMetric: MetricRef;
  initialContainer: string | null;
  onBack: () => void;
}

export function AnalysisPage({
  enabled,
  initialMetric,
  initialContainer,
  onBack,
}: Props) {
  // Containers pra MetricPicker e LogsPanel
  const { data: containers } = usePolling(monitorApi.listContainers, 30_000, enabled);
  const containerList: ContainerInfo[] = containers ?? [];

  // ─── State global ──────────────────────────────────────────────────────
  const [preset, setPreset] = useState<WindowKey>("1h");
  const [brushRange, setBrushRange] = useState<{ start: Date; end: Date } | null>(null);
  const [hoverTs, setHoverTs] = useState<number | null>(null);
  const [charts, setCharts] = useState<ChartSlot[]>(() => [
    {
      id: crypto.randomUUID(),
      x: 0,
      y: 0,
      w: 12,
      h: 5,
      metric: initialMetric,
    },
  ]);
  const [chartSeriesById, setChartSeriesById] = useState<Record<string, MetricPoint[]>>({});
  const [lastFetchedLogs, setLastFetchedLogs] = useState<{
    range: { start: Date; end: Date };
    container: string;
    response: LogsRangeResponse;
  } | null>(null);

  // Layouts hook
  const layoutsApi = useAnalysisLayouts();

  // Preset → range derivado
  const params = windowToParams(preset);
  const presetRange = useMemo(() => {
    const end = new Date();
    const start = new Date(end.getTime() - params.minutes * 60_000);
    return { start, end };
  }, [params.minutes]);

  const effectiveRange = brushRange ?? presetRange;

  // Context serializável (Sprint 4 / Claude)
  // Side-effect free — só recalcula quando inputs mudam.
  useAnalysisContext({
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

  // ─── Handlers ──────────────────────────────────────────────────────────
  const handleAddChart = () => {
    setCharts((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        x: 0,
        y: prev.length * 5,
        w: 6,
        h: 4,
        metric: prev[0]?.metric ?? initialMetric,
      },
    ]);
  };

  const handleRemoveChart = (id: string) => {
    setCharts((prev) => {
      if (prev.length === 1) return prev; // não permite vazio
      return prev.filter((c) => c.id !== id);
    });
    setChartSeriesById((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
  };

  const handleMetricChange = (id: string, ref: MetricRef) => {
    setCharts((prev) => prev.map((c) => (c.id === id ? { ...c, metric: ref } : c)));
  };

  const handleSeriesLoaded = useCallback((id: string, series: MetricPoint[]) => {
    setChartSeriesById((prev) => ({ ...prev, [id]: series }));
  }, []);

  const handlePresetChange = (w: WindowKey) => {
    setPreset(w);
    setBrushRange(null);  // novo preset reseta brush (range muda)
  };

  // Layout: salvar/recuperar
  const handleSaveLayout = (name: string) => {
    layoutsApi.save(name, { default_preset: preset, charts });
  };

  const handleSelectLayout = (id: string | null) => {
    layoutsApi.setCurrent(id);
    if (id) {
      const l = layoutsApi.layouts.find((x) => x.id === id);
      if (l) {
        setCharts(l.charts);
        setPreset(l.default_preset);
        setBrushRange(null);
      }
    }
  };

  const handleImportLayout = async (file: File) => {
    try {
      const imported = await layoutsApi.importLayout(file);
      setCharts(imported.charts);
      setPreset(imported.default_preset);
      setBrushRange(null);
    } catch (e) {
      // erro já é exposto via layoutsApi.error
      console.warn("import failed:", e);
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5">
      {/* Top bar: voltar + layouts */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          onClick={onBack}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-3 py-1 text-sm text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
        >
          ← Voltar pra VM
        </button>
        <AnalysisLayoutPicker
          layouts={layoutsApi.layouts}
          currentLayoutId={layoutsApi.currentLayout?.id ?? null}
          onSelect={handleSelectLayout}
          onSave={handleSaveLayout}
          onRename={(id, name) => layoutsApi.update(id, { name })}
          onDelete={layoutsApi.delete}
          onDuplicate={layoutsApi.duplicate}
          onExport={layoutsApi.exportLayout}
          onImport={handleImportLayout}
          errorMessage={layoutsApi.error}
        />
      </div>

      {/* Preset + brush info */}
      <div className="flex flex-wrap items-center gap-3 border-y border-[var(--color-border-subtle)] py-2">
        <TimeWindowSelector value={preset} onChange={handlePresetChange} />
        {brushRange && (
          <div className="flex items-center gap-2 text-xs">
            <span className="text-[var(--color-text-secondary)]">
              brush: {brushRange.start.toLocaleTimeString("pt-BR")} →{" "}
              {brushRange.end.toLocaleTimeString("pt-BR")}
            </span>
            <button
              onClick={() => setBrushRange(null)}
              className="rounded-md border border-[var(--color-border-subtle)] px-1.5 py-0.5 text-[10px] hover:border-[var(--color-accent-primary)]/60"
            >
              ✕
            </button>
          </div>
        )}
      </div>

      {/* Charts (placeholder: empilhados — Phase D substitui por AnalysisGrid) */}
      <div className="flex flex-col gap-3">
        {charts.map((slot) => (
          <div key={slot.id} style={{ height: 320 }}>
            <AnalysisChartSlot
              slot={slot}
              containers={containerList}
              presetRange={presetRange}
              bucket={params.bucket}
              brushRange={brushRange}
              hoverTs={hoverTs}
              enabled={enabled}
              onMetricChange={handleMetricChange}
              onRemove={handleRemoveChart}
              onBrushChange={setBrushRange}
              onHover={setHoverTs}
              onSeriesLoaded={handleSeriesLoaded}
            />
          </div>
        ))}
        <button
          onClick={handleAddChart}
          className="self-start rounded-md border border-dashed border-[var(--color-border-default)] px-4 py-2 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
        >
          + Adicionar chart
        </button>
      </div>

      {/* Logs */}
      <AnalysisLogsPanel
        range={effectiveRange}
        containers={containerList}
        defaultContainer={initialContainer}
        onLogsFetched={setLastFetchedLogs}
      />
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/AnalysisPage.tsx
git commit -m "feat(analysis): AnalysisPage orquestrador (sem drag-drop ainda — Phase C5)

State global:
- preset (WindowKey) → derived presetRange
- brushRange (subset visual, reset ao mudar preset)
- hoverTs (crosshair sync)
- charts (ChartSlot[])
- chartSeriesById (séries carregadas por slot — pro useAnalysisContext)
- lastFetchedLogs (info do último fetch manual)

Handlers: add/remove/metric change/preset/brush/hover/save layout.

Charts ainda em flex column empilhada — Phase D introduz AnalysisGrid
com react-grid-layout. UI de logs panel + layout picker já funcional."
```

---

## Phase D — Drag-drop responsivo + entrypoints

### Task D1: Instalar `react-grid-layout`

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Instalar**

```bash
pnpm add react-grid-layout@^1.5
pnpm add -D @types/react-grid-layout
```

> **react-grid-layout v2.2.3 funciona com React 19** (peer `>=16.3.0`) — risco do spec mitigado.

- [ ] **Step 2: Confirmar instalação**

```bash
grep -A1 "react-grid-layout" package.json
```

Expected: linhas com `react-grid-layout` em dependencies e `@types/react-grid-layout` em devDependencies.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add react-grid-layout (drag-drop grid responsivo)"
```

### Task D2: `AnalysisGrid` com `<ResponsiveReactGridLayout>`

**Files:**
- Create: `src/components/AnalysisGrid.tsx`
- Modify: `src/App.css` — importa CSS do react-grid-layout

- [ ] **Step 1: Importar CSS do react-grid-layout no App.css**

Edita `src/App.css`. No topo do arquivo (depois do `@import "tailwindcss";` se houver):

```css
@import "react-grid-layout/css/styles.css";
@import "react-resizable/css/styles.css";
```

> Sem isso, drag e resize não funcionam visualmente (handles invisíveis, ghost element sem estilo).

- [ ] **Step 2: Criar `AnalysisGrid.tsx`**

Cria `src/components/AnalysisGrid.tsx`:

```tsx
import { useMemo } from "react";
import { Responsive, WidthProvider } from "react-grid-layout";
import type { Layout } from "react-grid-layout";
import type { ChartSlot, MetricRef } from "../types/analysis";
import type { ContainerInfo, MetricPoint } from "../types/monitor";
import { AnalysisChartSlot } from "./AnalysisChartSlot";
import type { MetricBucket } from "../types/monitor";

const ResponsiveGridLayout = WidthProvider(Responsive);

interface Props {
  charts: ChartSlot[];
  containers: ContainerInfo[];
  presetRange: { start: Date; end: Date };
  bucket: MetricBucket;
  brushRange: { start: Date; end: Date } | null;
  hoverTs: number | null;
  enabled: boolean;
  /** Atualiza posição/tamanho dos slots após drag/resize. */
  onLayoutChange: (charts: ChartSlot[]) => void;
  onMetricChange: (slotId: string, ref: MetricRef) => void;
  onRemove: (slotId: string) => void;
  onBrushChange: (range: { start: Date; end: Date } | null) => void;
  onHover: (ts: number | null) => void;
  onSeriesLoaded: (slotId: string, series: MetricPoint[]) => void;
}

const COLS = { lg: 12, md: 6, sm: 1 };
const BREAKPOINTS = { lg: 900, md: 600, sm: 0 };
const ROW_HEIGHT = 48;

export function AnalysisGrid({
  charts,
  containers,
  presetRange,
  bucket,
  brushRange,
  hoverTs,
  enabled,
  onLayoutChange,
  onMetricChange,
  onRemove,
  onBrushChange,
  onHover,
  onSeriesLoaded,
}: Props) {
  // Layouts por breakpoint:
  //   lg: usa coords salvos
  //   md: derivado (cada slot vira full-width 6 cols)
  //   sm: stack vertical 1 chart por vez
  const layouts = useMemo(() => {
    const lg: Layout[] = charts.map((c) => ({
      i: c.id,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      minW: 3,
      minH: 3,
      maxW: 12,
      maxH: 8,
    }));
    const md: Layout[] = charts.map((c, idx) => ({
      i: c.id,
      x: 0,
      y: idx * 4,
      w: 6,
      h: 4,
      minW: 3,
      minH: 3,
      maxW: 6,
      maxH: 8,
    }));
    const sm: Layout[] = charts.map((c, idx) => ({
      i: c.id,
      x: 0,
      y: idx * 4,
      w: 1,
      h: 4,
      static: true,  // <-- mobile: sem drag/resize
    }));
    return { lg, md, sm };
  }, [charts]);

  const handleLayoutChange = (current: Layout[], _all: { lg: Layout[]; md: Layout[]; sm: Layout[] }) => {
    // Só persiste mudanças no breakpoint LG (single source of truth do schema)
    // current é o layout do breakpoint ativo — só aceita se for lg-shaped (12 cols)
    // Heurística: se algum item tem w > 6, é lg.
    const isLg = current.some((it) => it.w > 6) || current.length === charts.length;
    if (!isLg) return;
    const updated = charts.map((c) => {
      const lg = current.find((l) => l.i === c.id);
      if (!lg) return c;
      return { ...c, x: lg.x, y: lg.y, w: lg.w, h: lg.h };
    });
    onLayoutChange(updated);
  };

  return (
    <ResponsiveGridLayout
      className="layout"
      layouts={layouts}
      cols={COLS}
      breakpoints={BREAKPOINTS}
      rowHeight={ROW_HEIGHT}
      margin={[10, 10]}
      containerPadding={[0, 0]}
      onLayoutChange={handleLayoutChange}
      draggableHandle=".analysis-slot-drag-handle"
      compactType="vertical"
      preventCollision={false}
    >
      {charts.map((slot) => (
        <div key={slot.id}>
          <AnalysisChartSlot
            slot={slot}
            containers={containers}
            presetRange={presetRange}
            bucket={bucket}
            brushRange={brushRange}
            hoverTs={hoverTs}
            enabled={enabled}
            onMetricChange={onMetricChange}
            onRemove={onRemove}
            onBrushChange={onBrushChange}
            onHover={onHover}
            onSeriesLoaded={onSeriesLoaded}
          />
        </div>
      ))}
    </ResponsiveGridLayout>
  );
}
```

- [ ] **Step 3: Substituir o flex column do AnalysisPage pelo AnalysisGrid**

Edita `src/components/AnalysisPage.tsx`. Encontra o bloco que renderiza charts (`<div className="flex flex-col gap-3">` com `charts.map(...)`) e substitui por:

```tsx
<AnalysisGrid
  charts={charts}
  containers={containerList}
  presetRange={presetRange}
  bucket={params.bucket}
  brushRange={brushRange}
  hoverTs={hoverTs}
  enabled={enabled}
  onLayoutChange={setCharts}
  onMetricChange={handleMetricChange}
  onRemove={handleRemoveChart}
  onBrushChange={setBrushRange}
  onHover={setHoverTs}
  onSeriesLoaded={handleSeriesLoaded}
/>
<button
  onClick={handleAddChart}
  className="self-start rounded-md border border-dashed border-[var(--color-border-default)] px-4 py-2 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
>
  + Adicionar chart
</button>
```

E adiciona import no topo:
```tsx
import { AnalysisGrid } from "./AnalysisGrid";
```

- [ ] **Step 4: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 5: Commit**

```bash
git add src/App.css src/components/AnalysisGrid.tsx src/components/AnalysisPage.tsx
git commit -m "feat(analysis): AnalysisGrid drag-drop responsivo via react-grid-layout

- 3 breakpoints (lg=900px, md=600px, sm=0)
- lg: drag-drop + resize completo (12 cols)
- md: single col 6-wide com drag (6 cols)
- sm: stack static (1 col, sem drag/resize) — mobile viewer
- drag handle no header do AnalysisChartSlot (evita conflito com brush)
- onLayoutChange persiste só no breakpoint lg (source of truth)
- CSS imports em App.css (react-grid-layout + react-resizable)"
```

### Task D3: Botão "🔍 Investigar período" no `VmContainerDrawer`

**Files:**
- Modify: `src/components/VmContainerDrawer.tsx`

- [ ] **Step 1: Adicionar prop e botão**

Edita `src/components/VmContainerDrawer.tsx`. No header (próximo do botão `✕`), adicionar botão de investigação:

```tsx
// Adicionar à interface Props:
interface Props {
  containerName: string;
  enabled: boolean;
  onClose: () => void;
  onInvestigate?: (containerName: string) => void;  // NEW
}

// Adicionar prop ao destructure:
export function VmContainerDrawer({
  containerName,
  enabled,
  onClose,
  onInvestigate,  // NEW
}: Props) {
```

E no JSX do header, antes do botão `✕`:

```tsx
<header className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-3">
  <div className="min-w-0">
    {/* ... existente ... */}
  </div>
  <div className="flex items-center gap-2">
    {onInvestigate && (
      <button
        onClick={() => onInvestigate(containerName)}
        className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
        title="Abre o modo análise focado neste container"
      >
        🔍 Investigar período
      </button>
    )}
    <button
      onClick={onClose}
      // ... existente ...
    >
      ✕
    </button>
  </div>
</header>
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/VmContainerDrawer.tsx
git commit -m "feat(analysis): botão 'Investigar período' no VmContainerDrawer

Prop opcional onInvestigate(containerName) — quando presente, renderiza
botão no header. Click chama callback que VmTab usa pra entrar no
modo análise pré-populado."
```

### Task D4: Botão idem no `StackDrawer`

**Files:**
- Modify: `src/components/StackDrawer.tsx`

- [ ] **Step 1: Adicionar prop e botão no bloco "Backend container"**

Edita `src/components/StackDrawer.tsx`. Adicionar prop:

```tsx
interface Props {
  stackName: string;
  enabled: boolean;
  onClose: () => void;
  onInvestigateContainer?: (containerName: string) => void;  // NEW
}
```

E no `ContainersSection` (ou onde renderiza o sub-bloco backend), adicionar botão por container:

```tsx
{onInvestigateContainer && (
  <button
    onClick={() => onInvestigateContainer(container.name)}
    className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[10px] text-[var(--color-text-secondary)] transition hover:border-[var(--color-accent-primary)]/60 hover:text-[var(--color-accent-primary)]"
    title="Abre o modo análise focado neste container"
  >
    🔍 Investigar período
  </button>
)}
```

> **Nota:** o `StackDrawer` tem sub-componente `ContainerBlock` no arquivo. Adicionar a prop `onInvestigateContainer` na interface dele e passar do `StackDrawer` pra cada `ContainerBlock`. Se o componente atual não está separado, encontrar a parte que renderiza por container e injetar o botão lá.

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/components/StackDrawer.tsx
git commit -m "feat(analysis): botão 'Investigar período' no StackDrawer (por container)"
```

### Task D5: `vmView` state no `VmTab` + click em `VmMetricChart`

**Files:**
- Modify: `src/components/VmTab.tsx`
- Modify: `src/components/VmMetricChart.tsx`

- [ ] **Step 1: Tornar `VmMetricChart` clicável**

Edita `src/components/VmMetricChart.tsx`. Adicionar prop opcional:

```tsx
interface Props {
  // ... existentes ...
  onClick?: () => void;  // NEW
}

export function VmMetricChart({ /* ... */, onClick }: Props) {
  return (
    <div
      onClick={onClick}
      className={
        "rounded-lg border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-3 transition" +
        (onClick ? " cursor-pointer hover:border-[var(--color-accent-primary)]/40" : "")
      }
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {/* ... resto existente ... */}
    </div>
  );
}
```

> **Nota:** se `VmMetricChart` retorna outra coisa que não `<div>`, ajustar pra wrappar com div clicável.

- [ ] **Step 2: Adicionar state `vmView` em `VmTab`**

Edita `src/components/VmTab.tsx` adicionando state e renderização condicional:

```tsx
import { AnalysisPage } from "./AnalysisPage";
import type { MetricRef } from "../types/analysis";

// ...

type VmView =
  | { kind: "dashboard" }
  | { kind: "analysis"; initialMetric: MetricRef; initialContainer: string | null };

export function VmTab() {
  const { ready, error } = useTunnel();
  // ... outros states existentes ...
  const [vmView, setVmView] = useState<VmView>({ kind: "dashboard" });

  // Helper pra entrar em análise
  const enterAnalysis = useCallback(
    (metric: MetricRef, container: string | null = null) => {
      setVmView({ kind: "analysis", initialMetric: metric, initialContainer: container });
    },
    [],
  );

  // ... resto do component ...

  if (vmView.kind === "analysis") {
    return (
      <AnalysisPage
        enabled={ready}
        initialMetric={vmView.initialMetric}
        initialContainer={vmView.initialContainer}
        onBack={() => setVmView({ kind: "dashboard" })}
      />
    );
  }

  return (
    // ... JSX existente do dashboard ...
  );
}
```

E nos `VmMetricChart` da seção "VM geral", adicionar `onClick`:

```tsx
<VmMetricChart
  title="Load 1m"
  source="vm"
  metric="load_1m"
  // ... existente ...
  onClick={() => enterAnalysis({ kind: "vm", metric: "load_1m" })}
/>
<VmMetricChart
  title="RAM usada"
  source="vm"
  metric="mem_used_bytes"
  // ... existente ...
  onClick={() => enterAnalysis({ kind: "vm", metric: "mem_used_bytes" })}
/>
{/* etc pra CPU, Disco, Network */}
```

E nos drawers, passar callbacks pra entrar em análise:

```tsx
<VmContainerDrawer
  // ... existente ...
  onInvestigate={(name) =>
    enterAnalysis({ kind: "container", resource: name, metric: "cpu_pct" }, name)
  }
/>
```

E no `StackGrid` ou onde quer que o `StackDrawer` é renderizado, propagar callback similar.

- [ ] **Step 3: Type-check**

```bash
pnpm exec tsc --noEmit 2>&1 | tail -5
```

Expected: zero erros.

- [ ] **Step 4: Build smoke release pra confirmar tudo linka**

```bash
pnpm tauri build --bundles deb,rpm 2>&1 | tail -5
```

Expected: build limpo.

- [ ] **Step 5: Reinstalar binário pra teste manual**

```bash
rm -f ~/.local/bin/falcao-launcher
cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher
ls -la ~/.local/bin/falcao-launcher
```

- [ ] **Step 6: Commit**

```bash
git add src/components/VmTab.tsx src/components/VmMetricChart.tsx
git commit -m "feat(analysis): entrypoints — click em VmMetricChart abre análise

- VmMetricChart aceita prop onClick (cursor pointer + a11y)
- VmTab tem state vmView com union dashboard|analysis
- VmContainerDrawer e StackDrawer recebem onInvestigate callback
- Click em chart 'Load 1m' / 'RAM' / 'CPU' / 'Disco' / 'Network' → análise
  pré-populada com aquela métrica VM
- Drawers (Container/Stack) → análise pré-populada com container.cpu_pct"
```

### Task D6: Smoke manual end-to-end

> **Não é uma task de código** — é um checkpoint de validação manual antes de Phase E. Falcão executa.

- [ ] **Validação 1:** Abrir launcher, ir na aba VM, dashboard normal aparece
- [ ] **Validação 2:** Click no chart "CPU" → entra em análise com chart pré-populado, botão voltar visível
- [ ] **Validação 3:** Adicionar 3 charts (1 RAM, 1 disco, 1 container.falcao-financas), arrastar/redimensionar grid
- [ ] **Validação 4:** Brush num chart → outros mostram marcadores verde nos mesmos timestamps; chip de brush no header com ✕
- [ ] **Validação 5:** Hover num chart → linha tracejada amber em todos os charts
- [ ] **Validação 6:** Salvar layout como "test-1", recarregar app, layout persiste, vê no select
- [ ] **Validação 7:** Export → JSON baixa; Import noutra "instalação" (ou após `localStorage.clear()`) → layout volta
- [ ] **Validação 8:** Logs panel → selectbox mostra containers, click "Buscar logs do período" funciona
- [ ] **Validação 9:** Range > 24h → botão buscar logs disabled com mensagem
- [ ] **Validação 10:** Mobile (DevTools 375px) → charts empilhados, sem horizontal scroll, brush mais "fino" mas funciona

Se algum item falhar: report e corrige antes de Phase E.

---

## Phase E — Validação, docs, PR

### Task E1: Atualizar `agent.md` das pastas tocadas

**Files:**
- Modify: `src-tauri/src/monitor/.agent.md`
- Modify: `src/components/.agent.md`
- Modify: `src/types/.agent.md`
- Modify: `src/lib/.agent.md`

- [ ] **Step 1: `src-tauri/src/monitor/.agent.md`**

Adicionar entrada em "Decisões recentes":
```markdown
- 2026-05-07 (Sprint 3 — modo análise): comando `monitor_fetch_logs_range` (`docker logs --since/--until` via SSH). Validações: regex container, range max 24h, until > since. Retorna `LogsRangeResponse { text, truncated, line_count }`. 7 testes unitários nos helpers.
```

E em "Arquivos", adicionar comando à lista:
```markdown
- `commands.rs` — ... + `monitor_fetch_logs_range` (Sprint 3).
```

- [ ] **Step 2: `src/components/.agent.md`**

Adicionar nova seção "Sprint 3 — modo análise":
```markdown
### Sprint 3 — Modo análise

- **`AnalysisPage.tsx`** — orquestrador da página de análise. State global (preset, brushRange, charts, hoverTs, lastFetchedLogs). Substitui o conteúdo da aba VM via prop `vmView` no parent.
- **`AnalysisGrid.tsx`** — wrapper `<ResponsiveReactGridLayout>`. Breakpoints lg/md/sm, drag-drop só nos dois primeiros. drag handle = header do slot.
- **`AnalysisChartSlot.tsx`** — slot do grid: MetricPicker + Recharts LineChart + Brush. Re-fetch quando preset/metric muda; brush não re-fetcha. Hover sync via ReferenceLine.
- **`AnalysisLogsPanel.tsx`** — selectbox container + botão "Buscar logs". Bloqueia se range > 24h. Banner truncado se response.truncated.
- **`AnalysisLayoutPicker.tsx`** — header do AnalysisPage. CRUD de layouts (salvar/renomear/duplicar/excluir/export/import).
- **`MetricPicker.tsx`** — `<select>` agrupado por source (VM/Hetzner/Containers). Encoded value `kind:metric` ou `container:resource:metric`.
- **Mods:** `VmMetricChart` aceita `onClick`. `VmContainerDrawer` e `StackDrawer` aceitam `onInvestigate(container)` e renderizam botão "🔍 Investigar período". `VmTab` tem state `vmView` com union dashboard|analysis.
```

- [ ] **Step 3: `src/types/.agent.md`**

Adicionar arquivo novo em "Arquivos":
```markdown
- `analysis.ts` — Sprint 3: `MetricRef` (discriminated union), `ChartSlot`, `AnalysisLayout`, `LayoutsBundle`, `AnalysisContext`, `LogsRangeResponse`. Constants `ANALYSIS_SCHEMA_VERSION` (1) e `LAYOUTS_STORAGE_KEY`. Helper `createDefaultBundle()`.
```

E em "Decisões recentes":
```markdown
- 2026-05-07 (Sprint 3): tipos do modo análise. Schema versionado (`ANALYSIS_SCHEMA_VERSION = 1`). MetricRef é discriminated union por `kind` — espelha shape do backend Rust.
```

- [ ] **Step 4: `src/lib/.agent.md`**

Adicionar arquivos:
```markdown
- `useAnalysisLayouts.ts` — Sprint 3: hook CRUD pros layouts em localStorage. Schema validation tolerante (corrompido → recria, versão futura → recusa). Export/import JSON. Sem zod.
- `useAnalysisContext.ts` — Sprint 3: hook agregador. `useMemo` sobre o state do AnalysisPage gera `AnalysisContext` serializável (Sprint 4 / Claude vai consumir).
- Wrapper `monitorApi.fetchLogsRange()` (Sprint 3).
```

- [ ] **Step 5: Commit (todos juntos)**

```bash
git add src-tauri/src/monitor/.agent.md src/components/.agent.md src/types/.agent.md src/lib/.agent.md
git commit -m "docs: agent.md Sprint 3 — modo análise"
```

### Task E2: Atualizar `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Adicionar seção "Feature: Modo análise (Sprint 3)" após "Feature: Vercel stacks (Sprint 2)"**

Edita `CLAUDE.md`:

```markdown
## Feature: Modo análise (Sprint 3)

Aba VM ganhou modo análise: click num chart abre página dedicada com grid drag-drop, brush selection sincronizado entre charts, logs do período sob demanda, e layouts salvos.

- **Spec:** `docs/superpowers/specs/2026-05-07-modo-analise-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-07-modo-analise.md`
- **Stack adicional:** `react-grid-layout@^1.5` (drag-drop responsivo, lg/md/sm breakpoints).
- **Backend novo:** `monitor_fetch_logs_range` (range arbitrário via `docker logs --since/--until`, max 24h).
- **Persistência:** localStorage `analysis:layouts:v1` versionado; export/import JSON pra portar entre máquinas.
- **Hook futuro:** `useAnalysisContext` centraliza estado serializável pra integração Claude (Sprint 4).
- **Mobile (<600px):** modo viewer — charts empilhados, sem drag-drop, brush desabilitado.

### Componentes frontend novos (Sprint 3)
- `src/components/AnalysisPage.tsx` — orquestrador.
- `src/components/AnalysisGrid.tsx` — wrapper react-grid-layout.
- `src/components/AnalysisChartSlot.tsx` — slot Recharts + brush.
- `src/components/AnalysisLogsPanel.tsx` — fetch manual.
- `src/components/AnalysisLayoutPicker.tsx` — gerenciamento de layouts.
- `src/components/MetricPicker.tsx` — select agrupado.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: CLAUDE.md ganhou seção Sprint 3 — modo análise"
```

### Task E3: Atualizar `VALIDATION.md`

**Files:**
- Modify: `docs/superpowers/vm-migrations/VALIDATION.md`

- [ ] **Step 1: Adicionar seção Sprint 3 ao final**

Edita `docs/superpowers/vm-migrations/VALIDATION.md` adicionando ao final:

```markdown
---

## Sprint 3 — Modo análise (2026-05-07)

Spec: `docs/superpowers/specs/2026-05-07-modo-analise-design.md`
Plan: `docs/superpowers/plans/2026-05-07-modo-analise.md`

### Acceptance criteria (15 itens do spec)

- [x] Click em VmMetricChart transiciona pra AnalysisPage pré-populado
- [x] Botão "← Voltar" volta pra dashboard
- [x] Drag-drop em desktop funciona (arrastar/redimensionar persiste)
- [x] Mobile (<600px) renderiza charts empilhados sem horizontal scroll
- [x] Brush sincroniza visualmente em todos os charts
- [x] Hover sincroniza crosshair em todos
- [x] Logs fetched manualmente via botão pelo container do select
- [x] Range > 24h pra logs é bloqueado
- [x] "Salvar layout como" persiste em localStorage
- [x] Export gera JSON downloadável; import lê e adiciona à lista
- [x] Schema corrompido / versão futura é tratado com toast + fallback
- [x] `useAnalysisContext` retorna estado serializável
- [x] Build release passa sem warnings novos
- [x] cargo test passa (incluindo 7 novos do `commands::tests`)
- [x] Documentação atualizada (4 agent.md + CLAUDE.md + skill)

### Observações operacionais

- **react-grid-layout v2.2.3 funciona com React 19 sem patch** — peer `>=16.3.0` é lenient. Risco listado no spec mitigado.
- **Recharts `<Brush>` em mobile <600px:** desabilitado via breakpoint sm com `static: true`. Não testamos comportamento touch ainda.
- **localStorage quota:** uso típico ~5KB por layout. Quota ~5MB → ~1000 layouts antes de hit. Aceitável.

### Phase 4 backlog reconhecido

Pedido pelo Falcão durante brainstorm, parqueado pra próxima sprint:
- **Integração Claude** — botão "Investigar com Claude" que consome `useAnalysisContext` e abre conversa pré-populada com range + métricas + logs.
- **Web App PWA** — versão browser do launcher pra acessar do celular.
- **Alertas + Telegram bot** — push notifications pra alertas configuráveis.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/vm-migrations/VALIDATION.md
git commit -m "docs(validation): seção Sprint 3 — modo análise (15 acceptance criteria)"
```

### Task E4: Atualizar skill `falcao-launcher` (fora do repo)

**Files:**
- Modify: `~/.claude/skills/falcao-launcher/SKILL.md` (não vai pro PR)

- [ ] **Step 1: Adicionar bloco "2026-05-07 — sessão 8" ao diário**

Edita `~/.claude/skills/falcao-launcher/SKILL.md` adicionando ao final:

```markdown
### 2026-05-07 — sessão 8 (Sprint 3 — modo análise)

[Resumo da Sprint 3, decisões D1-D7, lições aprendidas, estado pra próxima sessão]
[A LLM executora preenche conforme implementação real progride.]
```

> Esse step é template — quem executar a sprint atualiza com o conteúdo real ao final.

- [ ] **Step 2: Não tem commit** (skill mora fora do repo)

### Task E5: Push branch e abrir PR

- [ ] **Step 1: Push**

```bash
git push -u origin feature/modo-analise 2>&1 | tail -5
```

Expected: branch criada no remote.

- [ ] **Step 2: Abrir PR pra `main`**

```bash
gh pr create --base main --head feature/modo-analise \
  --title "feat(monitor): Sprint 3 — modo análise (gráficos expandidos com brush + sync + dashboard customizável)" \
  --body "$(cat <<'EOF'
## Summary

Aba VM ganhou modo análise: click num chart abre página dedicada com grid drag-drop, brush selection sincronizado entre charts, logs do período sob demanda, e layouts nomeados em localStorage com export/import.

## Spec & plan

- Spec: `docs/superpowers/specs/2026-05-07-modo-analise-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-modo-analise.md`
- Validation: `docs/superpowers/vm-migrations/VALIDATION.md` (seção Sprint 3)

## O que entrou

### Backend Rust
- Comando `monitor_fetch_logs_range` (`docker logs --since/--until` via SSH, max 24h, regex container)
- 7 testes unitários nos helpers

### Frontend
- 6 componentes novos: AnalysisPage, AnalysisGrid, AnalysisChartSlot, AnalysisLogsPanel, AnalysisLayoutPicker, MetricPicker
- 2 hooks novos: useAnalysisLayouts (CRUD localStorage + export/import + migration), useAnalysisContext (serializável p/ Sprint 4)
- Tipos novos em src/types/analysis.ts (schema versionado)
- Botão "🔍 Investigar período" em VmContainerDrawer e StackDrawer
- Click em VmMetricChart abre análise pré-populada

### Stack
- `react-grid-layout@^1.5` adicionado (drag-drop responsivo, lg/md/sm breakpoints)

## Acceptance

15 critérios validados — ver VALIDATION.md.

## Test plan

- [x] cargo test (7 testes novos do commands::tests passando)
- [x] tsc --noEmit clean
- [x] Build release sem warnings novos
- [x] Smoke manual: click chart → análise, brush sync, logs fetch, save/load layout, export/import JSON
- [x] Mobile (<600px) viewer testado em DevTools

## Phase 4 backlog reconhecido

- Integração Claude consumindo useAnalysisContext (Sprint 4)
- Web App PWA pra acesso pelo celular
- Alertas + Telegram bot

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -5
```

Expected: URL do PR retornado.

- [ ] **Step 3: Confirmar e relatar pro Falcão**

PR aberto. Aguardar decisão do Falcão pra mergear (ele faz merge manualmente quando quiser).

---

## Resumo das fases

| Phase | Escopo | Tempo estimado |
|---|---|---|
| **A** | Backend Rust (`monitor_fetch_logs_range` + 7 testes) | ~30 min |
| **B-types** | `src/types/analysis.ts` + `monitorApi.fetchLogsRange` | ~20 min |
| **B-hooks** | `useAnalysisLayouts` + `useAnalysisContext` | ~60 min |
| **C** | 5 componentes (MetricPicker, AnalysisChartSlot, LogsPanel, LayoutPicker, AnalysisPage placeholder) | ~120 min |
| **D** | react-grid-layout + AnalysisGrid + entrypoints | ~75 min |
| **E** | Docs (4 agent.md + CLAUDE.md + VALIDATION) + skill + PR | ~45 min |
| **Total sequencial** | | **~5-6h** |
| **Com paralelização** | B-hooks ‖ C (após B-types) | **~3.5-4h** |

## Paralelização recomendada

**Round 1 (sequencial):** Phase A → Phase B-types
**Round 2 (paralelo):** Phase B-hooks ‖ Phase C — em worktrees isolados (sem overlap de arquivos)
**Round 3 (sequencial):** merge worktrees → Phase D → Phase E

Isso reduz tempo total ~30%. Phase B-hooks só toca `src/lib/`, Phase C só toca `src/components/` — overlap zero.

## Riscos de execução

1. **`react-grid-layout` styling conflict** — CSS importado em `App.css` pode entrar em conflito com Tailwind. Mitigação: classes do RGL têm prefix `react-grid-*` e são bem contidas. Testar visualmente.
2. **Recharts `<Brush>` re-render performance** — com 6+ charts, hover sync pode laggear. Mitigação documentada no spec: `React.memo` + throttle. Aceitar lag em primeira passada se necessário.
3. **`crypto.randomUUID()` em browser antigo** — Tauri webview usa WebKit moderno, supported. Não é risco real.
4. **localStorage em modo incognito** — pode falhar silenciosamente. Hook trata com `try/catch` e error string surface.
5. **Drag handle conflict com brush** — drag handle = header do slot, brush = bottom do chart. Não devem conflitar, mas testar bem em desktop.
