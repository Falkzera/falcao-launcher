# Claude Code Awareness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tornar o falcao-launcher consciente das sessões do Claude Code que vivem em `~/.claude/projects/`. Cada projeto exibe chip de status Claude, lista histórica de sessões com chart de tokens por tempo, botão "spawn Claude here", tudo derivado de leitura passiva dos JSONL existentes.

**Architecture:** Módulo Rust novo (`claude.rs`) faz scan + parse + agregação de JSONLs, expõe via comandos Tauri e evento `claude-state`. Frontend React adiciona chip nos cards, refator do drawer pra `ProjectDetailDrawer` com tabs `[Logs][Claude]`, tab Claude monta `<TokensChart>` (Recharts) + lista de sessões. Cost é função pura de `(tokens, pricing_atual)` — re-precificável.

**Tech Stack:** Tauri 2 (Rust + WebView2), React 19, TypeScript 5.8, Tailwind v4, Framer Motion 12, Recharts 2 (NOVO), tokio + notify (NOVO) + chrono (NOVO) no Rust.

**Spec:** [`../specs/2026-05-05-claude-awareness-design.md`](../specs/2026-05-05-claude-awareness-design.md)

---

## File Structure

### Novos arquivos

| Path | Responsabilidade |
|---|---|
| `src-tauri/src/claude.rs` | Tipos, parser JSONL, agregação, pricing, watcher, comandos Tauri |
| `src-tauri/src/claude/pricing.rs` | (subarquivo opcional) Tabela de pricing isolada — manter se ficar > 80 linhas |
| `src-tauri/tests/fixtures/sample_session.jsonl` | Fixture real, copiada de `~/.claude/projects/.../2d723405-...jsonl` |
| `src/components/ClaudeChip.tsx` | Chip "Claude · 2min" / "Claude · 12 sessões". Reusado em Card e ListItem |
| `src/components/Tabs.tsx` | Componente primitivo `<Tabs>` minimalista (uso: Logs/Claude no drawer) |
| `src/components/ProjectDetailDrawer.tsx` | Renomeado/refatorado de `LogsDrawer` — agora tem tabs |
| `src/components/ClaudeTab.tsx` | Conteúdo da tab Claude: summary header + chart + sessions list |
| `src/components/TokensChart.tsx` | Recharts `<LineChart>` com toggle dia/mês/ano |
| `src/components/SessionsList.tsx` | Lista vertical de sessões |
| `src/components/SpawnClaudeButton.tsx` | Botão (ícone terminal+sparkle) chamando `spawn_claude` |

### Arquivos modificados

| Path | Mudança |
|---|---|
| `src-tauri/Cargo.toml` | Adiciona `notify = "6"`, `chrono = "0.4"` |
| `src-tauri/src/lib.rs` | Registra módulo `claude`, comandos, evento periódico, watcher startup |
| `src-tauri/src/external.rs` | Adiciona `spawn_claude(path)` |
| `src/types.ts` | `ClaudeSession`, `ClaudeProjectState`, `AggregatedUsage`, `TokenBucket`, `Granularity` |
| `src/App.tsx` | State + listener `claude-state`, snapshot inicial, passa props pros Cards |
| `src/App.css` | Tokens novos: `--color-claude-primary`, `--color-claude-soft` |
| `src/components/ProjectCard.tsx` | Renderiza `<ClaudeChip>` + `<SpawnClaudeButton>` |
| `src/components/ProjectListItem.tsx` | Idem |
| `src/components/LogsDrawer.tsx` | **Removido** (substituído por `ProjectDetailDrawer`) |

### Distribuição em subagents (paralelizáveis)

- **Agent A (Rust)** — Tasks A1–A8. Independente após Phase 0.
- **Agent B (Frontend cards)** — Tasks B1–B6. Depende de Task A1 (tipos compatíveis) mas pode rodar em paralelo após B1 (tipos TS espelhados).
- **Agent C (Drawer + chart)** — Tasks C1–C7. Independente de B; depende dos tipos (B1) e dos comandos Rust (A7).
- **CTO (Opus, eu)** — Phase 0 setup + Phase 4 polish + integração entre agentes.

---

## Phase 0: Setup (CTO faz antes de despachar agentes)

### Task 0.1: Copiar fixture real pra testes Rust

**Files:**
- Create: `src-tauri/tests/fixtures/sample_session.jsonl`

- [ ] **Step 1: Criar diretório**

```bash
mkdir -p src-tauri/tests/fixtures
```

- [ ] **Step 2: Copiar sessão real (a antiga, estável, não a deste chat)**

```bash
cp ~/.claude/projects/-home-falcao-Projects-falcao-launcher/2d723405-4e36-457d-a438-2b398482cfe5.jsonl \
   src-tauri/tests/fixtures/sample_session.jsonl
```

- [ ] **Step 3: Verificar — deve ter ≥ 1 evento de cada tipo crítico**

```bash
python3 -c "
import json
types = {}
for line in open('src-tauri/tests/fixtures/sample_session.jsonl'):
    try:
        t = json.loads(line).get('type')
        types[t] = types.get(t, 0) + 1
    except: pass
print(types)
"
```

Expected: dict with `user`, `assistant`, `ai-title`, `system` keys, each ≥ 1.

- [ ] **Step 4: Commit fixture**

```bash
git add src-tauri/tests/fixtures/sample_session.jsonl
git commit -m "test(claude): adicionar fixture real de sessão pra testes do parser"
```

---

### Task 0.2: Adicionar dependências Rust

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Adicionar notify e chrono (separado por feature flags)**

```bash
cd src-tauri && cargo add notify@6 && cargo add chrono@0.4 --no-default-features --features clock,serde
cd ..
```

Expected: Cargo.toml ganha duas linhas; Cargo.lock atualiza.

- [ ] **Step 2: Validar build**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --quiet 2>&1 | tail -5
```

Expected: build sem erros (warnings sobre crates não-usadas são OK temporariamente).

- [ ] **Step 3: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "build: adicionar notify e chrono pro módulo claude"
```

---

### Task 0.3: Tokens de design indigo Claude

**Files:**
- Modify: `src/App.css`

- [ ] **Step 1: Adicionar tokens no `@theme {}`**

Localizar bloco `@theme {}` em `src/App.css` (após `--color-info`), adicionar:

```css
  /* Claude family — sessões / IA */
  --color-claude-primary: #a78bfa;
  --color-claude-soft: rgba(167, 139, 250, 0.13);
```

- [ ] **Step 2: Light mode override**

Localizar bloco `@media (prefers-color-scheme: light)`, adicionar dentro de `:root`:

```css
    --color-claude-primary: #7c3aed;
    --color-claude-soft: rgba(124, 58, 237, 0.13);
```

- [ ] **Step 3: Verificar TS compila (Tailwind v4 gera classes a partir desses tokens)**

```bash
pnpm exec tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 4: Commit**

```bash
git add src/App.css
git commit -m "feat(design): tokens Claude indigo (primary + soft) com light mode"
```

---

## Phase 1 — Agent A (Rust core)

> **Briefing pra o agente:** Você está implementando o data layer do recurso "Claude Code awareness" no falcao-launcher. Lê JSONL files de `~/.claude/projects/`, agrega tokens por sessão e por projeto, expõe via comandos Tauri. Use `procfs`-style helpers existentes (`netstat.rs`) como referência de estilo. Falcão não escreve Rust — comente decisões não-óbvias com 1 linha.

### Task A1: Esqueleto do módulo + tipos centrais

**Files:**
- Create: `src-tauri/src/claude.rs`
- Modify: `src-tauri/src/lib.rs:1-7`

- [ ] **Step 1: Criar `claude.rs` com tipos**

```rust
// src-tauri/src/claude.rs
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct AggregatedUsage {
    pub input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub output_tokens: u64,
}

impl AggregatedUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
            + self.output_tokens
    }

    pub fn add(&mut self, other: &AggregatedUsage) {
        self.input_tokens += other.input_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
        self.output_tokens += other.output_tokens;
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct ClaudeSession {
    pub session_id: String,
    pub project_path: String,
    pub git_branch: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub started_at: i64,        // unix ms
    pub last_activity: i64,     // unix ms
    pub message_count: u32,
    pub duration_ms: u64,
    pub usage: AggregatedUsage,
}

#[derive(Serialize, Clone, Debug)]
pub struct ClaudeProjectState {
    pub project_path: String,
    pub sessions: Vec<ClaudeSession>,
    pub active_session_id: Option<String>,
    pub total_usage: AggregatedUsage,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Day,
    Month,
    Year,
}

#[derive(Serialize, Clone, Debug)]
pub struct TokenBucket {
    pub bucket_start: i64, // unix ms
    pub usage: AggregatedUsage,
}

const ACTIVE_WINDOW_MS: i64 = 5 * 60 * 1000;

pub fn is_active(last_activity: i64, now_ms: i64) -> bool {
    now_ms - last_activity <= ACTIVE_WINDOW_MS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregated_usage_total_tokens() {
        let u = AggregatedUsage {
            input_tokens: 10,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
            output_tokens: 1,
        };
        assert_eq!(u.total_tokens(), 1111);
    }

    #[test]
    fn aggregated_usage_add() {
        let mut a = AggregatedUsage {
            input_tokens: 10,
            ..Default::default()
        };
        let b = AggregatedUsage {
            input_tokens: 5,
            output_tokens: 3,
            ..Default::default()
        };
        a.add(&b);
        assert_eq!(a.input_tokens, 15);
        assert_eq!(a.output_tokens, 3);
    }

    #[test]
    fn is_active_within_window() {
        let now = 1_700_000_000_000;
        assert!(is_active(now - 4 * 60 * 1000, now));
    }

    #[test]
    fn is_active_outside_window() {
        let now = 1_700_000_000_000;
        assert!(!is_active(now - 6 * 60 * 1000, now));
    }
}
```

- [ ] **Step 2: Registrar módulo em `lib.rs`**

Em `src-tauri/src/lib.rs`, alterar o bloco de imports do topo:

```rust
mod config;
mod external;
mod icon;
mod netstat;
mod ports;
mod process;
mod scanner;
mod claude;        // <-- adicionar esta linha
```

- [ ] **Step 3: Rodar testes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -10
```

Expected: 4 testes passando.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/claude.rs src-tauri/src/lib.rs
git commit -m "feat(claude): esqueleto do módulo + tipos centrais (AggregatedUsage, ClaudeSession, ClaudeProjectState, Granularity, TokenBucket)"
```

---

### Task A2: Pricing table + cost calculation

**Files:**
- Modify: `src-tauri/src/claude.rs` (anexar bloco)

**Conceito Rust pra contexto:** `&'static str` é uma string constante embedada no binário; `match` é exaustivo (compilador exige cobrir todos os casos).

- [ ] **Step 1: Escrever testes primeiro**

Anexar ao `mod tests` em `claude.rs`:

```rust
    #[test]
    fn cost_opus_pure_input() {
        let usage = AggregatedUsage {
            input_tokens: 1_000_000,
            ..Default::default()
        };
        let cost = cost_usd(&usage, pricing_for("claude-opus-4-7"));
        assert!((cost - 15.00).abs() < 0.0001, "got {}", cost);
    }

    #[test]
    fn cost_opus_mixed() {
        // 100k input, 200k cache_create, 500k cache_read, 50k output
        // = 0.1 * 15 + 0.2 * 18.75 + 0.5 * 1.50 + 0.05 * 75
        // = 1.5 + 3.75 + 0.75 + 3.75 = 9.75
        let usage = AggregatedUsage {
            input_tokens: 100_000,
            cache_creation_input_tokens: 200_000,
            cache_read_input_tokens: 500_000,
            output_tokens: 50_000,
        };
        let cost = cost_usd(&usage, pricing_for("claude-opus-4-7"));
        assert!((cost - 9.75).abs() < 0.0001, "got {}", cost);
    }

    #[test]
    fn cost_unknown_model_falls_back_to_sonnet() {
        let usage = AggregatedUsage {
            input_tokens: 1_000_000,
            ..Default::default()
        };
        let cost = cost_usd(&usage, pricing_for("claude-future-99"));
        // Sonnet input = 3.00
        assert!((cost - 3.00).abs() < 0.0001, "got {}", cost);
    }
```

- [ ] **Step 2: Rodar testes — devem falhar (função não existe)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -10
```

Expected: erro de compilação `cannot find function cost_usd`.

- [ ] **Step 3: Implementar pricing + cost**

Anexar ao `claude.rs` (acima do `mod tests`):

```rust
#[derive(Clone, Copy)]
pub struct ModelPricing {
    pub input_per_1m: f64,
    pub cache_create_per_1m: f64,
    pub cache_read_per_1m: f64,
    pub output_per_1m: f64,
}

pub const PRICING_AS_OF_2026_05: &[(&str, ModelPricing)] = &[
    ("claude-opus-4-7", ModelPricing {
        input_per_1m: 15.00,
        cache_create_per_1m: 18.75,
        cache_read_per_1m: 1.50,
        output_per_1m: 75.00,
    }),
    ("claude-sonnet-4-6", ModelPricing {
        input_per_1m: 3.00,
        cache_create_per_1m: 3.75,
        cache_read_per_1m: 0.30,
        output_per_1m: 15.00,
    }),
    ("claude-haiku-4-5", ModelPricing {
        input_per_1m: 0.80,
        cache_create_per_1m: 1.00,
        cache_read_per_1m: 0.08,
        output_per_1m: 4.00,
    }),
];

const FALLBACK_PRICING: ModelPricing = ModelPricing {
    input_per_1m: 3.00,
    cache_create_per_1m: 3.75,
    cache_read_per_1m: 0.30,
    output_per_1m: 15.00,
};

/// Resolve pricing por prefixo de model id. Ex: "claude-opus-4-7-1m" casa "claude-opus-4-7".
pub fn pricing_for(model: &str) -> &'static ModelPricing {
    for (key, pricing) in PRICING_AS_OF_2026_05 {
        if model.starts_with(key) {
            return pricing;
        }
    }
    &FALLBACK_PRICING
}

pub fn cost_usd(usage: &AggregatedUsage, p: &ModelPricing) -> f64 {
    (usage.input_tokens as f64 * p.input_per_1m
        + usage.cache_creation_input_tokens as f64 * p.cache_create_per_1m
        + usage.cache_read_input_tokens as f64 * p.cache_read_per_1m
        + usage.output_tokens as f64 * p.output_per_1m)
        / 1_000_000.0
}
```

- [ ] **Step 4: Rodar testes — todos devem passar**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -10
```

Expected: 7 passing (4 prévios + 3 novos).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude.rs
git commit -m "feat(claude): tabela de pricing + cost_usd com fallback Sonnet (TDD)"
```

---

### Task A3: Parser JSONL — uma sessão

**Files:**
- Modify: `src-tauri/src/claude.rs` (anexar bloco)

**Conceito Rust pra contexto:** `serde_json::Value` é uma representação dinâmica de JSON (igual `any` em TS). Usamos pra eventos com schema variável.

- [ ] **Step 1: Escrever teste**

Anexar ao `mod tests`:

```rust
    use std::path::Path;

    fn fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/sample_session.jsonl")
    }

    #[test]
    fn parse_real_session_has_basic_fields() {
        let path = fixture_path();
        let session = parse_session_file(&path).expect("parser must succeed");
        assert!(!session.session_id.is_empty(), "session_id deve ser parseado do nome do arquivo");
        assert!(session.message_count > 0);
        assert!(session.usage.total_tokens() > 0, "fixture deve ter pelo menos 1 evento assistant com usage");
        assert!(session.last_activity > session.started_at);
        assert!(!session.project_path.is_empty(), "cwd deve estar populado");
    }

    #[test]
    fn parse_real_session_extracts_title() {
        let session = parse_session_file(&fixture_path()).unwrap();
        // Sessão real tem ai-title — pode ser None só se a sessão for muito curta
        // Se for None, é falha do fixture, não do parser
        assert!(session.title.is_some(), "fixture deve conter pelo menos um evento ai-title");
    }
```

- [ ] **Step 2: Rodar testes — devem falhar (função não existe)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -10
```

Expected: `cannot find function parse_session_file`.

- [ ] **Step 3: Implementar parser**

Anexar ao `claude.rs`:

```rust
use chrono::DateTime;
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

fn parse_iso_to_unix_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Parseia um arquivo JSONL inteiro de sessão e retorna o agregado.
/// Linhas malformadas são puladas com warn.
pub fn parse_session_file(path: &Path) -> Result<ClaudeSession, String> {
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("invalid session filename: {:?}", path))?
        .to_string();

    let file = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(file);

    let mut session = ClaudeSession {
        session_id,
        project_path: String::new(),
        git_branch: None,
        title: None,
        model: None,
        started_at: i64::MAX,
        last_activity: 0,
        message_count: 0,
        duration_ms: 0,
        usage: AggregatedUsage::default(),
    };

    let mut seen_message_ids: HashSet<String> = HashSet::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };

        let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

        // Timestamps
        if let Some(ts_str) = value.get("timestamp").and_then(|t| t.as_str()) {
            if let Some(ts_ms) = parse_iso_to_unix_ms(ts_str) {
                if ts_ms < session.started_at {
                    session.started_at = ts_ms;
                }
                if ts_ms > session.last_activity {
                    session.last_activity = ts_ms;
                }
            }
        }

        // cwd
        if session.project_path.is_empty() {
            if let Some(cwd) = value.get("cwd").and_then(|c| c.as_str()) {
                session.project_path = cwd.to_string();
            }
        }

        // gitBranch
        if session.git_branch.is_none() {
            if let Some(b) = value.get("gitBranch").and_then(|b| b.as_str()) {
                session.git_branch = Some(b.to_string());
            }
        }

        // duração — soma só durationMs em assistant events
        if event_type == "assistant" {
            if let Some(d) = value.get("durationMs").and_then(|d| d.as_u64()) {
                session.duration_ms += d;
            }
            // model
            if let Some(m) = value
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
            {
                session.model = Some(m.to_string());
            }
            // usage — dedup por messageId
            let msg_id = value
                .get("message")
                .and_then(|m| m.get("id"))
                .and_then(|m| m.as_str());
            let dedup_key = msg_id
                .map(|s| s.to_string())
                .or_else(|| {
                    value
                        .get("uuid")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                });
            let already_counted = dedup_key
                .as_ref()
                .map(|k| !seen_message_ids.insert(k.clone()))
                .unwrap_or(false);
            if !already_counted {
                if let Some(usage) = value.get("message").and_then(|m| m.get("usage")) {
                    session.usage.input_tokens +=
                        usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    session.usage.cache_creation_input_tokens += usage
                        .get("cache_creation_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    session.usage.cache_read_input_tokens += usage
                        .get("cache_read_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    session.usage.output_tokens +=
                        usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                }
            }
        }

        // contagem de msgs
        if event_type == "user" || event_type == "assistant" {
            session.message_count += 1;
        }

        // título
        if event_type == "ai-title" {
            if let Some(t) = value.get("aiTitle").and_then(|t| t.as_str()) {
                session.title = Some(t.to_string());
            }
        }
    }

    if session.started_at == i64::MAX {
        session.started_at = 0;
    }

    Ok(session)
}
```

- [ ] **Step 4: Rodar testes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -15
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude.rs
git commit -m "feat(claude): parser JSONL line-by-line com dedup por messageId"
```

---

### Task A4: Scan completo de `~/.claude/projects/`

**Files:**
- Modify: `src-tauri/src/claude.rs` (anexar)

- [ ] **Step 1: Escrever teste smoke (não-determinístico — só roda em dev box)**

Anexar ao `mod tests`:

```rust
    #[test]
    #[ignore]  // só roda manualmente — depende de ~/.claude/projects/ existir
    fn snapshot_real_dir_returns_data() {
        let states = snapshot();
        assert!(!states.is_empty(), "esperava ao menos 1 projeto com sessões");
        for state in &states {
            assert!(!state.project_path.is_empty());
            for session in &state.sessions {
                assert!(!session.session_id.is_empty());
            }
        }
    }
```

- [ ] **Step 2: Implementar scanner**

Anexar ao `claude.rs`:

```rust
use std::fs;

pub fn claude_projects_root() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".claude").join("projects"))
        .unwrap_or_else(|| std::path::PathBuf::from("./.claude/projects"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Scan completo: lê todas as pastas de projeto em ~/.claude/projects/, todos os JSONL,
/// agrega por project_path canônico (vindo do `cwd`).
pub fn snapshot() -> Vec<ClaudeProjectState> {
    let root = claude_projects_root();
    let Ok(project_dirs) = fs::read_dir(&root) else {
        return vec![];
    };

    use std::collections::HashMap;
    let mut by_path: HashMap<String, ClaudeProjectState> = HashMap::new();

    for entry in project_dirs.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let Ok(files) = fs::read_dir(&dir) else { continue };
        for file_entry in files.filter_map(|e| e.ok()) {
            let path = file_entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(session) = parse_session_file(&path) else { continue };
            if session.project_path.is_empty() {
                continue;  // sessão órfã sem cwd, ignora
            }
            let state = by_path
                .entry(session.project_path.clone())
                .or_insert_with(|| ClaudeProjectState {
                    project_path: session.project_path.clone(),
                    sessions: Vec::new(),
                    active_session_id: None,
                    total_usage: AggregatedUsage::default(),
                });
            state.total_usage.add(&session.usage);
            state.sessions.push(session);
        }
    }

    let now = now_ms();
    let mut out: Vec<ClaudeProjectState> = by_path.into_values().collect();
    for state in &mut out {
        state.sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        state.active_session_id = state
            .sessions
            .iter()
            .find(|s| is_active(s.last_activity, now))
            .map(|s| s.session_id.clone());
    }
    out.sort_by(|a, b| a.project_path.cmp(&b.project_path));
    out
}
```

- [ ] **Step 3: Rodar smoke test (manual)**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude::tests::snapshot_real_dir_returns_data -- --ignored --nocapture 2>&1 | tail -10
```

Expected: passa, lê dados reais.

- [ ] **Step 4: Rodar suite normal — não pode quebrar**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -5
```

Expected: 9 passing (smoke ignorado).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude.rs
git commit -m "feat(claude): snapshot() agrega todas as sessões em ClaudeProjectState ordenadas"
```

---

### Task A5: Agregação por bucket de tempo (chart data)

**Files:**
- Modify: `src-tauri/src/claude.rs` (anexar)

**Conceito Rust pra contexto:** `chrono::DateTime` é o equivalente do `Date` do TS. `with_day(1)` zera o dia (vira início do mês), `with_month(1).with_day(1)` zera pra início do ano.

- [ ] **Step 1: Escrever testes**

Anexar ao `mod tests`:

```rust
    fn make_session(last_activity_iso: &str, input: u64) -> ClaudeSession {
        let ts = parse_iso_to_unix_ms(last_activity_iso).unwrap();
        ClaudeSession {
            session_id: "x".into(),
            project_path: "/p".into(),
            git_branch: None,
            title: None,
            model: None,
            started_at: ts,
            last_activity: ts,
            message_count: 1,
            duration_ms: 0,
            usage: AggregatedUsage {
                input_tokens: input,
                ..Default::default()
            },
        }
    }

    #[test]
    fn aggregate_day_buckets_by_calendar_day() {
        let sessions = vec![
            make_session("2026-05-01T10:00:00Z", 100),
            make_session("2026-05-01T22:00:00Z", 200),
            make_session("2026-05-02T05:00:00Z", 50),
        ];
        let buckets = aggregate_buckets(&sessions, Granularity::Day);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].usage.input_tokens, 300);  // 01/05
        assert_eq!(buckets[1].usage.input_tokens, 50);   // 02/05
    }

    #[test]
    fn aggregate_month_buckets() {
        let sessions = vec![
            make_session("2026-04-15T10:00:00Z", 100),
            make_session("2026-05-01T10:00:00Z", 200),
            make_session("2026-05-30T10:00:00Z", 300),
        ];
        let buckets = aggregate_buckets(&sessions, Granularity::Month);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].usage.input_tokens, 100);  // abril
        assert_eq!(buckets[1].usage.input_tokens, 500);  // maio
    }

    #[test]
    fn aggregate_year_buckets() {
        let sessions = vec![
            make_session("2025-12-31T10:00:00Z", 100),
            make_session("2026-01-01T10:00:00Z", 200),
        ];
        let buckets = aggregate_buckets(&sessions, Granularity::Year);
        assert_eq!(buckets.len(), 2);
    }

    #[test]
    fn aggregate_empty_returns_empty() {
        let buckets = aggregate_buckets(&[], Granularity::Day);
        assert!(buckets.is_empty());
    }
```

- [ ] **Step 2: Rodar — devem falhar**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude::tests::aggregate 2>&1 | tail -5
```

Expected: `cannot find function aggregate_buckets`.

- [ ] **Step 3: Implementar agregação**

Anexar:

```rust
use chrono::{Datelike, TimeZone, Utc};

fn truncate_to_bucket(ts_ms: i64, granularity: Granularity) -> i64 {
    let dt = Utc.timestamp_millis_opt(ts_ms).single().unwrap_or(Utc.timestamp_opt(0, 0).unwrap());
    let truncated = match granularity {
        Granularity::Day => dt
            .with_hour(0).unwrap()
            .with_minute(0).unwrap()
            .with_second(0).unwrap()
            .with_nanosecond(0).unwrap(),
        Granularity::Month => dt
            .with_day(1).unwrap()
            .with_hour(0).unwrap()
            .with_minute(0).unwrap()
            .with_second(0).unwrap()
            .with_nanosecond(0).unwrap(),
        Granularity::Year => dt
            .with_month(1).unwrap()
            .with_day(1).unwrap()
            .with_hour(0).unwrap()
            .with_minute(0).unwrap()
            .with_second(0).unwrap()
            .with_nanosecond(0).unwrap(),
    };
    truncated.timestamp_millis()
}

pub fn aggregate_buckets(sessions: &[ClaudeSession], granularity: Granularity) -> Vec<TokenBucket> {
    use std::collections::BTreeMap;
    let mut by_bucket: BTreeMap<i64, AggregatedUsage> = BTreeMap::new();
    for s in sessions {
        let bucket = truncate_to_bucket(s.last_activity, granularity);
        by_bucket
            .entry(bucket)
            .or_default()
            .add(&s.usage);
    }
    by_bucket
        .into_iter()
        .map(|(bucket_start, usage)| TokenBucket { bucket_start, usage })
        .collect()
}
```

Substituir o `use chrono::DateTime;` adicionado em A3 pelo bloco completo:

```rust
use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc};
```

(Datelike fornece `with_day`/`with_month`; Timelike fornece `with_hour`/`with_minute`/etc; TimeZone fornece `Utc.timestamp_*`.)

- [ ] **Step 4: Rodar testes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml claude:: 2>&1 | tail -10
```

Expected: 13 passing.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/claude.rs
git commit -m "feat(claude): aggregate_buckets por dia/mês/ano via chrono truncation"
```

---

### Task A6: Watcher (notify recursivo + fallback poll)

**Files:**
- Modify: `src-tauri/src/claude.rs` (anexar)

**Conceito Rust pra contexto:** `Arc<Mutex<T>>` é a forma canônica de compartilhar estado mutável entre threads — `Arc` é um ref-count, `Mutex` é um lock. `tokio::sync::watch` é um broadcast channel com último valor mantido.

- [ ] **Step 1: Implementar estado compartilhado + watcher**

Anexar ao `claude.rs`:

```rust
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

pub struct ClaudeState {
    pub projects: Mutex<Vec<ClaudeProjectState>>,
}

impl ClaudeState {
    pub fn new() -> Self {
        Self {
            projects: Mutex::new(Vec::new()),
        }
    }
}

fn snapshot_signature(states: &[ClaudeProjectState]) -> Vec<(String, Option<String>, u64)> {
    states
        .iter()
        .map(|s| {
            (
                s.project_path.clone(),
                s.active_session_id.clone(),
                s.total_usage.total_tokens(),
            )
        })
        .collect()
}

/// Refresca state, emite `claude-state` se houve diff.
pub fn refresh_and_emit(app: &AppHandle, state: &Arc<ClaudeState>) {
    let new_snapshot = snapshot();
    let mut guard = state.projects.lock().unwrap();
    let old_sig = snapshot_signature(&guard);
    let new_sig = snapshot_signature(&new_snapshot);
    if old_sig != new_sig {
        *guard = new_snapshot.clone();
        drop(guard);
        let _ = app.emit("claude-state", &new_snapshot);
    }
}

/// Inicia watcher (notify) + fallback poll. Não bloqueia.
pub fn start_watcher(app: AppHandle, state: Arc<ClaudeState>) {
    use notify::{RecursiveMode, Watcher};
    use std::time::Duration;

    let root = claude_projects_root();
    if !root.exists() {
        return;
    }

    // boot inicial
    refresh_and_emit(&app, &state);

    // notify watcher
    let app_for_notify = app.clone();
    let state_for_notify = state.clone();
    let _watcher_thread = std::thread::spawn(move || {
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[claude] watcher init failed: {e}; relying on poll only");
                return;
            }
        };
        if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
            eprintln!("[claude] watch failed: {e}; relying on poll only");
            return;
        }
        // debounce: agrupa eventos rápidos (Claude escreve várias linhas em rajada)
        loop {
            match rx.recv_timeout(Duration::from_millis(500)) {
                Ok(Ok(_event)) => {
                    // drena fila
                    while rx.try_recv().is_ok() {}
                    refresh_and_emit(&app_for_notify, &state_for_notify);
                }
                Ok(Err(_)) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            }
        }
    });

    // fallback poll a cada 30s — defensivo
    let app_for_poll = app;
    let state_for_poll = state;
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.tick().await; // pula primeiro tick (boot já fez)
        loop {
            interval.tick().await;
            refresh_and_emit(&app_for_poll, &state_for_poll);
        }
    });
}
```

- [ ] **Step 2: Build e checar**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --quiet 2>&1 | tail -10
```

Expected: build sem erros.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/claude.rs
git commit -m "feat(claude): watcher híbrido (notify recursivo + fallback poll 30s) com diff emit"
```

---

### Task A7: Comandos Tauri + integração em `lib.rs`

**Files:**
- Modify: `src-tauri/src/claude.rs` (anexar)
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Comandos Tauri em `claude.rs`**

Anexar:

```rust
#[tauri::command]
pub fn claude_snapshot(state: tauri::State<'_, Arc<ClaudeState>>) -> Vec<ClaudeProjectState> {
    state.projects.lock().unwrap().clone()
}

#[tauri::command]
pub fn list_claude_sessions(
    state: tauri::State<'_, Arc<ClaudeState>>,
    project_path: String,
) -> Vec<ClaudeSession> {
    state
        .projects
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.project_path == project_path)
        .map(|s| s.sessions.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn aggregate_tokens(
    state: tauri::State<'_, Arc<ClaudeState>>,
    project_path: String,
    granularity: Granularity,
) -> Vec<TokenBucket> {
    let sessions = state
        .projects
        .lock()
        .unwrap()
        .iter()
        .find(|s| s.project_path == project_path)
        .map(|s| s.sessions.clone())
        .unwrap_or_default();
    aggregate_buckets(&sessions, granularity)
}
```

- [ ] **Step 2: Wire em `lib.rs`**

Em `src-tauri/src/lib.rs`, **adicionar imports no topo** (já tem `use tauri::Emitter;`):

```rust
use std::sync::Arc;
use claude::ClaudeState;
```

**Adicionar `.manage()` no Builder** (depois do `.manage(ProcessState::new())`):

```rust
        .manage(Arc::new(ClaudeState::new()))
```

**Adicionar comandos no `invoke_handler!`** (após `netstat::list_system_ports`):

```rust
            claude::claude_snapshot,
            claude::list_claude_sessions,
            claude::aggregate_tokens,
```

**Adicionar startup do watcher dentro do `.setup(|app| {...})`** (dentro do bloco existente, antes do `Ok(())`):

```rust
            // Claude awareness watcher
            let claude_handle = app.handle().clone();
            let claude_state = app.state::<Arc<ClaudeState>>().inner().clone();
            claude::start_watcher(claude_handle, claude_state);
```

- [ ] **Step 3: Build**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --quiet 2>&1 | tail -10
```

Expected: build limpo.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/claude.rs src-tauri/src/lib.rs
git commit -m "feat(claude): comandos Tauri (snapshot/list/aggregate) + watcher startup em lib.rs"
```

---

### Task A8: `spawn_claude` em external.rs

**Files:**
- Modify: `src-tauri/src/external.rs:21-46` (após open_in_files)
- Modify: `src-tauri/src/lib.rs` (registrar)

- [ ] **Step 1: Implementar `spawn_claude`**

No fim de `src-tauri/src/external.rs`, antes do `kill_pid`:

```rust
#[tauri::command]
pub fn spawn_claude(path: String) -> Result<(), String> {
    let p = validate_path(&path)?;
    let mut cmd = Command::new("ghostty");
    cmd.arg(format!("--working-directory={}", p.display()))
        .arg("-e")
        .arg("claude");
    spawn_detached(&mut cmd).map_err(|e| format!("falha ao spawnar Claude: {}", e))
}
```

- [ ] **Step 2: Registrar no `lib.rs` invoke_handler**

Após `external::open_in_files,`:

```rust
            external::spawn_claude,
```

- [ ] **Step 3: Build**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --quiet 2>&1 | tail -5
```

Expected: limpo.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/external.rs src-tauri/src/lib.rs
git commit -m "feat(external): comando spawn_claude (ghostty -e claude no diretório do projeto)"
```

---

## Phase 2 — Agent B (Frontend cards)

> **Briefing pra o agente:** Você adiciona o chip "Claude" e botão "Spawn Claude" nos cards (grid e list). Os tipos TS espelham os tipos Rust de Phase 1. Componente novo `ClaudeChip` é compartilhado entre `ProjectCard` e `ProjectListItem`. Use os tokens `--color-claude-primary` / `--color-claude-soft` já adicionados em Phase 0.

### Task B1: Tipos TS espelhando Rust

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Adicionar tipos no fim do arquivo**

```typescript
export type AggregatedUsage = {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
};

export type ClaudeSession = {
  session_id: string;
  project_path: string;
  git_branch: string | null;
  title: string | null;
  model: string | null;
  started_at: number;       // unix ms
  last_activity: number;    // unix ms
  message_count: number;
  duration_ms: number;
  usage: AggregatedUsage;
};

export type ClaudeProjectState = {
  project_path: string;
  sessions: ClaudeSession[];
  active_session_id: string | null;
  total_usage: AggregatedUsage;
};

export type Granularity = "day" | "month" | "year";

export type TokenBucket = {
  bucket_start: number;     // unix ms
  usage: AggregatedUsage;
};
```

- [ ] **Step 2: Validar TS**

```bash
pnpm exec tsc --noEmit
```

Expected: zero erros.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): tipos Claude (Session, ProjectState, Granularity, TokenBucket, AggregatedUsage)"
```

---

### Task B2: Pricing helper TS pro display de cost

**Files:**
- Create: `src/lib/claudeCost.ts`

- [ ] **Step 1: Criar arquivo**

```typescript
// src/lib/claudeCost.ts
import type { AggregatedUsage } from "../types";

type ModelPricing = {
  input_per_1m: number;
  cache_create_per_1m: number;
  cache_read_per_1m: number;
  output_per_1m: number;
};

const PRICING: Array<[string, ModelPricing]> = [
  ["claude-opus-4-7", { input_per_1m: 15, cache_create_per_1m: 18.75, cache_read_per_1m: 1.5, output_per_1m: 75 }],
  ["claude-sonnet-4-6", { input_per_1m: 3, cache_create_per_1m: 3.75, cache_read_per_1m: 0.3, output_per_1m: 15 }],
  ["claude-haiku-4-5", { input_per_1m: 0.8, cache_create_per_1m: 1, cache_read_per_1m: 0.08, output_per_1m: 4 }],
];

const FALLBACK: ModelPricing = { input_per_1m: 3, cache_create_per_1m: 3.75, cache_read_per_1m: 0.3, output_per_1m: 15 };

export function pricingFor(model: string | null | undefined): ModelPricing {
  if (!model) return FALLBACK;
  const match = PRICING.find(([key]) => model.startsWith(key));
  return match ? match[1] : FALLBACK;
}

export function costUsd(usage: AggregatedUsage, model: string | null | undefined): number {
  const p = pricingFor(model);
  return (
    (usage.input_tokens * p.input_per_1m +
      usage.cache_creation_input_tokens * p.cache_create_per_1m +
      usage.cache_read_input_tokens * p.cache_read_per_1m +
      usage.output_tokens * p.output_per_1m) /
    1_000_000
  );
}

export function totalTokens(usage: AggregatedUsage): number {
  return (
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens +
    usage.output_tokens
  );
}

export function humanizeTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return "—";
  return `$${usd.toFixed(2)}`;
}
```

- [ ] **Step 2: Validar TS**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/lib/claudeCost.ts
git commit -m "feat(claude): helpers TS pra cost calc + humanização de tokens (espelha Rust)"
```

---

### Task B3: `ClaudeChip` component

**Files:**
- Create: `src/components/ClaudeChip.tsx`

- [ ] **Step 1: Criar componente**

```tsx
// src/components/ClaudeChip.tsx
import { motion } from "framer-motion";
import clsx from "clsx";
import type { ClaudeProjectState } from "../types";
import { humanizeTokens, totalTokens } from "../lib/claudeCost";

const TOKEN_THRESHOLD = 100_000;

type Props = {
  state: ClaudeProjectState | null;
  now: number;
};

function formatRelative(ms: number, now: number): string {
  const diff = now - ms;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function ClaudeChip({ state, now }: Props) {
  if (!state || state.sessions.length === 0) return null;
  const isActive = state.active_session_id !== null;
  const tokens = totalTokens(state.total_usage);
  const showTokens = tokens >= TOKEN_THRESHOLD;
  const lastTs = state.sessions[0]?.last_activity ?? 0;
  const sessionCount = state.sessions.length;

  return (
    <span
      className={clsx(
        "flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ring-1",
        isActive
          ? "bg-[var(--color-claude-soft)] text-[var(--color-claude-primary)] ring-[var(--color-claude-primary)]/40"
          : "bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] ring-[var(--color-border-default)]",
      )}
      title={`${sessionCount} sessões · ${humanizeTokens(tokens)} tokens`}
    >
      <motion.span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: isActive ? "var(--color-claude-primary)" : "var(--color-text-muted)",
        }}
        animate={isActive ? { opacity: [1, 0.4, 1] } : { opacity: 1 }}
        transition={isActive ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      <span>claude</span>
      <span className="text-[var(--color-text-muted)]">·</span>
      {isActive ? (
        <span className="normal-case text-[var(--color-claude-primary)]">
          {formatRelative(lastTs, now)}
        </span>
      ) : (
        <span className="normal-case text-[var(--color-text-secondary)]">
          {sessionCount} {sessionCount === 1 ? "sessão" : "sessões"}
        </span>
      )}
      {showTokens && (
        <>
          <span className="text-[var(--color-text-muted)]">·</span>
          <span className="normal-case text-[var(--color-text-secondary)]">
            {humanizeTokens(tokens)}
          </span>
        </>
      )}
    </span>
  );
}
```

- [ ] **Step 2: Validar TS**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/components/ClaudeChip.tsx
git commit -m "feat(ui): ClaudeChip component (estados ativo/histórico, threshold de tokens)"
```

---

### Task B4: `SpawnClaudeButton` component

**Files:**
- Create: `src/components/SpawnClaudeButton.tsx`

- [ ] **Step 1: Criar componente**

```tsx
// src/components/SpawnClaudeButton.tsx
import { invoke } from "@tauri-apps/api/core";

type Props = {
  path: string;
};

export function SpawnClaudeButton({ path }: Props) {
  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      await invoke("spawn_claude", { path });
    } catch (err) {
      console.error("spawn_claude:", err);
    }
  }
  return (
    <button
      onClick={handleClick}
      title="abrir Claude Code aqui"
      aria-label="abrir Claude Code aqui"
      className="rounded-md p-1.5 transition hover:bg-[var(--color-bg-primary)]"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-[var(--color-claude-primary)]"
      >
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
        <circle cx="20" cy="5" r="1.5" fill="currentColor" />
      </svg>
    </button>
  );
}
```

- [ ] **Step 2: Validar TS**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/components/SpawnClaudeButton.tsx
git commit -m "feat(ui): SpawnClaudeButton (terminal+sparkle) chama comando Tauri"
```

---

### Task B5: Integrar `ClaudeChip` + `SpawnClaudeButton` em `ProjectCard`

**Files:**
- Modify: `src/components/ProjectCard.tsx`

- [ ] **Step 1: Adicionar prop e imports**

No topo de `ProjectCard.tsx`, adicionar imports:

```tsx
import { ClaudeChip } from "./ClaudeChip";
import { SpawnClaudeButton } from "./SpawnClaudeButton";
import type { ClaudeProjectState } from "../types";
```

Em `type Props = {...}` adicionar:

```tsx
  claudeState?: ClaudeProjectState | null;
  now?: number;
```

Em `export function ProjectCard({...}: Props) {` desestruturar:

```tsx
  claudeState = null,
  now = Date.now(),
```

- [ ] **Step 2: Renderizar `<ClaudeChip>` ao lado do chip de script**

Localizar bloco que renderiza chip do package_manager (`<span ... bg-[var(--color-accent-soft)] ...>`). Logo após esse `<span>`, adicionar:

```tsx
          <ClaudeChip state={claudeState} now={now} />
```

- [ ] **Step 3: Renderizar `<SpawnClaudeButton>` na linha de actions**

Localizar a linha com os botões `handleOpenFiles` (botão Files). Logo após esse `<button>`, antes do botão Run/Stop:

```tsx
          <SpawnClaudeButton path={project.path} />
```

- [ ] **Step 4: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 5: Commit**

```bash
git add src/components/ProjectCard.tsx
git commit -m "feat(card): renderiza ClaudeChip + SpawnClaudeButton no grid card"
```

---

### Task B6: Mesma integração em `ProjectListItem`

**Files:**
- Modify: `src/components/ProjectListItem.tsx`

- [ ] **Step 1: Imports + props**

Adicionar imports + props (mesmas mudanças que B5).

- [ ] **Step 2: Renderizar chip e botão**

Após o chip da branch (`{(worktree || monorepo) && (...)}`), adicionar `<ClaudeChip state={claudeState} now={now} />` na mesma linha de chips.

Após o botão Files (Nautilus), antes do botão Run, adicionar `<SpawnClaudeButton path={project.path} />`.

- [ ] **Step 3: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 4: Commit**

```bash
git add src/components/ProjectListItem.tsx
git commit -m "feat(card): renderiza ClaudeChip + SpawnClaudeButton no list item"
```

---

### Task B7: State + listener em `App.tsx`

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Imports**

Adicionar:

```tsx
import type { ClaudeProjectState } from "./types";
```

- [ ] **Step 2: State**

Após `const [systemPorts, setSystemPorts] = ...`:

```tsx
  const [claudeStates, setClaudeStates] = useState<ClaudeProjectState[]>([]);
  const [now, setNow] = useState(() => Date.now());
```

- [ ] **Step 3: Snapshot inicial + listener**

No bloco `useEffect(() => {...}, [])` que invoca `running_ids`, adicionar após o invoke do `list_system_ports`:

```tsx
    invoke<ClaudeProjectState[]>("claude_snapshot")
      .then(setClaudeStates)
      .catch(() => {});
```

No `useEffect` dos listeners (após `unlistenSystem`):

```tsx
    const unlistenClaude = listen<ClaudeProjectState[]>(
      "claude-state",
      (event) => {
        setClaudeStates(event.payload);
      },
    );
```

E no return de cleanup adicionar `unlistenClaude.then((fn) => fn());`.

- [ ] **Step 4: Tick de `now` pro chip pulsante (atualiza relativo a cada 30s)**

Adicionar useEffect novo:

```tsx
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);
```

- [ ] **Step 5: Mapeamento por path**

Após o `externalByProject` useMemo, adicionar:

```tsx
  const claudeByProjectPath = useMemo(() => {
    const map: Record<string, ClaudeProjectState> = {};
    for (const s of claudeStates) {
      map[s.project_path] = s;
    }
    return map;
  }, [claudeStates]);
```

- [ ] **Step 6: Passar pra Card e ListItem**

No render do grid/list, dentro do `propsCommon`:

```tsx
                    claudeState: claudeByProjectPath[p.path] ?? null,
                    now,
```

- [ ] **Step 7: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 8: Commit**

```bash
git add src/App.tsx
git commit -m "feat(app): state Claude + listener claude-state + tick de now pra chip relativo"
```

---

## Phase 3 — Agent C (Drawer + chart)

> **Briefing pra o agente:** Você refator o `LogsDrawer` em `ProjectDetailDrawer` com tabs `[Logs][Claude]`. Tab Claude monta `<TokensChart>` (Recharts LineChart) e `<SessionsList>`. Use tokens indigo Claude. Tabs persistem em localStorage por projeto.

### Task C1: Instalar Recharts

**Files:**
- Modify: `package.json` (auto via pnpm)

- [ ] **Step 1: Instalar**

```bash
pnpm add recharts@2
```

Expected: package.json + lockfile atualizam.

- [ ] **Step 2: Validar TS continua OK**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build: adicionar recharts pro chart de tokens"
```

---

### Task C2: Componente `<Tabs>` primitivo

**Files:**
- Create: `src/components/Tabs.tsx`

- [ ] **Step 1: Criar componente**

```tsx
// src/components/Tabs.tsx
import { motion } from "framer-motion";
import clsx from "clsx";

export type Tab = {
  key: string;
  label: string;
};

type Props = {
  tabs: Tab[];
  active: string;
  onChange: (key: string) => void;
};

export function Tabs({ tabs, active, onChange }: Props) {
  return (
    <div className="relative flex gap-1 border-b border-[var(--color-border-subtle)] px-3">
      {tabs.map((tab) => {
        const isActive = tab.key === active;
        return (
          <button
            key={tab.key}
            onClick={() => onChange(tab.key)}
            className={clsx(
              "relative px-3 py-2 text-xs font-semibold transition",
              isActive
                ? "text-[var(--color-text-primary)]"
                : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
            )}
          >
            {tab.label}
            {isActive && (
              <motion.div
                layoutId="tabs-underline"
                className="absolute bottom-[-1px] left-2 right-2 h-[2px] bg-[var(--color-accent-primary)]"
                transition={{ type: "spring", stiffness: 380, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TS check**

```bash
pnpm exec tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Tabs.tsx
git commit -m "feat(ui): componente Tabs com underline animado via framer layoutId"
```

---

### Task C3: `SessionsList` component

**Files:**
- Create: `src/components/SessionsList.tsx`

- [ ] **Step 1: Criar**

```tsx
// src/components/SessionsList.tsx
import clsx from "clsx";
import type { ClaudeSession } from "../types";
import { costUsd, formatCost, humanizeTokens, totalTokens } from "../lib/claudeCost";

type Props = {
  sessions: ClaudeSession[];
  activeSessionId: string | null;
};

function formatDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}

export function SessionsList({ sessions, activeSessionId }: Props) {
  if (sessions.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-[var(--color-border-default)] py-8 text-center text-xs text-[var(--color-text-muted)]">
        nenhuma sessão Claude ainda neste projeto
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {sessions.map((s) => {
        const isActive = s.session_id === activeSessionId;
        const tokens = totalTokens(s.usage);
        const cost = costUsd(s.usage, s.model);
        return (
          <div
            key={s.session_id}
            className="border-b border-[var(--color-border-subtle)] py-2 last:border-b-0"
          >
            <div className="flex items-baseline gap-2">
              <span
                className={clsx(
                  "mt-1 h-2 w-2 shrink-0 rounded-full",
                  isActive
                    ? "bg-[var(--color-claude-primary)] shadow-[0_0_6px_var(--color-claude-primary)]"
                    : "border border-[var(--color-text-muted)] bg-transparent",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-[var(--color-text-primary)]">
                  {s.title ?? "(sessão sem título)"}
                </div>
                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                  {formatDate(s.last_activity)}
                  {s.model && ` · ${s.model.replace(/^claude-/, "")}`}
                  {tokens > 0 && ` · ${humanizeTokens(tokens)}`}
                  {cost >= 0.01 && (
                    <>
                      {" "}
                      <span className="text-[var(--color-text-secondary)]">≡</span>{" "}
                      {formatCost(cost)}
                    </>
                  )}
                  {s.duration_ms > 0 && ` · ${formatDuration(s.duration_ms)}`}
                  {s.git_branch && (
                    <span className="ml-1 normal-case text-[var(--color-text-secondary)]">
                      · {s.git_branch.replace(/^worktree-/, "")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/components/SessionsList.tsx
git commit -m "feat(ui): SessionsList — bullet ativo/passada + meta mono compacta"
```

---

### Task C4: `TokensChart` component

**Files:**
- Create: `src/components/TokensChart.tsx`

- [ ] **Step 1: Criar**

```tsx
// src/components/TokensChart.tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Granularity, TokenBucket } from "../types";
import { costUsd, formatCost, humanizeTokens, totalTokens } from "../lib/claudeCost";

type Props = {
  projectPath: string;
  model: string | null;
  granularity: Granularity;
};

function formatBucketLabel(ms: number, granularity: Granularity): string {
  const d = new Date(ms);
  if (granularity === "year") return String(d.getFullYear());
  if (granularity === "month") {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${m}/${String(d.getFullYear()).slice(2)}`;
  }
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function TokensChart({ projectPath, model, granularity }: Props) {
  const [buckets, setBuckets] = useState<TokenBucket[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    invoke<TokenBucket[]>("aggregate_tokens", {
      projectPath,
      granularity,
    })
      .then((data) => {
        setBuckets(data);
        setLoading(false);
      })
      .catch((err) => {
        console.error("aggregate_tokens:", err);
        setLoading(false);
      });
  }, [projectPath, granularity]);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-[var(--color-text-muted)]">
        carregando…
      </div>
    );
  }

  if (buckets.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-xs text-[var(--color-text-muted)]">
        sem dados nesse período
      </div>
    );
  }

  const data = buckets.map((b) => ({
    label: formatBucketLabel(b.bucket_start, granularity),
    tokens: totalTokens(b.usage),
    cost: costUsd(b.usage, model),
    raw: b,
  }));

  return (
    <div className="h-48">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-border-subtle)" strokeDasharray="3 3" />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
            stroke="var(--color-border-default)"
          />
          <YAxis
            tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
            stroke="var(--color-border-default)"
            tickFormatter={(v) => humanizeTokens(v as number)}
            width={48}
          />
          <Tooltip
            contentStyle={{
              background: "var(--color-bg-secondary)",
              border: "1px solid var(--color-border-default)",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelStyle={{ color: "var(--color-text-secondary)" }}
            formatter={(value: number, _name, item) => {
              const cost = (item.payload as { cost: number }).cost;
              return [
                `${humanizeTokens(value)} ≡ ${formatCost(cost)}`,
                "tokens",
              ];
            }}
          />
          <Line
            type="monotone"
            dataKey="tokens"
            stroke="var(--color-claude-primary)"
            strokeWidth={2}
            dot={{ fill: "var(--color-claude-primary)", r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
```

- [ ] **Step 2: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/components/TokensChart.tsx
git commit -m "feat(ui): TokensChart Recharts com fetch de aggregate_tokens, tooltip cost"
```

---

### Task C5: `ClaudeTab` orquestrador

**Files:**
- Create: `src/components/ClaudeTab.tsx`

- [ ] **Step 1: Criar**

```tsx
// src/components/ClaudeTab.tsx
import { useState } from "react";
import clsx from "clsx";
import type { ClaudeProjectState, Granularity } from "../types";
import { costUsd, formatCost, humanizeTokens, totalTokens } from "../lib/claudeCost";
import { SessionsList } from "./SessionsList";
import { TokensChart } from "./TokensChart";

type Props = {
  state: ClaudeProjectState | null;
  projectPath: string;
};

const GRANULARITIES: Array<{ key: Granularity; label: string }> = [
  { key: "day", label: "Dia" },
  { key: "month", label: "Mês" },
  { key: "year", label: "Ano" },
];

export function ClaudeTab({ state, projectPath }: Props) {
  const [granularity, setGranularity] = useState<Granularity>("day");

  if (!state || state.sessions.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-xs text-[var(--color-text-muted)]">
        nenhuma sessão Claude registrada neste projeto.
        <br />
        clique no botão de spawn pra começar uma.
      </div>
    );
  }

  const totalT = totalTokens(state.total_usage);
  const dominantModel = state.sessions[0]?.model ?? null;
  const totalCost = state.sessions.reduce(
    (acc, s) => acc + costUsd(s.usage, s.model),
    0,
  );

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="px-4 py-3">
        <div className="font-mono text-[11px] text-[var(--color-text-secondary)]">
          {state.sessions.length} {state.sessions.length === 1 ? "sessão" : "sessões"}
          {" · "}
          {humanizeTokens(totalT)} tokens
          {totalCost >= 0.01 && (
            <>
              {" · "}
              <span className="text-[var(--color-text-muted)]">≡</span> {formatCost(totalCost)}
            </>
          )}
        </div>
      </div>

      <div className="px-4 pb-2">
        <div className="inline-flex overflow-hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
          {GRANULARITIES.map((g) => (
            <button
              key={g.key}
              onClick={() => setGranularity(g.key)}
              className={clsx(
                "px-3 py-1 text-[11px] font-semibold transition",
                granularity === g.key
                  ? "bg-[var(--color-claude-primary)] text-white"
                  : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 pb-4">
        <TokensChart
          projectPath={projectPath}
          model={dominantModel}
          granularity={granularity}
        />
      </div>

      <div className="border-t border-[var(--color-border-subtle)] px-4 py-3">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          sessões
        </div>
        <SessionsList sessions={state.sessions} activeSessionId={state.active_session_id} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 3: Commit**

```bash
git add src/components/ClaudeTab.tsx
git commit -m "feat(ui): ClaudeTab orquestra summary + granularity toggle + chart + sessions list"
```

---

### Task C6: Refator `LogsDrawer` → `ProjectDetailDrawer`

**Files:**
- Read: `src/components/LogsDrawer.tsx`
- Create: `src/components/ProjectDetailDrawer.tsx`
- Delete: `src/components/LogsDrawer.tsx`
- Modify: `src/App.tsx` (substituir import + uso)

- [ ] **Step 1: Ler conteúdo atual de `LogsDrawer.tsx`**

```bash
cat src/components/LogsDrawer.tsx
```

Capturar todo o conteúdo (component fn, props, layout).

- [ ] **Step 2: Criar `ProjectDetailDrawer.tsx`**

Estrutura: shell idêntica ao LogsDrawer (header com nome + path + porta + close button), mas com `<Tabs>` abaixo do header e conteúdo condicional.

```tsx
// src/components/ProjectDetailDrawer.tsx
import { useEffect, useState } from "react";
import { Tabs } from "./Tabs";
import { ClaudeTab } from "./ClaudeTab";
import type { ClaudeProjectState, LogLine, Project, ProjectStatus } from "../types";
// ... reaproveitar imports do LogsDrawer original

type Props = {
  project: Project;
  status: ProjectStatus;
  port?: number;
  logs: LogLine[];
  claudeState: ClaudeProjectState | null;
  onClose: () => void;
  onClear: () => void;
};

const TAB_KEY = (id: string) => `falcao-launcher.drawerTab.${id}`;

export function ProjectDetailDrawer(props: Props) {
  const { project, claudeState } = props;
  const [activeTab, setActiveTab] = useState<string>(() => {
    return localStorage.getItem(TAB_KEY(project.id)) ?? "logs";
  });

  useEffect(() => {
    localStorage.setItem(TAB_KEY(project.id), activeTab);
  }, [project.id, activeTab]);

  // CONTEÚDO DO DRAWER (porte do LogsDrawer): header com nome + path + porta + close
  // ... (copiar header markup do LogsDrawer atual)

  return (
    <aside className="fixed right-0 top-0 z-30 flex h-screen w-[480px] flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-secondary)]">
      {/* Header — copiar do LogsDrawer */}
      {/* ... */}

      <Tabs
        tabs={[
          { key: "logs", label: "Logs" },
          { key: "claude", label: "Claude" },
        ]}
        active={activeTab}
        onChange={setActiveTab}
      />

      {activeTab === "logs" ? (
        // CORPO DA LOGS TAB — copiar de LogsDrawer
        // (lista de linhas, auto-scroll, botão clear, etc)
        <div className="flex-1 overflow-y-auto bg-[var(--color-bg-primary)] px-3 py-2 font-mono text-[12px]">
          {/* ... logs rendering ... */}
        </div>
      ) : (
        <ClaudeTab state={claudeState} projectPath={project.path} />
      )}
    </aside>
  );
}
```

**Implementação completa:** copiar **todo** o conteúdo do `LogsDrawer.tsx`, manter o header e o body de logs como está, envolver com a estrutura acima. **Não simplificar** o body de logs — manter auto-scroll, botão clear, formatação stdout/stderr exatamente como antes.

- [ ] **Step 3: Atualizar imports/uso em `App.tsx`**

Substituir `import { LogsDrawer } from "./components/LogsDrawer"` por `import { ProjectDetailDrawer } from "./components/ProjectDetailDrawer"`.

No JSX, substituir `<LogsDrawer ... />` por `<ProjectDetailDrawer ... claudeState={claudeByProjectPath[selectedProject.path] ?? null} />`.

- [ ] **Step 4: Deletar arquivo antigo**

```bash
rm src/components/LogsDrawer.tsx
```

- [ ] **Step 5: TS check**

```bash
pnpm exec tsc --noEmit
```

Expected: limpo.

- [ ] **Step 6: Commit**

```bash
git add src/components/ProjectDetailDrawer.tsx src/App.tsx
git rm src/components/LogsDrawer.tsx
git commit -m "refactor(drawer): LogsDrawer → ProjectDetailDrawer com tabs Logs/Claude"
```

---

## Phase 4 — CTO (Opus): integração + polish

### Task D1: Build release

- [ ] **Step 1: Build**

```bash
pnpm tauri build --bundles deb 2>&1 | tail -5
```

Expected: deb gerado, sem warnings críticos.

- [ ] **Step 2: Instalar**

```bash
rm ~/.local/bin/falcao-launcher && cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher && ls -la ~/.local/bin/falcao-launcher
```

Expected: binário copiado, ~16MB.

---

### Task D2: Manual QA checklist

**Falcão executa, marca cada item:**

- [ ] App abre sem crash
- [ ] Card do `falcao-launcher` mostra `<ClaudeChip>` (a sessão deste chat está rodando — chip deve estar **ativo, pulsando**)
- [ ] Outros projetos com sessões antigas (ex: `falcao-tcc`) mostram chip estático com contagem de sessões
- [ ] Projetos sem sessão (ex: `Databases`, `palestra-governanca`) **não** renderizam chip
- [ ] Click no card → drawer abre na tab `[Logs]` (default na primeira vez)
- [ ] Toggle pra `[Claude]` → mostra summary + chart + lista de sessões
- [ ] Toggle dia/mês/ano → chart atualiza
- [ ] Lista de sessões mostra título da sessão (`aiTitle` real, não fallback)
- [ ] Botão Spawn Claude → ghostty abre rodando `claude` no diretório do projeto
- [ ] Light mode (System Preferences GNOME) — cores Claude legíveis
- [ ] List view (não grid) — chip e botão Spawn aparecem corretamente
- [ ] Worktrees (governanca-mais-react/.claude/worktrees/X) mostram chip Claude se tiverem sessões próprias

---

### Task D3: Atualizar skill-memória + CLAUDE.md

**Files:**
- Modify: `~/.claude/skills/falcao-launcher/SKILL.md` (diário de bordo)
- Modify: `CLAUDE.md` (overview)

- [ ] **Step 1: Adicionar entrada no diário da skill**

Editar `~/.claude/skills/falcao-launcher/SKILL.md` adicionando seção `### YYYY-MM-DD — Claude Code awareness (Core)` com:
- O que foi feito (chip, drawer tabs, chart, spawn button)
- Decisões: tokens primários, cost derivado, watcher híbrido, threshold 100k
- Path do spec + plan

- [ ] **Step 2: Atualizar CLAUDE.md**

Adicionar bullet em "Estado conhecido": `Claude Code awareness (chip ativo/histórico, drawer Claude tab com chart de tokens, spawn button)`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: registrar Claude Code awareness em CLAUDE.md"
```

---

## Self-Review Checklist (CTO antes de despachar)

Antes de iniciar Agent A, conferir:

- [ ] Spec em `docs/superpowers/specs/2026-05-05-claude-awareness-design.md` cobre:
  - Chip Claude ✅ (B3, B5, B6)
  - Sessions list ✅ (C3)
  - Spawn button ✅ (B4, A8)
  - Cost token-equivalent ✅ (A2, B2)
  - Worktree mapping ✅ (free via `cwd` canônico em A3)
- [ ] Pricing table com data marcada ✅ (A2)
- [ ] Watcher híbrido com fallback ✅ (A6)
- [ ] Active = 5min window ✅ (A1)
- [ ] Granularity dia/mês/ano ✅ (A5, C5)
- [ ] Tokens de design indigo ✅ (Phase 0.3)
- [ ] Light mode ✅ (Phase 0.3)

Sem placeholders. Tipos batem entre Rust e TS. Comandos Tauri registrados em `lib.rs`.

---

## Próximo passo

Plano completo. Skill recomenda **subagent-driven-development** — fresh subagent por task com review entre. Mas o Falcão pediu **3 subagents paralelos** com mais autonomia (Agent A Rust, Agent B Cards, Agent C Drawer). Vou usar a skill `dispatching-parallel-agents` pra coordenar.

Antes de despachar, peço pra ele revisar o plano.
