# Cost Monitor (Sprint B3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar monitoramento de custos/uso multi-serviço (Vercel API `/v1/usage` + GitHub Actions billing + Hetzner agregado) com aba dedicada "Custos" no topbar, alertas visuais a 70%/90% do free tier, e histórico Recharts de 30 dias.

**Architecture:** Hypertable nova `external_metrics` (heterogênea, shape único por linha: `service` + `metric` + `value` + `quota`). Dois coletores novos no `monitor-agent` (tick 1h, paralelos ao loop principal, igual padrão Vercel da Sprint 2). Um espelho do `hetzner.rs` existente. Backend Tauri ganha módulo `costs.rs` com 2 queries + 2 commands. Frontend ganha aba nova com 3 cards de serviço, chart histórico e chip na topbar.

**Tech Stack:** Postgres 16 + TimescaleDB · Rust (`reqwest`, `tokio-postgres`, `deadpool-postgres`) · Tauri 2 · React 19 + TypeScript · Recharts · Tailwind v4.

**Spec:** [`docs/superpowers/specs/2026-05-08-cost-monitor-design.md`](../specs/2026-05-08-cost-monitor-design.md)

**Branch:** `feature/cost-monitor` (já criado).

---

## Mapa de arquivos

### Banco (VM)
- **Criar:** `docs/superpowers/vm-migrations/009_external_metrics.sql` — DDL da hypertable.
- **Modificar:** `docs/superpowers/vm-migrations/VALIDATION.md` — adicionar seção Sprint B3.

### Agente Rust (`src-tauri/crates/monitor-agent/` + `monitor-shared`)
- **Modificar:** `crates/monitor-shared/src/lib.rs` — adicionar struct `ExternalMetric`.
- **Modificar:** `crates/monitor-agent/Cargo.toml` — bump versão `0.2.0 → 0.3.0`.
- **Criar:** `crates/monitor-agent/src/collectors/vercel_usage.rs` — coleta `/v1/usage`.
- **Criar:** `crates/monitor-agent/src/collectors/gh_actions.rs` — coleta `/users/Falkzera/settings/billing/actions`.
- **Modificar:** `crates/monitor-agent/src/collectors/mod.rs` — declarar módulos.
- **Modificar:** `crates/monitor-agent/src/collectors/hetzner.rs` — emitir paralelamente `Vec<ExternalMetric>` (ver Task 5).
- **Modificar:** `crates/monitor-agent/src/db.rs` — função `insert_external_metrics`.
- **Modificar:** `crates/monitor-agent/src/main.rs` — duas tasks paralelas tick 1h (Vercel-usage + GH Actions) + plumbing Hetzner-mirror.

### Backend Tauri (`src-tauri/src/`)
- **Criar:** `src-tauri/src/monitor/costs.rs` — types + queries SELECT.
- **Modificar:** `src-tauri/src/monitor/mod.rs` — `pub mod costs`.
- **Modificar:** `src-tauri/src/monitor/commands.rs` — `monitor_cost_summary` + `monitor_cost_history`.
- **Modificar:** `src-tauri/src/lib.rs` — registrar 2 commands novos.

### Frontend (`src/`)
- **Criar:** `src/types/costs.ts` — tipos + helpers (pctColor, formatters).
- **Modificar:** `src/lib/monitor.ts` — wrappers `costSummary()`, `costHistory()`.
- **Criar:** `src/components/CostUsageBar.tsx` — barra colorida.
- **Criar:** `src/components/CostServiceCard.tsx` — card por serviço.
- **Criar:** `src/components/CostHistoryChart.tsx` — chart Recharts.
- **Criar:** `src/components/CostChip.tsx` — chip topbar.
- **Criar:** `src/components/CostTab.tsx` — orquestrador.
- **Modificar:** `src/App.tsx` — adicionar `"custos"` em `TopView`, render condicional, polling + chip.

### Documentação
- **Modificar:** `CLAUDE.md` — seção "Feature: Monitor de custos multi-serviço (Sprint B3)".
- **Modificar:** `docs/superpowers/vm-migrations/VALIDATION.md` — passos B3.
- **Modificar:** `~/.claude/skills/falcao-launcher/SKILL.md` — entrada de diário.
- **Criar/Modificar:** `.agent.md` por pasta tocada (regras do projeto).

---

## Paralelismo de subagents

Após **Fase 1** (migration + types compartilhados) estar mergeada localmente:

- **Track A — Agente Rust** (Fases 2-3): pasta `src-tauri/crates/monitor-agent/` + `monitor-shared/`.
- **Track B — Backend Tauri** (Fase 4): pasta `src-tauri/src/monitor/` + `src-tauri/src/lib.rs`.
- **Track C — Frontend** (Fases 5-6): pasta `src/`.

Tracks A, B, C são pastas disjuntas → podem rodar como subagents em worktrees paralelas. Track C **não depende** de A/B até a integração final (Fase 7), porque os tipos do frontend são definidos no Track C copiando o shape do spec — drift fica gated em code review (mesmo padrão das sprints anteriores).

Fase 7 (deploy) é serial e roda depois de tudo mergeado.

---

# Fase 1 — Migration + types compartilhados

> **Done quando:** migration aplicada na VM com sucesso + struct `ExternalMetric` no `monitor-shared` + `cargo check` passa em todo o workspace.

### Task 1: Migration `009_external_metrics.sql`

**Files:**
- Create: `docs/superpowers/vm-migrations/009_external_metrics.sql`

- [ ] **Step 1: Escrever a migration**

```sql
-- Sprint B3 — Monitor de custos multi-serviço.
-- Hypertable única heterogênea: serviço externo + métrica + valor + quota.
-- Compartilha shape entre Vercel, GH Actions e Hetzner (espelhado).
CREATE TABLE IF NOT EXISTS external_metrics (
  ts            TIMESTAMPTZ NOT NULL,
  service       TEXT        NOT NULL,    -- 'vercel' | 'gh_actions' | 'hetzner'
  metric        TEXT        NOT NULL,    -- 'bandwidth_bytes' | 'build_minutes' | etc
  value         DOUBLE PRECISION NOT NULL,
  quota         DOUBLE PRECISION,        -- limite do free tier (NULL = sem free tier)
  unit          TEXT        NOT NULL,    -- 'bytes' | 'minutes' | 'count' | 'usd'
  period_start  TIMESTAMPTZ,             -- início do mês de billing
  PRIMARY KEY (ts, service, metric)
);

SELECT create_hypertable('external_metrics', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_external_metrics_lookup
  ON external_metrics (service, metric, ts DESC);

ALTER TABLE external_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'service, metric'
);

SELECT add_compression_policy('external_metrics', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('external_metrics', INTERVAL '90 days', if_not_exists => TRUE);

GRANT SELECT ON external_metrics TO monitor_reader;
GRANT INSERT, SELECT ON external_metrics TO monitor_writer;
```

- [ ] **Step 2: Aplicar manualmente na VM**

```bash
scp docs/superpowers/vm-migrations/009_external_metrics.sql falcao@162.55.217.189:/tmp/
ssh falcao@162.55.217.189 'docker exec -i falcao-monitor-db psql -U postgres -d monitor < /tmp/009_external_metrics.sql'
```

Expected: comandos retornam OK sem erro. `\dt external_metrics` mostra a tabela.

- [ ] **Step 3: Verificar grants**

```bash
ssh falcao@162.55.217.189 'docker exec falcao-monitor-db psql -U postgres -d monitor -c "\dp external_metrics"'
```

Expected: linha pra `external_metrics` mostra `monitor_reader=r/...` e `monitor_writer=arw/...`.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/vm-migrations/009_external_metrics.sql
git commit -m "feat(db): migration 009 external_metrics hypertable"
```

---

### Task 2: Struct `ExternalMetric` em `monitor-shared`

**Files:**
- Modify: `src-tauri/crates/monitor-shared/src/lib.rs`

- [ ] **Step 1: Adicionar struct no fim do arquivo (antes das constantes)**

> Em Rust, `derive` gera código automaticamente: `Serialize/Deserialize` traduz pra/de JSON, `Debug` permite `println!("{x:?}")`, `Clone` permite cópia explícita.

Adicionar logo após o bloco do `VercelDeployment`:

```rust
/// Snapshot de uma métrica de custo/uso de um serviço externo (Sprint B3).
///
/// Heterogêneo demais pra `MetricRow` (carrega quota + period_start),
/// vai pra hypertable dedicada `external_metrics`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExternalMetric {
    pub ts: DateTime<Utc>,
    pub service: String,        // "vercel" | "gh_actions" | "hetzner"
    pub metric: String,         // "bandwidth_bytes" | "build_minutes" | etc
    pub value: f64,
    pub quota: Option<f64>,     // None = sem free tier (Hetzner cost)
    pub unit: String,           // "bytes" | "minutes" | "count" | "usd"
    pub period_start: Option<DateTime<Utc>>,
}
```

- [ ] **Step 2: Bump versão do agente**

Editar `src-tauri/crates/monitor-agent/Cargo.toml`:

```toml
[package]
name = "monitor-agent"
version = "0.3.0"   # era 0.2.0
edition = "2021"
```

- [ ] **Step 3: Verificar compilação**

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: PASS sem erro/warning novo.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/monitor-shared/src/lib.rs src-tauri/crates/monitor-agent/Cargo.toml
git commit -m "feat(shared): ExternalMetric struct + bump monitor-agent 0.3.0"
```

---

# Fase 2 — Coletor `vercel_usage`

> **Done quando:** test do parser passa + agente compila + (manualmente) coleta retorna dados não-vazios contra API real (com token).

### Task 3: Parser fixture-based pra Vercel `/v1/usage`

**Files:**
- Create: `src-tauri/crates/monitor-agent/tests/fixtures/vercel_usage_sample.json`
- Create: `src-tauri/crates/monitor-agent/src/collectors/vercel_usage.rs`
- Modify: `src-tauri/crates/monitor-agent/src/collectors/mod.rs`

- [ ] **Step 1: Criar fixture com resposta real esperada**

Schema do `/v1/usage` retorna campos como `bandwidth`, `buildMinutes`, `imageOptimizations`, `serverlessFunctionExecution` — cada um com `usage`, `limit`, `periodStart`. Salvar uma resposta plausível como fixture:

```bash
mkdir -p src-tauri/crates/monitor-agent/tests/fixtures
```

Conteúdo de `src-tauri/crates/monitor-agent/tests/fixtures/vercel_usage_sample.json`:

```json
{
  "billingPeriod": {
    "start": "2026-05-01T00:00:00.000Z",
    "end": "2026-05-31T23:59:59.999Z"
  },
  "usage": {
    "bandwidth": {
      "usage": 12884901888,
      "limit": 107374182400,
      "unit": "bytes"
    },
    "buildMinutes": {
      "usage": 134,
      "limit": 6000,
      "unit": "minutes"
    },
    "imageOptimizations": {
      "usage": 412,
      "limit": 5000,
      "unit": "count"
    },
    "serverlessFunctionExecution": {
      "usage": 28744,
      "limit": 1000000,
      "unit": "count"
    }
  }
}
```

> ⚠ **Nota:** o shape exato do `/v1/usage` pode diferir em produção. Implementação real DEVE logar `body` na primeira run e ajustar parser se necessário. O parser é defensivo (não derruba o coletor se um campo faltar).

- [ ] **Step 2: Escrever o teste de parsing primeiro (FAIL)**

Criar `src-tauri/crates/monitor-agent/src/collectors/vercel_usage.rs`:

```rust
//! Coletor Vercel /v1/usage — bandwidth + build minutes + image opt + functions.
//! Sprint B3. Tick 1h (rate limit folgado).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::ExternalMetric;
use reqwest::Client;
use serde_json::Value;

const API_BASE: &str = "https://api.vercel.com";
const SERVICE: &str = "vercel";

pub async fn collect(
    ts: DateTime<Utc>,
    client: &Client,
    token: &str,
) -> Result<Vec<ExternalMetric>> {
    let resp = client
        .get(format!("{API_BASE}/v1/usage"))
        .bearer_auth(token)
        .send()
        .await
        .context("GET /v1/usage")?;
    let body: Value = resp
        .error_for_status()
        .context("/v1/usage status")?
        .json()
        .await
        .context("parse /v1/usage body")?;
    Ok(parse_usage(ts, &body))
}

/// Parser puro pra ser testável sem HTTP.
fn parse_usage(ts: DateTime<Utc>, body: &Value) -> Vec<ExternalMetric> {
    let period_start = body
        .get("billingPeriod")
        .and_then(|p| p.get("start"))
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc));

    let mut out = Vec::with_capacity(4);
    let usage = match body.get("usage") {
        Some(u) => u,
        None => return out,
    };

    push(&mut out, ts, period_start, usage, "bandwidth", "bandwidth_bytes", "bytes");
    push(&mut out, ts, period_start, usage, "buildMinutes", "build_minutes", "minutes");
    push(&mut out, ts, period_start, usage, "imageOptimizations", "image_optimization_count", "count");
    push(&mut out, ts, period_start, usage, "serverlessFunctionExecution", "function_invocations", "count");

    out
}

fn push(
    out: &mut Vec<ExternalMetric>,
    ts: DateTime<Utc>,
    period_start: Option<DateTime<Utc>>,
    usage: &Value,
    api_field: &str,
    metric_name: &str,
    unit: &str,
) {
    let entry = match usage.get(api_field) {
        Some(e) => e,
        None => return,
    };
    let value = match entry.get("usage").and_then(Value::as_f64) {
        Some(v) => v,
        None => return,
    };
    let quota = entry.get("limit").and_then(Value::as_f64);
    out.push(ExternalMetric {
        ts,
        service: SERVICE.to_string(),
        metric: metric_name.to_string(),
        value,
        quota,
        unit: unit.to_string(),
        period_start,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/vercel_usage_sample.json");

    #[test]
    fn parses_full_fixture() {
        let body: Value = serde_json::from_str(FIXTURE).expect("valid fixture json");
        let ts = Utc::now();
        let out = parse_usage(ts, &body);
        assert_eq!(out.len(), 4, "expected 4 metrics, got {}", out.len());

        let bw = out.iter().find(|m| m.metric == "bandwidth_bytes").expect("bandwidth");
        assert_eq!(bw.value, 12884901888.0);
        assert_eq!(bw.quota, Some(107374182400.0));
        assert_eq!(bw.unit, "bytes");
        assert_eq!(bw.service, "vercel");
        assert!(bw.period_start.is_some());

        let bm = out.iter().find(|m| m.metric == "build_minutes").expect("build");
        assert_eq!(bm.value, 134.0);
        assert_eq!(bm.quota, Some(6000.0));
    }

    #[test]
    fn missing_usage_returns_empty() {
        let body: Value = serde_json::json!({ "billingPeriod": { "start": "2026-05-01T00:00:00Z" } });
        let out = parse_usage(Utc::now(), &body);
        assert!(out.is_empty());
    }

    #[test]
    fn missing_field_skips_metric_only() {
        let body: Value = serde_json::json!({
            "usage": {
                "bandwidth": { "usage": 100, "limit": 1000 }
                // build/image/function ausentes
            }
        });
        let out = parse_usage(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].metric, "bandwidth_bytes");
    }

    #[test]
    fn missing_limit_is_quota_none() {
        let body: Value = serde_json::json!({
            "usage": {
                "bandwidth": { "usage": 100 }
            }
        });
        let out = parse_usage(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].quota, None);
        assert_eq!(out[0].value, 100.0);
    }
}
```

Adicionar no `src-tauri/crates/monitor-agent/src/collectors/mod.rs`:

```rust
pub mod vercel_usage;
```

(adjacente a `pub mod vercel;` existente.)

- [ ] **Step 3: Rodar o teste — verificar PASS**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p monitor-agent vercel_usage
```

Expected: 4 testes PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/monitor-agent/tests/fixtures/vercel_usage_sample.json \
        src-tauri/crates/monitor-agent/src/collectors/vercel_usage.rs \
        src-tauri/crates/monitor-agent/src/collectors/mod.rs
git commit -m "feat(monitor-agent): coletor vercel_usage (bandwidth + build + image + fn)"
```

---

# Fase 3 — Coletor `gh_actions`

> **Done quando:** test do parser passa + agente compila.

### Task 4: Parser fixture-based pra GitHub Actions billing

**Files:**
- Create: `src-tauri/crates/monitor-agent/tests/fixtures/gh_actions_sample.json`
- Create: `src-tauri/crates/monitor-agent/src/collectors/gh_actions.rs`
- Modify: `src-tauri/crates/monitor-agent/src/collectors/mod.rs`

- [ ] **Step 1: Criar fixture**

Conteúdo de `src-tauri/crates/monitor-agent/tests/fixtures/gh_actions_sample.json`:

```json
{
  "total_minutes_used": 87,
  "total_paid_minutes_used": 0,
  "included_minutes": 2000,
  "minutes_used_breakdown": {
    "UBUNTU": 87,
    "MACOS": 0,
    "WINDOWS": 0
  }
}
```

- [ ] **Step 2: Escrever coletor + teste**

Criar `src-tauri/crates/monitor-agent/src/collectors/gh_actions.rs`:

```rust
//! Coletor GitHub Actions billing.
//! GET /users/{user}/settings/billing/actions com PAT.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::ExternalMetric;
use reqwest::Client;
use serde_json::Value;

const API_BASE: &str = "https://api.github.com";
const SERVICE: &str = "gh_actions";

pub async fn collect(
    ts: DateTime<Utc>,
    client: &Client,
    token: &str,
    user: &str,
) -> Result<Vec<ExternalMetric>> {
    let url = format!("{API_BASE}/users/{user}/settings/billing/actions");
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "falcao-monitor-agent")
        .send()
        .await
        .context("GET billing/actions")?;
    let body: Value = resp
        .error_for_status()
        .context("billing/actions status")?
        .json()
        .await
        .context("parse billing/actions body")?;
    Ok(parse_billing(ts, &body))
}

fn parse_billing(ts: DateTime<Utc>, body: &Value) -> Vec<ExternalMetric> {
    let used = match body.get("total_minutes_used").and_then(Value::as_f64) {
        Some(v) => v,
        None => return Vec::new(),
    };
    let included = body.get("included_minutes").and_then(Value::as_f64);

    vec![ExternalMetric {
        ts,
        service: SERVICE.to_string(),
        metric: "minutes_used".to_string(),
        value: used,
        quota: included,
        unit: "minutes".to_string(),
        period_start: None, // GH não retorna período no payload; UI mostra "este ciclo de billing"
    }]
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/gh_actions_sample.json");

    #[test]
    fn parses_full_fixture() {
        let body: Value = serde_json::from_str(FIXTURE).expect("valid fixture");
        let out = parse_billing(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        let m = &out[0];
        assert_eq!(m.service, "gh_actions");
        assert_eq!(m.metric, "minutes_used");
        assert_eq!(m.value, 87.0);
        assert_eq!(m.quota, Some(2000.0));
        assert_eq!(m.unit, "minutes");
    }

    #[test]
    fn missing_used_returns_empty() {
        let body: Value = serde_json::json!({ "included_minutes": 2000 });
        let out = parse_billing(Utc::now(), &body);
        assert!(out.is_empty());
    }

    #[test]
    fn missing_included_is_quota_none() {
        let body: Value = serde_json::json!({ "total_minutes_used": 50 });
        let out = parse_billing(Utc::now(), &body);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].quota, None);
    }
}
```

Adicionar em `src-tauri/crates/monitor-agent/src/collectors/mod.rs`:

```rust
pub mod gh_actions;
```

- [ ] **Step 3: Rodar o teste**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p monitor-agent gh_actions
```

Expected: 3 testes PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/monitor-agent/tests/fixtures/gh_actions_sample.json \
        src-tauri/crates/monitor-agent/src/collectors/gh_actions.rs \
        src-tauri/crates/monitor-agent/src/collectors/mod.rs
git commit -m "feat(monitor-agent): coletor gh_actions billing"
```

---

# Fase 4 — Espelhamento Hetzner + INSERT pipeline + main.rs

> **Done quando:** `cargo test -p monitor-agent` passa todo + `cargo check` workspace passa + binário compila release.

### Task 5: Espelhar Hetzner em `Vec<ExternalMetric>`

**Files:**
- Modify: `src-tauri/crates/monitor-agent/src/collectors/hetzner.rs`

- [ ] **Step 1: Adicionar função `external_metrics(ts, value) -> Vec<ExternalMetric>` paralela ao `parse_metrics`**

Inserir logo abaixo de `fn parse_metrics(...)` em `hetzner.rs`:

```rust
/// Espelha o `cost_accumulated_usd` em `ExternalMetric` pra alimentar a
/// hypertable `external_metrics` que a aba "Custos" do launcher consulta.
/// Sprint B3. Quota = None (Hetzner não tem free tier).
pub fn external_metrics(ts: DateTime<Utc>, value: &serde_json::Value) -> Vec<monitor_shared::ExternalMetric> {
    let created_at = match parse_created_at(value) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let raw_hours = (ts - created_at).num_seconds() as f64 / 3600.0;
    let hours = if raw_hours.is_finite() && raw_hours > 0.0 {
        raw_hours
    } else {
        0.0
    };
    let cost = hours * HOURLY_RATE_USD;

    vec![monitor_shared::ExternalMetric {
        ts,
        service: "hetzner".to_string(),
        metric: "cost_accumulated_usd".to_string(),
        value: cost,
        quota: None,
        unit: "usd".to_string(),
        period_start: None,
    }]
}
```

E expor via `collect` retornando uma tupla. Substituir a assinatura atual:

```rust
pub async fn collect(ts: DateTime<Utc>) -> Result<(Vec<MetricRow>, Vec<monitor_shared::ExternalMetric>)> {
    let output = Command::new("hcloud")
        .args(["server", "describe", HOST_NAME, "-o", "json"])
        .output()
        .await
        .context("execute hcloud")?;

    if !output.status.success() {
        anyhow::bail!(
            "hcloud failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let value: Value = serde_json::from_slice(&output.stdout).context("parse hcloud json")?;
    Ok((parse_metrics(ts, &value), external_metrics(ts, &value)))
}
```

- [ ] **Step 2: Adicionar teste do espelhamento**

No bloco `mod tests` do `hetzner.rs`, adicionar:

```rust
#[test]
fn external_metrics_emits_cost_row() {
    let created = DateTime::parse_from_rfc3339("2026-05-01T00:00:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let ts = created + chrono::Duration::hours(100);
    let v = json!({ "created": "2026-05-01T00:00:00Z", "status": "running" });

    let rows = external_metrics(ts, &v);
    assert_eq!(rows.len(), 1);
    let m = &rows[0];
    assert_eq!(m.service, "hetzner");
    assert_eq!(m.metric, "cost_accumulated_usd");
    assert_eq!(m.unit, "usd");
    assert_eq!(m.quota, None);
    assert!((m.value - 0.766).abs() < 1e-3);
}

#[test]
fn external_metrics_skips_when_no_created_at() {
    let v = json!({ "status": "running" });
    assert!(external_metrics(Utc::now(), &v).is_empty());
}
```

- [ ] **Step 3: Rodar todos os testes do hetzner**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p monitor-agent hetzner
```

Expected: testes existentes (5) + 2 novos = 7 PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/crates/monitor-agent/src/collectors/hetzner.rs
git commit -m "feat(monitor-agent): hetzner espelha cost_accumulated_usd em external_metrics"
```

---

### Task 6: INSERT batch `external_metrics` no `db.rs`

**Files:**
- Modify: `src-tauri/crates/monitor-agent/src/db.rs`

- [ ] **Step 1: Adicionar função INSERT (atalho UPSERT)**

Inserir após `insert_vercel_deployments`:

```rust
/// INSERT batch transacional pra `external_metrics`.
/// UPSERT por (ts, service, metric) — re-run no mesmo segundo atualiza em vez de duplicar.
pub async fn insert_external_metrics(
    pool: &Pool,
    rows: &[monitor_shared::ExternalMetric],
) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let mut client = pool.get().await.context("get pool client")?;
    let tx = client.transaction().await.context("begin tx")?;
    let stmt = tx
        .prepare(
            "INSERT INTO external_metrics
             (ts, service, metric, value, quota, unit, period_start)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (ts, service, metric) DO UPDATE
               SET value = EXCLUDED.value,
                   quota = EXCLUDED.quota,
                   unit  = EXCLUDED.unit,
                   period_start = EXCLUDED.period_start",
        )
        .await
        .context("prepare insert external_metrics")?;

    for r in rows {
        tx.execute(
            &stmt,
            &[
                &r.ts,
                &r.service,
                &r.metric,
                &r.value,
                &r.quota,
                &r.unit,
                &r.period_start,
            ],
        )
        .await
        .context("execute insert external_metrics")?;
    }
    tx.commit().await.context("commit external_metrics tx")?;
    Ok(())
}
```

> Não importar `monitor_shared::ExternalMetric` no topo — usar o caminho qualificado mantém o uso pontual e ecoa o padrão do `VercelDeployment`. Se preferir importar, adicione `ExternalMetric` no `use monitor_shared::{...}` existente.

- [ ] **Step 2: Verificar compile**

```bash
cargo check --manifest-path src-tauri/Cargo.toml -p monitor-agent
```

Expected: PASS sem erro.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/crates/monitor-agent/src/db.rs
git commit -m "feat(monitor-agent): db.insert_external_metrics com UPSERT"
```

---

### Task 7: Wire main.rs — duas tasks de 1h + plumbing Hetzner

**Files:**
- Modify: `src-tauri/crates/monitor-agent/src/main.rs`

- [ ] **Step 1: Atualizar handling do `hetzner::collect` no loop principal**

Trocar bloco do hetzner (atualmente `match hz_res { Ok(mut rows) => batch.append(&mut rows), ... }`) pra desempacotar a tupla nova:

```rust
match hz_res {
    Ok((mut rows, ext_rows)) => {
        batch.append(&mut rows);
        if !ext_rows.is_empty() {
            if let Err(e) = db::insert_external_metrics(&pool, &ext_rows).await {
                tracing::warn!("hetzner: insert external_metrics failed: {e:#}");
            }
        }
    }
    Err(e) => tracing::warn!("hetzner collector failed: {e:#}"),
}
```

- [ ] **Step 2: Adicionar task de 1h pro `vercel_usage`**

Logo abaixo do bloco `if let Some(token) = vercel_token { ... }` existente (que faz coleta de deployments a cada 5min), adicionar uma SEGUNDA task usando o **mesmo token** (clonar antes do bloco existente, ou ler env var de novo). Mais simples: ler `VERCEL_TOKEN` outra vez:

```rust
if let Ok(token) = std::env::var("VERCEL_TOKEN") {
    let pool_clone = pool.clone();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("build reqwest client (vercel_usage)")?;
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(3600));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let ts = Utc::now();
            match collectors::vercel_usage::collect(ts, &http, &token).await {
                Ok(rows) => {
                    if rows.is_empty() {
                        tracing::debug!("vercel_usage: nenhuma métrica retornada");
                        continue;
                    }
                    let count = rows.len();
                    match db::insert_external_metrics(&pool_clone, &rows).await {
                        Ok(()) => tracing::info!(rows = count, "vercel_usage: persisted"),
                        Err(e) => tracing::warn!("vercel_usage: insert failed: {e:#}"),
                    }
                }
                Err(e) => tracing::warn!("vercel_usage: collect failed: {e:#}"),
            }
        }
    });
}
```

- [ ] **Step 3: Adicionar task de 1h pro `gh_actions`**

Logo abaixo do bloco anterior:

```rust
if let Ok(token) = std::env::var("GH_PAT_SECURITY") {
    let user = std::env::var("GH_BILLING_USER").unwrap_or_else(|_| "Falkzera".to_string());
    let pool_clone = pool.clone();
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .context("build reqwest client (gh_actions)")?;
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(3600));
        tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            let ts = Utc::now();
            match collectors::gh_actions::collect(ts, &http, &token, &user).await {
                Ok(rows) => {
                    if rows.is_empty() {
                        tracing::debug!("gh_actions: nenhuma métrica retornada");
                        continue;
                    }
                    let count = rows.len();
                    match db::insert_external_metrics(&pool_clone, &rows).await {
                        Ok(()) => tracing::info!(rows = count, "gh_actions: persisted"),
                        Err(e) => tracing::warn!("gh_actions: insert failed: {e:#}"),
                    }
                }
                Err(e) => tracing::warn!("gh_actions: collect failed: {e:#}"),
            }
        }
    });
} else {
    tracing::warn!("gh_actions: GH_PAT_SECURITY ausente — coletor desabilitado");
}
```

- [ ] **Step 4: Build release pra confirmar tudo compila**

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml -p monitor-agent --bin falcao-monitor-agent
```

Expected: PASS sem erro.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/crates/monitor-agent/src/main.rs
git commit -m "feat(monitor-agent): tasks paralelas vercel_usage + gh_actions tick 1h + hetzner mirror"
```

---

# Fase 5 — Backend Tauri (`monitor/costs.rs` + commands)

> **Done quando:** `cargo check` (workspace) passa + commands aparecem no `invoke_handler` + tipo `CostUsage` derivam Serialize com snake_case.

### Task 8: Módulo `monitor/costs.rs` com types + queries

**Files:**
- Create: `src-tauri/src/monitor/costs.rs`
- Modify: `src-tauri/src/monitor/mod.rs`

- [ ] **Step 1: Criar `costs.rs` com tipos + duas queries**

```rust
//! Queries SELECT pra hypertable `external_metrics` (Sprint B3).
//!
//! `cost_summary` retorna a última amostra por (service, metric) — DISTINCT ON.
//! `cost_history` retorna série temporal pra um (service, metric) específico
//! dentro de um range bounded (max 90 dias, mesmo retention da hypertable).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct CostUsage {
    pub service: String,
    pub metric: String,
    pub value: f64,
    pub quota: Option<f64>,
    pub unit: String,
    pub pct: Option<f64>,                // value/quota * 100, None se quota é None
    pub period_start: Option<DateTime<Utc>>,
    pub ts: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CostHistoryPoint {
    pub ts: DateTime<Utc>,
    pub value: f64,
}

const VALID_SERVICES: &[&str] = &["vercel", "gh_actions", "hetzner"];
const VALID_METRICS: &[&str] = &[
    "bandwidth_bytes",
    "build_minutes",
    "image_optimization_count",
    "function_invocations",
    "minutes_used",
    "cost_accumulated_usd",
];

pub async fn cost_summary(pool: &Pool) -> Result<Vec<CostUsage>> {
    let client = pool.get().await.context("get client")?;
    let rows = client
        .query(
            r#"
            SELECT DISTINCT ON (service, metric)
              service, metric, value, quota, unit, period_start, ts
            FROM external_metrics
            WHERE ts > now() - interval '24 hours'
            ORDER BY service, metric, ts DESC
            "#,
            &[],
        )
        .await
        .context("query cost_summary")?;

    Ok(rows
        .into_iter()
        .map(|r| {
            let value: f64 = r.get(2);
            let quota: Option<f64> = r.get(3);
            let pct = quota.map(|q| if q > 0.0 { (value / q) * 100.0 } else { 0.0 });
            CostUsage {
                service: r.get(0),
                metric: r.get(1),
                value,
                quota,
                unit: r.get(4),
                pct,
                period_start: r.get(5),
                ts: r.get(6),
            }
        })
        .collect())
}

pub async fn cost_history(
    pool: &Pool,
    service: &str,
    metric: &str,
    since: DateTime<Utc>,
    until: DateTime<Utc>,
) -> Result<Vec<CostHistoryPoint>> {
    if !VALID_SERVICES.contains(&service) {
        anyhow::bail!("invalid service: {service}");
    }
    if !VALID_METRICS.contains(&metric) {
        anyhow::bail!("invalid metric: {metric}");
    }
    if until <= since {
        anyhow::bail!("until must be > since");
    }
    let max_range = chrono::Duration::days(90);
    if until - since > max_range {
        anyhow::bail!("range max é 90 dias");
    }

    let client = pool.get().await.context("get client")?;
    let rows = client
        .query(
            r#"
            SELECT ts, value
            FROM external_metrics
            WHERE service = $1
              AND metric  = $2
              AND ts >= $3
              AND ts <= $4
            ORDER BY ts ASC
            "#,
            &[&service, &metric, &since, &until],
        )
        .await
        .context("query cost_history")?;

    Ok(rows
        .into_iter()
        .map(|r| CostHistoryPoint {
            ts: r.get(0),
            value: r.get(1),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_unknown_service() {
        // Passa um pool dummy via Default — não vai chegar à query, falha antes.
        // Truque: usamos um pool real-style mas a query nem é executada porque
        // os early-returns são antes do `pool.get()`.
        // Para esse caso simples, instanciamos manualmente:
        let cfg: tokio_postgres::Config = "host=127.0.0.1 user=x password=y dbname=z"
            .parse()
            .expect("parse cfg");
        let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            cfg,
            tokio_postgres::NoTls,
        ))
        .max_size(1)
        .build()
        .expect("build pool");

        let now = Utc::now();
        let err = cost_history(&pool, "invalid", "minutes_used", now, now + chrono::Duration::hours(1))
            .await
            .expect_err("should fail");
        assert!(err.to_string().contains("invalid service"));
    }

    #[tokio::test]
    async fn rejects_range_over_90_days() {
        let cfg: tokio_postgres::Config = "host=127.0.0.1 user=x password=y dbname=z"
            .parse()
            .expect("parse cfg");
        let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(
            cfg,
            tokio_postgres::NoTls,
        ))
        .max_size(1)
        .build()
        .expect("build pool");

        let now = Utc::now();
        let err = cost_history(&pool, "vercel", "bandwidth_bytes", now - chrono::Duration::days(91), now)
            .await
            .expect_err("should fail");
        assert!(err.to_string().contains("90 dias"));
    }
}
```

- [ ] **Step 2: Registrar módulo em `monitor/mod.rs`**

Editar `src-tauri/src/monitor/mod.rs` adicionando linha:

```rust
pub mod costs;
```

(adjacente às outras `pub mod` lines.)

- [ ] **Step 3: Compilar + rodar tests**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p falcao-launcher costs
```

Expected: 2 testes PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/monitor/costs.rs src-tauri/src/monitor/mod.rs
git commit -m "feat(monitor): módulo costs com cost_summary + cost_history"
```

---

### Task 9: Commands Tauri `monitor_cost_summary` + `monitor_cost_history`

**Files:**
- Modify: `src-tauri/src/monitor/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Adicionar imports + commands em `commands.rs`**

No topo do arquivo, ampliar import existente:

```rust
use crate::monitor::costs::{self, CostHistoryPoint, CostUsage};
```

(adicionar abaixo das linhas `use crate::monitor::security::...` etc.)

No final do arquivo, adicionar:

```rust
#[tauri::command]
pub async fn monitor_cost_summary(state: State<'_, MonitorState>) -> Result<Vec<CostUsage>, String> {
    let pool = pool_or_err(&state)?;
    costs::cost_summary(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_cost_history(
    state: State<'_, MonitorState>,
    service: String,
    metric: String,
    since_iso: String,
    until_iso: String,
) -> Result<Vec<CostHistoryPoint>, String> {
    let pool = pool_or_err(&state)?;
    let since: DateTime<Utc> = since_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid since_iso: {e}"))?;
    let until: DateTime<Utc> = until_iso
        .parse()
        .map_err(|e: chrono::ParseError| format!("invalid until_iso: {e}"))?;
    costs::cost_history(&pool, &service, &metric, since, until)
        .await
        .map_err(|e| e.to_string())
}
```

> ℹ Procurar a função helper que retorna o pool atual do `MonitorState` (provavelmente algo como `pool_or_err` ou inline `state.pool.lock().unwrap().as_ref().ok_or(...)`). Se não houver helper, copiar o pattern dos `monitor_list_vulnerabilities` e adjacentes.

- [ ] **Step 2: Registrar em `src-tauri/src/lib.rs`**

Localizar o bloco `use crate::commands::{... MonitorState};` (line ~14) e adicionar `monitor_cost_summary, monitor_cost_history` na lista importada.

Localizar `invoke_handler!(... monitor_vuln_count_by_repo, ...)` e adicionar os dois novos commands logo abaixo:

```rust
monitor_cost_summary,
monitor_cost_history,
```

- [ ] **Step 3: Compilar workspace inteiro**

```bash
pnpm exec tsc --noEmit && cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: ambos PASS sem erro.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/monitor/commands.rs src-tauri/src/lib.rs
git commit -m "feat(monitor): commands monitor_cost_summary + monitor_cost_history"
```

---

# Fase 6 — Frontend tipos + API

> **Done quando:** `pnpm exec tsc --noEmit` passa + helpers puros têm uso óbvio.

### Task 10: Tipos `costs.ts` + helpers puros

**Files:**
- Create: `src/types/costs.ts`

- [ ] **Step 1: Criar arquivo de tipos**

```ts
// Espelha src-tauri/src/monitor/costs.rs (Tauri serializa em snake_case).
// Mantido em sync manualmente — drift gated em code review.

export type CostService = "vercel" | "gh_actions" | "hetzner";
export type CostUnit = "bytes" | "minutes" | "count" | "usd";

export interface CostUsage {
  service: CostService;
  metric: string;
  value: number;
  quota: number | null;
  unit: CostUnit;
  pct: number | null;
  period_start: string | null; // ISO
  ts: string;                  // ISO
}

export interface CostHistoryPoint {
  ts: string;
  value: number;
}

export const COST_THRESHOLDS = {
  warning: 70,
  danger: 90,
} as const;

export type CostColor = "success" | "warning" | "danger" | "muted";

export function pctColor(pct: number | null): CostColor {
  if (pct == null) return "muted";
  if (pct >= COST_THRESHOLDS.danger) return "danger";
  if (pct >= COST_THRESHOLDS.warning) return "warning";
  return "success";
}

export const SERVICE_LABEL: Record<CostService, string> = {
  vercel: "Vercel",
  gh_actions: "GitHub Actions",
  hetzner: "Hetzner",
};

export const SERVICE_ICON: Record<CostService, string> = {
  vercel: "▲",
  gh_actions: "🐙",
  hetzner: "☁",
};

/** Formata `value` no `unit` declarado, sem assumir nada do contexto. */
export function formatCostValue(value: number, unit: CostUnit): string {
  switch (unit) {
    case "bytes":
      return formatBytes(value);
    case "minutes":
      return `${Math.round(value)} min`;
    case "count":
      return value.toLocaleString("pt-BR");
    case "usd":
      return `$${value.toFixed(2)}`;
  }
}

function formatBytes(b: number): string {
  if (b < 1024) return `${b.toFixed(0)} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: PASS sem erro.

- [ ] **Step 3: Commit**

```bash
git add src/types/costs.ts
git commit -m "feat(types): costs.ts — CostUsage, CostHistoryPoint, pctColor"
```

---

### Task 11: Wrappers `costSummary` + `costHistory` em `monitor.ts`

**Files:**
- Modify: `src/lib/monitor.ts`

- [ ] **Step 1: Adicionar imports + wrappers**

No topo, ampliar import existente:

```ts
import type {
  CostHistoryPoint,
  CostUsage,
} from "../types/costs";
```

Dentro do objeto `monitorApi`, adicionar:

```ts
  // Sprint B3 — Custos multi-serviço
  costSummary: () => invoke<CostUsage[]>("monitor_cost_summary"),
  costHistory: (
    service: string,
    metric: string,
    sinceIso: string,
    untilIso: string,
  ) =>
    invoke<CostHistoryPoint[]>("monitor_cost_history", {
      service,
      metric,
      sinceIso,
      untilIso,
    }),
```

- [ ] **Step 2: Type-check**

```bash
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/monitor.ts
git commit -m "feat(lib): monitorApi.costSummary + costHistory"
```

---

# Fase 7 — Componentes React

> **Done quando:** todos componentes renderizam sem erro de runtime no dev server + tsc passa.

### Task 12: `CostUsageBar` — barra colorida com gradiente threshold

**Files:**
- Create: `src/components/CostUsageBar.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { pctColor, type CostColor } from "../types/costs";

interface Props {
  /** Valor consumido. */
  value: number;
  /** Limite do free tier; null = sem free tier (renderiza barra cinza ⅓ cheia). */
  quota: number | null;
  /** % calculado já no backend (CostUsage.pct). null = sem quota. */
  pct: number | null;
  /** Texto pré-formatado (ex: "12.4 GB / 100 GB"). */
  label: string;
}

const COLOR_TO_VAR: Record<CostColor, string> = {
  success: "var(--color-success, #10b981)",
  warning: "var(--color-accent-primary)",
  danger: "var(--color-danger)",
  muted: "var(--color-text-muted)",
};

export function CostUsageBar({ value: _value, quota, pct, label }: Props) {
  const color = pctColor(pct);
  const fillPct = quota == null ? 33 : Math.min(100, Math.max(2, pct ?? 0));

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2 font-mono text-xs">
        <span className="text-[var(--color-text-secondary)]">{label}</span>
        {pct != null && (
          <span style={{ color: COLOR_TO_VAR[color] }} className="font-semibold">
            {pct.toFixed(1)}%
          </span>
        )}
        {pct == null && (
          <span className="text-[var(--color-text-muted)]">sem free tier</span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-bg-secondary)]">
        <div
          className="h-full rounded-full transition-[width,background-color]"
          style={{ width: `${fillPct}%`, backgroundColor: COLOR_TO_VAR[color] }}
        />
      </div>
    </div>
  );
}
```

> Token `--color-success` pode não existir em `App.css`. Se `tsc/dev server` reclamar visualmente (cor errada), adicione `--color-success: #10b981;` no bloco `@theme {}` em `src/App.css`. Tailwind v4 não tem `tailwind.config.js`.

- [ ] **Step 2: Type-check + smoke**

```bash
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/CostUsageBar.tsx
git commit -m "feat(ui): CostUsageBar com 4 cores threshold"
```

---

### Task 13: `CostServiceCard` — card por serviço com N métricas

**Files:**
- Create: `src/components/CostServiceCard.tsx`

- [ ] **Step 1: Implementar**

```tsx
import {
  formatCostValue,
  SERVICE_ICON,
  SERVICE_LABEL,
  type CostService,
  type CostUsage,
} from "../types/costs";
import { CostUsageBar } from "./CostUsageBar";

interface Props {
  service: CostService;
  metrics: CostUsage[];
}

export function CostServiceCard({ service, metrics }: Props) {
  const sortedMetrics = [...metrics].sort((a, b) => {
    // Ordenar por pct desc; null vai pro fim
    if (a.pct == null && b.pct == null) return 0;
    if (a.pct == null) return 1;
    if (b.pct == null) return -1;
    return b.pct - a.pct;
  });

  return (
    <section className="rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4 space-y-3">
      <header className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold text-[var(--color-text-primary)]">
          <span aria-hidden>{SERVICE_ICON[service]}</span>
          <span>{SERVICE_LABEL[service]}</span>
        </h3>
      </header>

      {sortedMetrics.length === 0 && (
        <p className="text-xs text-[var(--color-text-muted)]">
          aguardando primeira coleta (até 1h)
        </p>
      )}

      {sortedMetrics.map((m) => {
        const valueFmt = formatCostValue(m.value, m.unit);
        const quotaFmt = m.quota != null ? formatCostValue(m.quota, m.unit) : null;
        const label = quotaFmt
          ? `${m.metric}: ${valueFmt} / ${quotaFmt}`
          : `${m.metric}: ${valueFmt}`;
        return (
          <CostUsageBar
            key={m.metric}
            value={m.value}
            quota={m.quota}
            pct={m.pct}
            label={label}
          />
        );
      })}
    </section>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add src/components/CostServiceCard.tsx
git commit -m "feat(ui): CostServiceCard com lista de métricas por serviço"
```

---

### Task 14: `CostHistoryChart` — Recharts com select

**Files:**
- Create: `src/components/CostHistoryChart.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { monitorApi } from "../lib/monitor";
import {
  formatCostValue,
  SERVICE_LABEL,
  type CostHistoryPoint,
  type CostService,
  type CostUnit,
  type CostUsage,
} from "../types/costs";

interface Props {
  /** Lista atual de métricas (pra popular o selectbox). */
  summary: CostUsage[];
  /** Habilitado quando o tunnel está pronto. */
  ready: boolean;
}

export function CostHistoryChart({ summary, ready }: Props) {
  const [selected, setSelected] = useState<{
    service: CostService;
    metric: string;
    unit: CostUnit;
  } | null>(null);
  const [points, setPoints] = useState<CostHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);

  // Default: primeira métrica em alerta (≥70%) ou bandwidth Vercel
  useEffect(() => {
    if (selected || summary.length === 0) return;
    const alarmed = summary.find((m) => (m.pct ?? 0) >= 70);
    const bandwidth = summary.find(
      (m) => m.service === "vercel" && m.metric === "bandwidth_bytes",
    );
    const fallback = alarmed ?? bandwidth ?? summary[0];
    setSelected({
      service: fallback.service,
      metric: fallback.metric,
      unit: fallback.unit,
    });
  }, [summary, selected]);

  useEffect(() => {
    if (!ready || !selected) return;
    let cancelled = false;
    const until = new Date();
    const since = new Date(until.getTime() - 30 * 24 * 3600 * 1000);
    setLoading(true);
    monitorApi
      .costHistory(selected.service, selected.metric, since.toISOString(), until.toISOString())
      .then((data) => {
        if (!cancelled) setPoints(data);
      })
      .catch((e) => console.warn("costHistory failed:", e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, selected]);

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        ts: new Date(p.ts).getTime(),
        value: p.value,
      })),
    [points],
  );

  const yFmt = useMemo(() => {
    if (!selected) return (v: number) => String(v);
    return (v: number) => formatCostValue(v, selected.unit);
  }, [selected]);

  return (
    <section className="space-y-3 rounded-xl border border-[var(--color-border-subtle)] bg-[var(--color-bg-card)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-[var(--color-text-primary)]">
          Histórico (30 dias)
        </h3>
        <select
          value={selected ? `${selected.service}::${selected.metric}` : ""}
          onChange={(e) => {
            const [service, metric] = e.target.value.split("::") as [CostService, string];
            const m = summary.find((x) => x.service === service && x.metric === metric);
            if (m) setSelected({ service, metric, unit: m.unit });
          }}
          className="rounded-md border border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs"
        >
          {summary.map((m) => (
            <option key={`${m.service}::${m.metric}`} value={`${m.service}::${m.metric}`}>
              {SERVICE_LABEL[m.service]} · {m.metric}
            </option>
          ))}
        </select>
      </header>

      <div className="h-56 w-full">
        {loading && (
          <p className="text-xs text-[var(--color-text-muted)]">carregando…</p>
        )}
        {!loading && chartData.length === 0 && (
          <p className="text-xs text-[var(--color-text-muted)]">
            sem dados ainda — primeira amostra chega em até 1h
          </p>
        )}
        {!loading && chartData.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border-subtle)" />
              <XAxis
                dataKey="ts"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(t) => new Date(t).toLocaleDateString("pt-BR", { month: "short", day: "2-digit" })}
                stroke="var(--color-text-muted)"
                fontSize={10}
              />
              <YAxis tickFormatter={yFmt} stroke="var(--color-text-muted)" fontSize={10} width={70} />
              <Tooltip
                labelFormatter={(t) => new Date(t).toLocaleString("pt-BR")}
                formatter={(v: number) => yFmt(v)}
                contentStyle={{
                  background: "var(--color-bg-card)",
                  border: "1px solid var(--color-border-subtle)",
                  borderRadius: 6,
                }}
              />
              <Line
                type="monotone"
                dataKey="value"
                stroke="var(--color-accent-primary)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add src/components/CostHistoryChart.tsx
git commit -m "feat(ui): CostHistoryChart 30d com selectbox de (service, metric)"
```

---

### Task 15: `CostChip` — chip topbar quando há serviço ≥90%

**Files:**
- Create: `src/components/CostChip.tsx`

- [ ] **Step 1: Implementar**

```tsx
interface Props {
  /** Quantidade de métricas em estado danger (≥90%). 0 → não renderiza. */
  count: number;
}

/**
 * Chip compacto na topbar próximo ao label "Custos".
 * Sprint B3 — Monitor de custos. Render null se count == 0.
 */
export function CostChip({ count }: Props) {
  if (count <= 0) return null;
  return (
    <span
      className="ml-1 rounded-full border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-[var(--color-danger)]"
      title={`${count} métrica${count === 1 ? "" : "s"} ≥ 90% do free tier`}
    >
      ⚠ {count}
    </span>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add src/components/CostChip.tsx
git commit -m "feat(ui): CostChip pra topbar"
```

---

### Task 16: `CostTab` — orquestrador da aba

**Files:**
- Create: `src/components/CostTab.tsx`

- [ ] **Step 1: Implementar**

```tsx
import { useMemo } from "react";
import { monitorApi, usePolling, useTunnel } from "../lib/monitor";
import { InlineLoading } from "./Loading";
import { CostHistoryChart } from "./CostHistoryChart";
import { CostServiceCard } from "./CostServiceCard";
import type { CostService, CostUsage } from "../types/costs";

const SERVICES: CostService[] = ["vercel", "gh_actions", "hetzner"];

export function CostTab() {
  const { ready, error: tunnelErr } = useTunnel();
  const { data: summary, error } = usePolling(monitorApi.costSummary, 60_000, ready);

  const grouped = useMemo(() => {
    if (!summary) return null;
    const map: Record<CostService, CostUsage[]> = {
      vercel: [],
      gh_actions: [],
      hetzner: [],
    };
    for (const m of summary) {
      const svc = m.service as CostService;
      if (svc in map) map[svc].push(m);
    }
    return map;
  }, [summary]);

  return (
    <div className="space-y-5">
      {tunnelErr && (
        <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          Tunnel SSH: {tunnelErr}
        </div>
      )}
      {error && summary == null && (
        <div className="rounded-lg border border-[var(--color-danger)]/40 bg-[var(--color-danger-soft)] p-3 text-xs text-[var(--color-danger)]">
          Erro: {String(error)}
        </div>
      )}

      {!summary && (
        <InlineLoading
          minHeight="9rem"
          messages={[
            "Buscando uso Vercel",
            "Lendo billing GitHub",
            "Cruzando com Hetzner",
            "Quase lá",
          ]}
        />
      )}

      {grouped && (
        <>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {SERVICES.map((s) => (
              <CostServiceCard key={s} service={s} metrics={grouped[s]} />
            ))}
          </div>
          <CostHistoryChart summary={summary ?? []} ready={ready} />
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm exec tsc --noEmit
git add src/components/CostTab.tsx
git commit -m "feat(ui): CostTab orquestrador com 3 cards + chart histórico"
```

---

# Fase 8 — Wire na topbar do `App.tsx`

> **Done quando:** dev server abre, aba "Custos" aparece e renderiza (mesmo com dados vazios), chip topbar não acende fora de cenário.

### Task 17: Adicionar `"custos"` em TopView + render condicional

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Atualizar `TopView` union type**

Localizar (linha ~37):

```ts
type TopView = "projects" | "skills" | "vm" | "security";
```

Trocar por:

```ts
type TopView = "projects" | "skills" | "vm" | "security" | "custos";
```

- [ ] **Step 2: Atualizar persistência localStorage**

Localizar `useState<TopView>(() => { ... })` (linha ~64). Adicionar branch pra "custos":

```ts
  const [topView, setTopView] = useState<TopView>(() => {
    const saved = localStorage.getItem(TOP_VIEW_KEY);
    if (saved === "skills") return "skills";
    if (saved === "vm") return "vm";
    if (saved === "security") return "security";
    if (saved === "custos") return "custos";
    return "projects";
  });
```

- [ ] **Step 3: Importar componentes novos**

No bloco de imports do topo:

```ts
import { CostTab } from "./components/CostTab";
import { CostChip } from "./components/CostChip";
import type { CostUsage } from "./types/costs";
```

- [ ] **Step 4: Adicionar estado de polling pra dangerCount + summary cacheado**

Próximo a `vulnCountByRepo`:

```ts
  const [costSummary, setCostSummary] = useState<CostUsage[]>([]);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      monitorApi
        .costSummary()
        .then((data) => {
          if (!cancelled) setCostSummary(data);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 5 * 60 * 1000); // 5min
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const dangerCount = useMemo(
    () => costSummary.filter((m) => (m.pct ?? 0) >= 90).length,
    [costSummary],
  );
```

> ⚠ Esse polling **não** chama `useTunnel()` aqui no `App.tsx` — precisa que o tunnel esteja aberto. Como `VmTab`/`SecurityTab`/`CostTab` chamam `useTunnel()` internamente, na primeira visita do user a uma dessas abas o tunnel abre e os fetches subsequentes funcionam. Antes disso, `costSummary` fica vazio e o chip não acende — comportamento aceitável (zero ruído inicial).

Importar `useMemo` se ainda não estiver no escopo.

- [ ] **Step 5: Atualizar a topbar**

Localizar (linha ~373):

```ts
{(["projects", "skills", "security", "vm"] as TopView[]).map((v) => {
```

Trocar por:

```ts
{(["projects", "skills", "security", "custos", "vm"] as TopView[]).map((v) => {
```

E o `label`:

```ts
const label =
  v === "projects"
    ? "Projetos"
    : v === "skills"
      ? "Skills"
      : v === "security"
        ? "Segurança"
        : v === "custos"
          ? "Custos"
          : "VM";
```

E dentro do `<button>`, mostrar o chip ao lado do label quando `v === "custos"`:

```tsx
<button ... >
  {label}
  {v === "custos" && <CostChip count={dangerCount} />}
  {isActive && (
    <motion.span ... />
  )}
</button>
```

- [ ] **Step 6: Atualizar headers (h1 + p)**

Localizar bloco do `<h1>` (linha ~408):

```tsx
<h1 className="page-title text-3xl">
  {topView === "projects"
    ? "Falcão Launcher"
    : topView === "skills"
      ? "Skills"
      : topView === "security"
        ? "Segurança"
        : topView === "custos"
          ? "Custos"
          : "VM"}
</h1>
```

E o `<p>`:

```tsx
<p className="mt-1 text-sm font-light text-[var(--color-text-secondary)]">
  {topView === "projects"
    ? loading ? "Scanning ~/Projects…" : `${projects.length} projects · ...`
    : topView === "skills"
      ? "skills instaladas em ~/.claude/"
      : topView === "security"
        ? "CVEs nos seus repos e imagens da VM"
        : topView === "custos"
          ? "Vercel · GitHub Actions · Hetzner"
          : "falcao-main · CX23 · 162.55.217.189"}
</p>
```

- [ ] **Step 7: Render condicional**

Localizar (linha ~529):

```tsx
{topView === "skills" ? (
  <SkillsView />
) : topView === "security" ? (
  <SecurityTab />
) : topView === "vm" ? null : (
  <>...</>  // projects view
)}
```

Adicionar caso "custos" antes de "vm":

```tsx
{topView === "skills" ? (
  <SkillsView />
) : topView === "security" ? (
  <SecurityTab />
) : topView === "custos" ? (
  <CostTab />
) : topView === "vm" ? null : (
  <>...</>
)}
```

- [ ] **Step 8: Type-check + dev run smoke**

```bash
pnpm exec tsc --noEmit
```

Expected: PASS.

```bash
pnpm tauri dev
```

Manualmente: clicar em "Custos" — aparece skeleton "carregando" enquanto o tunnel abre, depois 3 cards (provavelmente vazios até o agente coletar pela primeira vez). Sem erro de console.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat(ui): aba Custos no topbar com polling 5min e chip danger"
```

---

# Fase 9 — agent.md updates

> **Done quando:** todas as pastas tocadas têm `.agent.md` atualizado com decisão B3.

### Task 18: Atualizar `.agent.md` por pasta

**Files:**
- Modify: `src-tauri/crates/monitor-shared/.agent.md`
- Modify: `src-tauri/crates/monitor-agent/src/collectors/.agent.md`
- Modify: `src-tauri/src/monitor/.agent.md`
- Modify: `src/types/.agent.md`
- Modify: `src/lib/.agent.md`
- Modify: `src/components/.agent.md`

- [ ] **Step 1: Adicionar entrada B3 em cada `.agent.md`**

Em cada arquivo, adicionar uma linha em "Decisões recentes" no formato existente:

`monitor-shared/.agent.md`:
```
- 2026-05-08 (Sprint B3 — Custos multi-serviço): adicionado `ExternalMetric { ts, service, metric, value, quota, unit, period_start }`. Heterogêneo demais pra `MetricRow` (carrega quota+period_start). Usado pelos coletores `vercel_usage`, `gh_actions` e espelhamento `hetzner`. Agente bumped 0.2.0 → 0.3.0.
```

`monitor-agent/src/collectors/.agent.md`:
```
- 2026-05-08 (Sprint B3): coletores `vercel_usage.rs` (GET /v1/usage, tick 1h, 4 métricas: bandwidth/build/image_opt/fn) e `gh_actions.rs` (GET /users/{user}/settings/billing/actions, tick 1h, 1 métrica: minutes_used). Ambos com fixture-based parser tests. `hetzner.rs` ganhou função `external_metrics()` que espelha cost_accumulated_usd em `ExternalMetric` pra alimentar a aba Custos. Coletores degradam gracefully sem token (warn + skip task).
```

`src-tauri/src/monitor/.agent.md`:
```
- 2026-05-08 (Sprint B3): `costs.rs` novo. `cost_summary()` (DISTINCT ON última amostra por service/metric, 24h window) e `cost_history(service, metric, since, until)` (range bounded max 90d). Whitelist defensiva de service/metric. 2 commands Tauri novos em `commands.rs`. 2 tests rejeitando service inválido + range inválido.
```

`src/types/.agent.md`:
```
- 2026-05-08 (Sprint B3): `costs.ts` novo. `CostService` (vercel|gh_actions|hetzner), `CostUnit` (bytes|minutes|count|usd), `CostUsage`, `CostHistoryPoint`. Helpers `pctColor()` (verde/amber/vermelho/cinza), `formatCostValue(value, unit)`. `COST_THRESHOLDS = { warning: 70, danger: 90 }`.
```

`src/lib/.agent.md`:
```
- 2026-05-08 (Sprint B3): `monitorApi.costSummary()` e `monitorApi.costHistory(service, metric, sinceIso, untilIso)` adicionados.
```

`src/components/.agent.md`:
```
- 2026-05-08 (Sprint B3): aba Custos completa. `CostTab` (orquestrador, polling 60s), `CostServiceCard` (card por serviço, lista métricas ordenadas por pct desc), `CostUsageBar` (barra horizontal com pctColor 4-state), `CostHistoryChart` (Recharts LineChart 30d, default = primeira métrica em alerta ou bandwidth Vercel), `CostChip` (topbar, render só quando dangerCount > 0).
```

- [ ] **Step 2: Commit**

```bash
git add src-tauri/crates/monitor-shared/.agent.md \
        src-tauri/crates/monitor-agent/src/collectors/.agent.md \
        src-tauri/src/monitor/.agent.md \
        src/types/.agent.md \
        src/lib/.agent.md \
        src/components/.agent.md
git commit -m "docs(agent): registrar Sprint B3 nas pastas tocadas"
```

---

# Fase 10 — Documentação top-level

### Task 19: CLAUDE.md + VALIDATION.md + skill

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/vm-migrations/VALIDATION.md`
- Modify: `~/.claude/skills/falcao-launcher/SKILL.md`

- [ ] **Step 1: Adicionar seção em `CLAUDE.md`**

Localizar a seção "Feature: Snyk-like — vulnerabilidades cross-repo (Sprint B1)" e adicionar logo abaixo:

```markdown
## Feature: Monitor de custos multi-serviço (Sprint B3)

Aba **"Custos"** no topbar entre Segurança e VM. Agrega Vercel + GitHub Actions + Hetzner em hypertable nova `external_metrics`.

- Coletores Rust no `monitor-agent` (v0.3.0) tick 1h: `vercel_usage` (GET /v1/usage → bandwidth + build_minutes + image_optimization + function_invocations) e `gh_actions` (GET /users/Falkzera/settings/billing/actions → minutes_used).
- Coletor `hetzner.rs` espelha `cost_accumulated_usd` em `external_metrics` (mantém INSERT em `metrics` pra compat com `VmHeader` existente).
- Tokens reusados: `VERCEL_TOKEN` (Sprint 2) + `GH_PAT_SECURITY` (Sprint B1) em `/home/falcao/.config/falcao-monitor/.env` na VM.
- Schema heterogêneo: `(ts, service, metric, value, quota, unit, period_start)`. Compression 7d, retention 90d. UPSERT em `(ts, service, metric)`.
- Thresholds: amber 70%, vermelho 90%. Chip danger acende na topbar quando alguma métrica passa 90%.

### Componentes novos (Sprint B3)
- `src/components/CostTab.tsx` — orquestrador (3 cards + chart histórico)
- `src/components/CostServiceCard.tsx` — card por serviço com lista de métricas
- `src/components/CostUsageBar.tsx` — barra colorida com pctColor 4-state
- `src/components/CostHistoryChart.tsx` — Recharts LineChart 30d
- `src/components/CostChip.tsx` — chip danger na topbar

### Backend novo
- `src-tauri/src/monitor/costs.rs` — `cost_summary()` + `cost_history()`
- 2 commands Tauri: `monitor_cost_summary`, `monitor_cost_history`

### Migration
- `docs/superpowers/vm-migrations/009_external_metrics.sql`
```

E na linha do "Estado conhecido" perto do fim do arquivo, atualizar a lista de "Features atuais" pra incluir "Monitor de custos multi-serviço (Sprint B3)".

- [ ] **Step 2: Adicionar seção em `VALIDATION.md`**

Adicionar:

```markdown
## Sprint B3 — Monitor de custos multi-serviço (2026-05-08)

### Migration

```bash
scp docs/superpowers/vm-migrations/009_external_metrics.sql falcao@162.55.217.189:/tmp/
ssh falcao@162.55.217.189 'docker exec -i falcao-monitor-db psql -U postgres -d monitor < /tmp/009_external_metrics.sql'
```

Verificar:

```bash
ssh falcao@162.55.217.189 \
  'docker exec falcao-monitor-db psql -U postgres -d monitor -c "\d+ external_metrics"'
```

Esperado: hypertable com índices `idx_external_metrics_lookup`, compression policy 7d, retention 90d, grants reader/writer.

### Tokens

Já existem em `/home/falcao/.config/falcao-monitor/.env` na VM (Sprints 2 + B1). Variáveis:
- `VERCEL_TOKEN` (read-only Hobby)
- `GH_PAT_SECURITY` (PAT clássico com scope `read:user` + `repo` pra Sprint B1; cobre billing endpoint)

Verificar `cat ~/.config/falcao-monitor/.env | grep -E '^(VERCEL_TOKEN|GH_PAT)' | wc -l` → 2.

### Deploy do agente v0.3.0

```bash
./scripts/deploy-monitor-agent.sh
```

Verificar versão:

```bash
ssh falcao@162.55.217.189 \
  'systemctl --user status falcao-monitor-agent.service --no-pager | head -10'
```

E logs do primeiro tick (esperar 1h ou ler logs após restart):

```bash
ssh falcao@162.55.217.189 \
  'journalctl --user -u falcao-monitor-agent.service --since "5 minutes ago" | grep -E "(vercel_usage|gh_actions|hetzner: insert)"'
```

Esperado: linhas `INFO ... vercel_usage: persisted` e `INFO ... gh_actions: persisted` após 1h.

### Smoke test no DB

```bash
ssh falcao@162.55.217.189 \
  'docker exec falcao-monitor-db psql -U postgres -d monitor \
   -c "SELECT service, metric, value, quota, ts FROM external_metrics ORDER BY ts DESC LIMIT 20;"'
```

Esperado:
- Linhas pra `service='hetzner', metric='cost_accumulated_usd'` aparecem ~15s após restart (loop principal).
- Linhas pra `service='vercel'` (4 métricas) e `service='gh_actions'` (1 métrica) aparecem após o primeiro tick de 1h.

### Smoke test no launcher

1. Build + reinstalar: `pnpm tauri build --bundles deb,rpm && rm ~/.local/bin/falcao-launcher && cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher`.
2. Abrir launcher → aba **Custos**.
3. Esperado: 3 cards (Vercel · GH Actions · Hetzner) com pelo menos uma barra cada (Hetzner já populado, Vercel/GH em até 1h).
4. Forçar danger pra teste manual: `UPDATE external_metrics SET quota=0.01 WHERE service='hetzner' LIMIT 1;` → reabrir launcher → chip vermelho aparece na topbar próximo a "Custos". Reverter depois.
```

- [ ] **Step 3: Adicionar entrada na skill**

Em `~/.claude/skills/falcao-launcher/SKILL.md`, adicionar uma sessão de diário:

```markdown
### Sprint B3 (2026-05-08) — Custos multi-serviço

Aba "Custos" no topbar agrega Vercel `/v1/usage` + GH Actions billing + Hetzner cost. Hypertable `external_metrics` heterogênea (service+metric+value+quota+unit+period_start). 2 coletores novos no agente v0.3.0 tick 1h. Hetzner espelha `cost_accumulated_usd`. Thresholds 70%/90% com chip danger na topbar. Spec: `docs/superpowers/specs/2026-05-08-cost-monitor-design.md`. Plan: `docs/superpowers/plans/2026-05-08-cost-monitor.md`. Migration: `009_external_metrics.sql`.
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/vm-migrations/VALIDATION.md
git commit -m "docs: registrar Sprint B3 (Custos) em CLAUDE.md + VALIDATION.md"
```

(Skill vive fora do repo — commit separado se quiser tracking.)

---

# Fase 11 — Deploy + validação end-to-end na VM

> **Done quando:** após 1h, `psql` mostra linhas Vercel + GH em `external_metrics` e launcher exibe valores reais.

### Task 20: Deploy do agente v0.3.0

- [ ] **Step 1: Build + deploy**

```bash
./scripts/deploy-monitor-agent.sh
```

Expected: log `✓ Deploy concluído`.

- [ ] **Step 2: Verificar health do agente**

```bash
ssh falcao@162.55.217.189 'systemctl --user status falcao-monitor-agent.service --no-pager'
```

Expected: `Active: active (running)`. `Main PID:` recente.

- [ ] **Step 3: Tail logs por 5 min — verificar que não crashou**

```bash
ssh falcao@162.55.217.189 'journalctl --user -u falcao-monitor-agent.service --since "5 min ago" -f' &
# Ctrl+C após uns 2 min
```

Expected: log `falcao-monitor-agent starting version=0.3.0` + ticks regulares de 15s do loop principal + warn se `GH_PAT_SECURITY` faltar (improvável). **Sem panic, sem stack trace**.

- [ ] **Step 4: Confirmar primeira amostra hetzner em `external_metrics`**

Após ~1 min:

```bash
ssh falcao@162.55.217.189 \
  'docker exec falcao-monitor-db psql -U postgres -d monitor \
   -c "SELECT service, metric, value, ts FROM external_metrics WHERE service=\"hetzner\" ORDER BY ts DESC LIMIT 5;"'
```

Expected: pelo menos 1 linha com `service=hetzner, metric=cost_accumulated_usd`.

- [ ] **Step 5: Esperar 1h, conferir Vercel + GH**

Pode pular pra task 21 nesse meio-tempo. Após 1h:

```bash
ssh falcao@162.55.217.189 \
  'docker exec falcao-monitor-db psql -U postgres -d monitor \
   -c "SELECT service, metric, value, quota FROM external_metrics WHERE ts > now() - interval \"2 hours\" ORDER BY service, metric;"'
```

Expected: 4 linhas Vercel + 1 linha GH Actions + 1 linha Hetzner = 6 linhas (mínimo).

> Se `vercel_usage` retornar 0 linhas: confere o log `journalctl ... | grep vercel_usage` — provável que o shape do `/v1/usage` seja diferente do que a fixture assume. Salvar o body real (`tracing::debug!("vercel_usage: body = {body:?}");` na primeira chamada) e ajustar `parse_usage`.

- [ ] **Step 6: Smoke test launcher**

```bash
pnpm tauri build --bundles deb,rpm
rm ~/.local/bin/falcao-launcher
cp src-tauri/target/release/falcao-launcher ~/.local/bin/falcao-launcher
```

Lançar via Activities → Falcão Launcher → aba **Custos**. Confirmar:
- 3 cards renderizam.
- Hetzner mostra valor em USD.
- Vercel + GH mostram valores não-zero (após 1h).
- Selectbox do `CostHistoryChart` lista todas as métricas; trocar mostra dados.

---

# Fase 12 — PR

### Task 21: Abrir Pull Request

- [ ] **Step 1: Push da branch**

```bash
git push -u origin feature/cost-monitor
```

- [ ] **Step 2: Criar PR**

```bash
gh pr create --title "feat(monitor): Sprint B3 — Custos multi-serviço (Vercel + GH Actions + Hetzner)" --body "$(cat <<'EOF'
## Summary

- Hypertable nova `external_metrics` (heterogênea, retention 90d, compression 7d)
- 2 coletores Rust no `monitor-agent` v0.3.0 tick 1h: `vercel_usage` (GET /v1/usage → 4 métricas) + `gh_actions` (GET /users/{user}/settings/billing/actions → 1 métrica)
- `hetzner.rs` espelha `cost_accumulated_usd` em `external_metrics` (mantém INSERT em `metrics`)
- Aba "Custos" no topbar com 3 cards de serviço, barra colorida (verde/amber/vermelho a 70%/90%), chart histórico Recharts 30d e chip danger na topbar
- 2 commands Tauri novos (`monitor_cost_summary`, `monitor_cost_history`)

Spec: `docs/superpowers/specs/2026-05-08-cost-monitor-design.md`
Plan: `docs/superpowers/plans/2026-05-08-cost-monitor.md`

## Test plan
- [x] `cargo test -p monitor-agent` (parser tests Vercel/GH/Hetzner)
- [x] `cargo test -p falcao-launcher costs` (validations cost_history)
- [x] `pnpm exec tsc --noEmit` clean
- [x] Migration aplicada na VM
- [x] Agente v0.3.0 deployado, sem crash em 10min de logs
- [x] Hetzner mirror grava em `external_metrics` em <1min
- [ ] Vercel/GH gravam em `external_metrics` após 1h (validar pós-merge)
- [x] Aba Custos renderiza 3 cards + chart sem erro
- [x] Chip danger acende quando UPDATE força quota baixa (manual)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: URL do PR.

---

## Self-review

**Spec coverage:**
- ✅ D1 schema único `external_metrics` → Task 1 (migration) + Task 6 (insert)
- ✅ D2 coletores `vercel_usage` + `gh_actions` no agente → Tasks 3, 4, 7
- ✅ D3 INSERT pipeline com UPSERT → Task 6
- ✅ D4 backend `costs.rs` + 2 commands → Tasks 8, 9
- ✅ D5 espelhamento Hetzner → Task 5
- ✅ D6 aba Custos no topbar com 5 componentes → Tasks 12-17
- ✅ D7 tipos compartilhados frontend → Task 10
- ✅ D8 reuso de tokens existentes → Task 7 + VALIDATION.md
- ✅ Não-objetivos respeitados: sem Supabase, sem Telegram, sem dismiss, sem multi-team
- ✅ Tratamento de erros: degradação graceful sem token (Task 7) + 401/403 logado mas não derruba (parser permissivo)
- ✅ Testes: parsers Rust com fixtures, validações de query, manual UI

**Placeholder scan:** revisei — sem TBD/TODO sem ação concreta. Notas marcadas com ⚠ são guias pro implementador (não placeholders).

**Type consistency:**
- `ExternalMetric` (Rust shared) ↔ `CostUsage` (Rust backend) ↔ `CostUsage` (TS) — campos casam (snake_case Rust → snake_case Tauri-serialized JSON → camelCase em alguns campos? **NÃO**: `period_start` em Rust = `period_start` em TS porque Tauri serializa structs em snake_case. Confirmado em CLAUDE.md.)
- `monitorApi.costSummary()` retorna `CostUsage[]` — bate com command `monitor_cost_summary` retornando `Vec<CostUsage>`.
- `monitorApi.costHistory(service, metric, sinceIso, untilIso)` — args camelCase no JS são auto-convertidos pra `since_iso`/`until_iso` no Rust pelo Tauri (auto-convert apenas em **args**, não em payloads de retorno).

**Scope check:** uma sprint, três coletores, uma tabela, uma aba. Singular implementation plan. Aprovado.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-08-cost-monitor.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Eu disparo um subagent por task, faço review entre tasks, iteração rápida. Tasks 3-7 (Rust agente) podem rodar em paralelo com Tasks 10-17 (frontend) via worktrees disjuntas.

**2. Inline Execution** — Executo as tasks nesta sessão usando executing-plans, com checkpoints pra review.

**Qual abordagem?**
