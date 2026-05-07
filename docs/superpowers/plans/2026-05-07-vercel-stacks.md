# Sprint 2 — Vercel stacks (frontend + backend agrupados) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adicionar dimensão Vercel ao monitor, agrupando frontend (Vercel) + backend (container Docker) numa visão unificada "stack em produção" via Docker label declarativa. Deploy automático: novos projetos com a label aparecem sem mudança no launcher.

**Architecture:** Agente Rust v0.2.0 ganha task paralela (poll 5min) que chama Vercel REST API e persiste em tabela nova `vercel_deployments`. Container collector lê labels via `docker inspect` e propaga `monitor.stack` no campo `labels` do `MetricRow`. Launcher cruza as duas dimensões em query-time e renderiza StackCards na aba VM.

**Tech Stack:** Rust (tokio, reqwest, serde, anyhow) + Postgres+TimescaleDB (já existe na VM) + Docker labels + Tauri 2 + React 19.

**Spec source:** `docs/superpowers/specs/2026-05-07-vercel-stacks-design.md`

**Branch:** `feature/vercel-stacks` (criar a partir de `main` no início).

---

## Phase A — Database migration

Tabela nova `vercel_deployments` na VM. Reutiliza `apply-vm-migrations.sh` existente.

### Task A1: Criar e aplicar migration 007

**Files:**
- Create: `docs/superpowers/vm-migrations/007_vercel_deployments.sql`

- [ ] **Step 1: Criar branch e migration localmente**

```bash
cd ~/Projects/falcao-launcher
git checkout main && git pull
git checkout -b feature/vercel-stacks
```

Criar `docs/superpowers/vm-migrations/007_vercel_deployments.sql` com:

```sql
-- Tabela dedicada pra deploys da Vercel (heterogênea — não cabe em metrics genérica).
CREATE TABLE IF NOT EXISTS vercel_deployments (
  ts            TIMESTAMPTZ NOT NULL,
  project_id    TEXT        NOT NULL,
  project_name  TEXT        NOT NULL,
  deployment_id TEXT        NOT NULL,
  state         TEXT        NOT NULL,
  url           TEXT,
  prod_url      TEXT,
  branch        TEXT,
  commit_sha    TEXT,
  commit_msg    TEXT,
  author        TEXT,
  created_at    TIMESTAMPTZ,
  ready_at      TIMESTAMPTZ,
  build_ms      INT
);

SELECT create_hypertable('vercel_deployments', 'ts', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS idx_vercel_deployments_lookup
  ON vercel_deployments (project_name, ts DESC);

CREATE INDEX IF NOT EXISTS idx_vercel_deployments_deployment_id
  ON vercel_deployments (deployment_id);

ALTER TABLE vercel_deployments SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_name'
);

SELECT add_compression_policy('vercel_deployments', INTERVAL '7 days', if_not_exists => TRUE);
SELECT add_retention_policy('vercel_deployments', INTERVAL '90 days', if_not_exists => TRUE);

-- Grants
GRANT SELECT ON vercel_deployments TO monitor_reader;
GRANT INSERT, SELECT ON vercel_deployments TO monitor_writer;
```

- [ ] **Step 2: Aplicar migration em modo dry-run primeiro**

```bash
./scripts/apply-vm-migrations.sh --dry-run
```

Expected: lista 007 como pendente, nenhuma execução.

- [ ] **Step 3: Aplicar migration de verdade**

```bash
./scripts/apply-vm-migrations.sh
```

Expected: 007 aplicada, registrada em `schema_migrations`.

- [ ] **Step 4: Validar tabela existe e tem grants**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c '\dt vercel_deployments' -c '\dp vercel_deployments'"
```

Expected: tabela listada, grants `monitor_reader=r/monitor_writer=ar` visíveis.

- [ ] **Step 5: Commit migration**

```bash
git add docs/superpowers/vm-migrations/007_vercel_deployments.sql
git commit -m "feat(monitor): migration 007 — vercel_deployments hypertable

- Tabela dedicada pra histórico de deploys Vercel (heterogênea)
- Hypertable TimescaleDB, retention 90d, compression 7d
- Indexes pra lookup por project_name e deployment_id
- Grants alinhados com tabelas existentes"
```

---

## Phase B — Agent v0.2.0 (Vercel collector + label propagation)

Coletor novo + bump versão + label reading no container collector.

### Task B1: Adicionar reqwest ao Cargo.toml do agente

**Files:**
- Edit: `src-tauri/Cargo.toml` (workspace deps)
- Edit: `src-tauri/crates/monitor-agent/Cargo.toml`

- [ ] **Step 1: Adicionar reqwest no workspace**

Em `src-tauri/Cargo.toml` (`[workspace.dependencies]`):

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

`default-features = false` + `rustls-tls` evita pulling em `openssl` (deps nativa). Build mais limpo.

- [ ] **Step 2: Usar reqwest no monitor-agent**

Em `src-tauri/crates/monitor-agent/Cargo.toml`:

```toml
[dependencies]
# ... existentes ...
reqwest = { workspace = true }
```

- [ ] **Step 3: Bump version pra 0.2.0**

Em `src-tauri/crates/monitor-agent/Cargo.toml`:
```toml
version = "0.2.0"
```

- [ ] **Step 4: Build smoke test**

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin falcao-monitor-agent
```

Expected: compila sem warnings novos.

### Task B2: Adicionar `VercelDeployment` em monitor-shared

**Files:**
- Edit: `src-tauri/crates/monitor-shared/src/lib.rs`

- [ ] **Step 1: Adicionar struct e variant Vercel ao enum MetricSource**

```rust
// Em monitor-shared/src/lib.rs

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricSource {
    Vm,
    Container,
    Hetzner,
    Vercel,  // NEW
}

impl MetricSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            MetricSource::Vm => "vm",
            MetricSource::Container => "container",
            MetricSource::Hetzner => "hetzner",
            MetricSource::Vercel => "vercel",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VercelDeployment {
    pub ts: DateTime<Utc>,
    pub project_id: String,
    pub project_name: String,
    pub deployment_id: String,
    pub state: String,
    pub url: Option<String>,
    pub prod_url: Option<String>,
    pub branch: Option<String>,
    pub commit_sha: Option<String>,
    pub commit_msg: Option<String>,
    pub author: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub ready_at: Option<DateTime<Utc>>,
    pub build_ms: Option<i32>,
}
```

- [ ] **Step 2: Build verifica**

```bash
cargo build --manifest-path src-tauri/Cargo.toml -p monitor-shared
```

Expected: compila.

### Task B3: Implementar `collectors/vercel.rs`

**Files:**
- Create: `src-tauri/crates/monitor-agent/src/collectors/vercel.rs`
- Edit: `src-tauri/crates/monitor-agent/src/collectors/mod.rs`

- [ ] **Step 1: Adicionar `pub mod vercel;` em mod.rs**

- [ ] **Step 2: Escrever vercel.rs**

Estrutura:
```rust
//! Coletor Vercel via REST API (https://api.vercel.com).
//!
//! Lista todos os projetos da conta + último deploy de cada um.
//! Roda fora do loop de 15s — task separada com tick de 5min.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::VercelDeployment;
use reqwest::Client;
use serde_json::Value;
use tracing::warn;

const API_BASE: &str = "https://api.vercel.com";

pub async fn collect(
    ts: DateTime<Utc>,
    client: &Client,
    token: &str,
) -> Result<Vec<VercelDeployment>> {
    // 1. GET /v9/projects → ids+nomes
    let projects = fetch_projects(client, token).await?;
    let mut out = Vec::with_capacity(projects.len());

    // 2. Pra cada projeto, pega último deploy
    for (id, name) in projects {
        match fetch_latest_deployment(client, token, &id).await {
            Ok(Some(deployment_json)) => {
                if let Some(row) = parse_deployment(ts, &id, &name, &deployment_json) {
                    out.push(row);
                }
            }
            Ok(None) => {} // projeto sem deploys ainda — pula sem warn
            Err(e) => warn!("vercel: fetch deployments {name} ({id}) failed: {e}"),
        }
    }
    Ok(out)
}

async fn fetch_projects(client: &Client, token: &str) -> Result<Vec<(String, String)>> {
    let resp = client
        .get(format!("{API_BASE}/v9/projects?limit=100"))
        .bearer_auth(token)
        .send()
        .await
        .context("GET /v9/projects")?;
    log_rate_limit(&resp);
    let body: Value = resp.error_for_status()?.json().await?;
    Ok(parse_projects_response(&body))
}

async fn fetch_latest_deployment(
    client: &Client,
    token: &str,
    project_id: &str,
) -> Result<Option<Value>> {
    let resp = client
        .get(format!(
            "{API_BASE}/v6/deployments?projectId={project_id}&limit=1"
        ))
        .bearer_auth(token)
        .send()
        .await
        .context("GET /v6/deployments")?;
    log_rate_limit(&resp);
    let body: Value = resp.error_for_status()?.json().await?;
    Ok(body
        .get("deployments")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first().cloned()))
}

fn log_rate_limit(resp: &reqwest::Response) {
    if let Some(remaining) = resp
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<i32>().ok())
    {
        if remaining < 10 {
            warn!("vercel: rate limit low — remaining={remaining}");
        }
    }
}

fn parse_projects_response(body: &Value) -> Vec<(String, String)> {
    body.get("projects")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let id = p.get("id")?.as_str()?.to_string();
                    let name = p.get("name")?.as_str()?.to_string();
                    Some((id, name))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn parse_deployment(
    ts: DateTime<Utc>,
    project_id: &str,
    project_name: &str,
    d: &Value,
) -> Option<VercelDeployment> {
    let deployment_id = d.get("uid").and_then(Value::as_str)?.to_string();
    let state = d.get("state").and_then(Value::as_str)?.to_string();

    let created_at = d
        .get("createdAt")
        .and_then(Value::as_i64)
        .and_then(ts_from_millis);
    let ready_at = d
        .get("ready")
        .and_then(Value::as_i64)
        .and_then(ts_from_millis);
    let build_ms = match (created_at, ready_at) {
        (Some(c), Some(r)) => i32::try_from((r - c).num_milliseconds()).ok(),
        _ => None,
    };

    let meta = d.get("meta");
    Some(VercelDeployment {
        ts,
        project_id: project_id.to_string(),
        project_name: project_name.to_string(),
        deployment_id,
        state,
        url: d.get("url").and_then(Value::as_str).map(String::from),
        prod_url: meta
            .and_then(|m| m.get("alias"))
            .and_then(|a| a.as_array())
            .and_then(|arr| arr.first())
            .and_then(Value::as_str)
            .map(String::from),
        branch: meta
            .and_then(|m| m.get("githubCommitRef"))
            .and_then(Value::as_str)
            .map(String::from),
        commit_sha: meta
            .and_then(|m| m.get("githubCommitSha"))
            .and_then(Value::as_str)
            .map(String::from),
        commit_msg: meta
            .and_then(|m| m.get("githubCommitMessage"))
            .and_then(Value::as_str)
            .map(String::from),
        author: meta
            .and_then(|m| m.get("githubCommitAuthorName"))
            .and_then(Value::as_str)
            .map(String::from),
        created_at,
        ready_at,
        build_ms,
    })
}

fn ts_from_millis(ms: i64) -> Option<DateTime<Utc>> {
    DateTime::<Utc>::from_timestamp_millis(ms)
}
```

- [ ] **Step 3: Adicionar testes ao final de vercel.rs**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_projects_list() {
        let body = json!({
            "projects": [
                {"id": "prj_abc", "name": "falcao-financas"},
                {"id": "prj_def", "name": "outro"}
            ]
        });
        let parsed = parse_projects_response(&body);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].1, "falcao-financas");
    }

    #[test]
    fn parses_deployment_ready_with_meta() {
        let ts = Utc::now();
        let d = json!({
            "uid": "dpl_xyz",
            "state": "READY",
            "url": "falcao-financas-abc.vercel.app",
            "createdAt": 1714600000000_i64,
            "ready": 1714600060000_i64,
            "meta": {
                "githubCommitRef": "main",
                "githubCommitSha": "abcd1234",
                "githubCommitMessage": "fix: ajuste",
                "githubCommitAuthorName": "Falkzera",
                "alias": ["falcao-financas.vercel.app"]
            }
        });
        let r = parse_deployment(ts, "prj_abc", "falcao-financas", &d).unwrap();
        assert_eq!(r.state, "READY");
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.commit_sha.as_deref(), Some("abcd1234"));
        assert_eq!(r.build_ms, Some(60000));
    }

    #[test]
    fn parses_deployment_building_no_ready() {
        let ts = Utc::now();
        let d = json!({
            "uid": "dpl_b",
            "state": "BUILDING",
            "createdAt": 1714600000000_i64
        });
        let r = parse_deployment(ts, "prj_abc", "falcao-financas", &d).unwrap();
        assert_eq!(r.state, "BUILDING");
        assert_eq!(r.ready_at, None);
        assert_eq!(r.build_ms, None);
    }

    #[test]
    fn missing_uid_returns_none() {
        let ts = Utc::now();
        let d = json!({"state": "READY"});
        assert!(parse_deployment(ts, "prj_abc", "x", &d).is_none());
    }

    #[test]
    fn empty_projects_response() {
        let body = json!({});
        let parsed = parse_projects_response(&body);
        assert!(parsed.is_empty());
    }
}
```

- [ ] **Step 4: Rodar testes**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p monitor-agent
```

Expected: todos passam, incluindo os novos.

### Task B4: Modificar container.rs pra ler labels

**Files:**
- Edit: `src-tauri/crates/monitor-agent/src/collectors/container.rs`

- [ ] **Step 1: Ler arquivo atual e identificar onde labels seriam propagadas**

```bash
cat src-tauri/crates/monitor-agent/src/collectors/container.rs
```

- [ ] **Step 2: Adicionar leitura de labels via `docker inspect`**

Estratégia: depois de obter lista de containers ativos via `docker stats`, fazer 1 chamada `docker inspect <container1> <container2> ... --format '{{.Name}} {{json .Config.Labels}}'` (batch único, evita N spawns).

Pseudo-código:
```rust
async fn fetch_labels(names: &[String]) -> Result<HashMap<String, JsonValue>> {
    if names.is_empty() { return Ok(HashMap::new()); }
    let output = Command::new("docker")
        .arg("inspect")
        .args(names)
        .arg("--format")
        .arg("{{.Name}}\t{{json .Config.Labels}}")
        .output()
        .await
        .context("docker inspect")?;
    if !output.status.success() {
        anyhow::bail!("docker inspect failed: {}", String::from_utf8_lossy(&output.stderr));
    }
    let mut out = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let mut parts = line.splitn(2, '\t');
        let name = parts.next().unwrap_or("").trim_start_matches('/').to_string();
        if let Some(json_str) = parts.next() {
            if let Ok(labels) = serde_json::from_str::<JsonValue>(json_str) {
                out.insert(name, labels);
            }
        }
    }
    Ok(out)
}

fn extract_stack(labels: &JsonValue) -> Option<String> {
    labels.get("monitor.stack")?.as_str().map(String::from)
}
```

- [ ] **Step 3: Propagar `stack` no campo `labels` do MetricRow**

Quando montar cada `MetricRow` pra container, preencher:
```rust
let stack = container_labels.get(name).and_then(extract_stack);
let labels_json = stack.map(|s| serde_json::json!({"stack": s}));
MetricRow {
    // ...
    labels: labels_json,
    // ...
}
```

- [ ] **Step 4: Testes**

Adicionar teste pro `extract_stack`:
```rust
#[test]
fn extracts_monitor_stack_label() {
    let labels = serde_json::json!({"monitor.stack": "falcao-financas", "other": "x"});
    assert_eq!(extract_stack(&labels).as_deref(), Some("falcao-financas"));
}
#[test]
fn no_label_returns_none() {
    let labels = serde_json::json!({"other": "x"});
    assert!(extract_stack(&labels).is_none());
}
```

- [ ] **Step 5: Build + test**

```bash
cargo test --manifest-path src-tauri/Cargo.toml -p monitor-agent
```

Expected: passa.

### Task B5: Persistência de vercel_deployments + integração no main.rs

**Files:**
- Edit: `src-tauri/crates/monitor-agent/src/main.rs`
- (Provavelmente também) Edit: `src-tauri/crates/monitor-agent/src/db.rs` ou similar

- [ ] **Step 1: Identificar onde estão os INSERTs atuais**

```bash
grep -n "INSERT INTO" src-tauri/crates/monitor-agent/src/*.rs
```

- [ ] **Step 2: Adicionar função `insert_vercel_deployments`**

Padrão: receber `&[VercelDeployment]` + `&Pool`, fazer INSERT em batch (uma transaction). Se vazio, return cedo.

```rust
pub async fn insert_vercel_deployments(
    pool: &Pool,
    rows: &[VercelDeployment],
) -> Result<()> {
    if rows.is_empty() { return Ok(()); }
    let mut client = pool.get().await?;
    let tx = client.transaction().await?;
    let stmt = tx
        .prepare(
            "INSERT INTO vercel_deployments
             (ts, project_id, project_name, deployment_id, state, url, prod_url,
              branch, commit_sha, commit_msg, author, created_at, ready_at, build_ms)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)"
        )
        .await?;
    for r in rows {
        tx.execute(&stmt, &[
            &r.ts, &r.project_id, &r.project_name, &r.deployment_id, &r.state,
            &r.url, &r.prod_url, &r.branch, &r.commit_sha, &r.commit_msg,
            &r.author, &r.created_at, &r.ready_at, &r.build_ms
        ]).await?;
    }
    tx.commit().await?;
    Ok(())
}
```

- [ ] **Step 3: Spawnar task paralela 5min em main.rs**

```rust
// Em main.rs, após o setup do pool:
let vercel_token = std::env::var("VERCEL_TOKEN").ok();
if vercel_token.is_some() {
    info!("vercel: token presente — coletor habilitado");
} else {
    warn!("vercel: VERCEL_TOKEN ausente — coletor desabilitado");
}

if let Some(token) = vercel_token {
    let pool_clone = pool.clone();
    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()?;
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(300));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // primeiro tick é imediato — força coleta inicial
        loop {
            tick.tick().await;
            match collectors::vercel::collect(Utc::now(), &http, &token).await {
                Ok(rows) => {
                    if !rows.is_empty() {
                        if let Err(e) = insert_vercel_deployments(&pool_clone, &rows).await {
                            warn!("vercel: insert failed: {e}");
                        } else {
                            info!("vercel: persisted {} deployments", rows.len());
                        }
                    }
                }
                Err(e) => warn!("vercel: collect failed: {e}"),
            }
        }
    });
}
```

- [ ] **Step 4: Build local**

```bash
cargo build --release --manifest-path src-tauri/Cargo.toml --bin falcao-monitor-agent
```

Expected: build limpo.

- [ ] **Step 5: Smoke test local sem token (deve degradar gracefully)**

```bash
unset VERCEL_TOKEN
./src-tauri/target/release/falcao-monitor-agent --help 2>&1 | head -5
# (binário pode não ter --help; basta confirmar que linka)
```

- [ ] **Step 6: Commit phase B**

```bash
git add -A
git commit -m "feat(monitor): coletor Vercel + label propagation no container.rs

- monitor-shared: variant Vercel + struct VercelDeployment
- monitor-agent v0.2.0: novo collector vercel.rs (REST API, poll 5min)
- container.rs: lê monitor.stack via docker inspect e propaga em labels
- INSERT batch transactional pra vercel_deployments
- 7 testes unitários novos (parsing Vercel + extract_stack)
- reqwest com rustls-tls (sem deps em openssl native)"
```

---

## Phase C — VM setup + deploy

Configurar token, systemd unit, label no compose, deploy do binário novo.

### Task C1: Criar .env na VM com VERCEL_TOKEN

- [ ] **Step 1: Criar diretório**

```bash
ssh falcao@162.55.217.189 "mkdir -p ~/.config/falcao-monitor && chmod 700 ~/.config/falcao-monitor"
```

- [ ] **Step 2: Escrever .env via SSH (sem passar pelo log do chat)**

```bash
# Falcão executa local — substitui $TOKEN pelo valor real (ou paste-prompt do shell).
# Comando NÃO loga o token no histórico do shell se prefixado com espaço (HISTCONTROL=ignorespace).
read -s -p "Cola o VERCEL_TOKEN: " VTOK
ssh falcao@162.55.217.189 "umask 077 && echo 'VERCEL_TOKEN=$VTOK' > ~/.config/falcao-monitor/.env && chmod 600 ~/.config/falcao-monitor/.env"
unset VTOK
```

Expected: arquivo criado com 600.

- [ ] **Step 3: Validar permissão e conteúdo (sem expor token)**

```bash
ssh falcao@162.55.217.189 "ls -la ~/.config/falcao-monitor/.env && wc -c ~/.config/falcao-monitor/.env"
```

Expected: `-rw------- falcao falcao` + tamanho ~80 bytes.

### Task C2: Adicionar EnvironmentFile ao systemd unit

**Files (na VM):**
- Edit: `~/.config/systemd/user/falcao-monitor-agent.service`

- [ ] **Step 1: Ler unit atual**

```bash
ssh falcao@162.55.217.189 "cat ~/.config/systemd/user/falcao-monitor-agent.service"
```

- [ ] **Step 2: Adicionar `EnvironmentFile=` no [Service]**

Linha exata (com hífen prefixado pra missing-ok):
```ini
EnvironmentFile=-/home/falcao/.config/falcao-monitor/.env
```

Comando idempotente (adiciona se ausente):
```bash
ssh falcao@162.55.217.189 "grep -q 'EnvironmentFile=.*falcao-monitor' ~/.config/systemd/user/falcao-monitor-agent.service \
  || sed -i '/^\[Service\]/a EnvironmentFile=-/home/falcao/.config/falcao-monitor/.env' \
  ~/.config/systemd/user/falcao-monitor-agent.service"
ssh falcao@162.55.217.189 "grep -A1 '\[Service\]' ~/.config/systemd/user/falcao-monitor-agent.service | head -5"
```

- [ ] **Step 3: daemon-reload**

```bash
ssh falcao@162.55.217.189 "systemctl --user daemon-reload"
```

### Task C3: Adicionar label monitor.stack no docker-compose do falcao-financas

**Files (na VM):**
- Edit: `/opt/apps/falcao-financas/docker-compose.yml`

- [ ] **Step 1: Backup e leitura do compose atual**

```bash
ssh falcao@162.55.217.189 "cp /opt/apps/falcao-financas/docker-compose.yml /opt/apps/falcao-financas/docker-compose.yml.bak.$(date +%s) && cat /opt/apps/falcao-financas/docker-compose.yml"
```

- [ ] **Step 2: Adicionar label**

Edição manual (ou via sed em-place se compose for simples). Identificar o service do app e adicionar:

```yaml
services:
  app:  # ou "api", o que for
    # ...existente...
    labels:
      - monitor.stack=falcao-financas
```

Se já existe seção `labels:`, append. Se não existe, adicionar.

```bash
# Opção segura: editar via SSH com vi (ou copiar local, editar, scp de volta).
ssh -t falcao@162.55.217.189 "vi /opt/apps/falcao-financas/docker-compose.yml"
# Confirmar
ssh falcao@162.55.217.189 "grep -A2 'labels' /opt/apps/falcao-financas/docker-compose.yml"
```

- [ ] **Step 3: Recriar container com a label**

```bash
ssh falcao@162.55.217.189 "cd /opt/apps/falcao-financas && docker compose up -d"
```

Expected: container recriado (label só vale ao recriar — `up -d` detecta diff e recreia).

- [ ] **Step 4: Validar label no container ativo**

```bash
ssh falcao@162.55.217.189 "docker inspect falcao-financas --format '{{json .Config.Labels}}' | python3 -m json.tool | grep stack"
```

Expected: `"monitor.stack": "falcao-financas"`.

### Task C4: Deploy do agente v0.2.0

- [ ] **Step 1: Inspecionar deploy script existente**

```bash
cat scripts/deploy-monitor-agent.sh
```

- [ ] **Step 2: Rodar deploy (build local + scp + restart)**

```bash
./scripts/deploy-monitor-agent.sh
```

Expected: build release, scp pra VM, systemctl restart.

- [ ] **Step 3: Validar service ativo**

```bash
ssh falcao@162.55.217.189 "systemctl --user status falcao-monitor-agent.service --no-pager | head -15"
```

Expected: `active (running)`, sem erros recentes.

- [ ] **Step 4: Tail logs do agente — validar Vercel coletor habilitado**

```bash
ssh falcao@162.55.217.189 "journalctl --user -u falcao-monitor-agent.service --since '2 minutes ago' --no-pager | tail -30"
```

Expected:
- `vercel: token presente — coletor habilitado`
- Após ~5 min: `vercel: persisted N deployments`
- `container collected ... stack=falcao-financas` (ou similar)

- [ ] **Step 5: Validar dado chegando no DB (depois do primeiro tick de 5min)**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT project_name, state, branch, ready_at FROM vercel_deployments ORDER BY ts DESC LIMIT 5\""
```

Expected: pelo menos 1 row pra `falcao-financas`.

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT resource, labels FROM metrics WHERE source='container' AND ts > now() - interval '1 minute' AND labels IS NOT NULL LIMIT 5\""
```

Expected: pelo menos 1 row com `{"stack": "falcao-financas"}`.

- [ ] **Step 6: Commit (já feito local; só push pra branch)**

```bash
git push origin feature/vercel-stacks
```

---

## Phase D — Frontend launcher

Queries Rust + componentes React + integração na aba VM.

### Task D1: Queries SQL novas em monitor/queries.rs

**Files:**
- Edit: `src-tauri/src/monitor/queries.rs`
- Edit: `src-tauri/src/monitor/commands.rs`

- [ ] **Step 1: Ler estrutura atual**

```bash
cat src-tauri/src/monitor/queries.rs | head -100
```

- [ ] **Step 2: Adicionar tipos `StackSummary`, `StackDetail`, `VercelDeploymentRow`**

Em algum módulo TS-mirror existente (provavelmente `commands.rs` ou novo `stack.rs`):

```rust
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StackSummary {
    pub name: String,
    pub vercel_state: Option<String>,
    pub backend_running: bool,
    pub container_names: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct StackDetail {
    pub name: String,
    pub vercel: Option<VercelDeploymentRow>,
    pub containers: Vec<ContainerSnapshot>,
    pub endpoint_health: Option<HealthSummary>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VercelDeploymentRow {
    pub project_name: String,
    pub state: String,
    pub url: Option<String>,
    pub prod_url: Option<String>,
    pub branch: Option<String>,
    pub commit_msg: Option<String>,
    pub author: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub ready_at: Option<DateTime<Utc>>,
    pub build_ms: Option<i32>,
}
```

- [ ] **Step 3: Função `list_stacks`**

```sql
-- Stacks "vivas": tem Vercel deployments OU container ativo com label
WITH from_containers AS (
  SELECT DISTINCT labels->>'stack' AS name
  FROM metrics
  WHERE source = 'container'
    AND ts > now() - interval '5 minutes'
    AND labels ? 'stack'
),
from_vercel AS (
  SELECT DISTINCT project_name AS name
  FROM vercel_deployments
  WHERE ts > now() - interval '24 hours'
)
SELECT name FROM from_containers
UNION
SELECT name FROM from_vercel
ORDER BY name
```

Pra cada nome: query separada (ou JOIN) que pega state Vercel atual + se há container ativo.

- [ ] **Step 4: Função `stack_detail(name)`**

3 queries:
1. último Vercel deploy (ORDER BY ts DESC LIMIT 1) WHERE project_name=$1
2. último snapshot de container WHERE labels->>'stack'=$1 AND ts > now() - 1min
3. health endpoint matching pattern `*${name}*` (best-effort) pra mostrar uptime

- [ ] **Step 5: Comandos Tauri novos**

Em `commands.rs`:
```rust
#[tauri::command]
pub async fn monitor_list_stacks(/* ... */) -> Result<Vec<StackSummary>, String> { ... }

#[tauri::command]
pub async fn monitor_stack_detail(name: String, /* ... */) -> Result<StackDetail, String> { ... }
```

Registrar em `lib.rs` (`generate_handler!`).

- [ ] **Step 6: Build local + tsc**

```bash
cargo build --manifest-path src-tauri/Cargo.toml
pnpm exec tsc --noEmit
```

### Task D2: Tipos TS espelhando Rust

**Files:**
- Edit: `src/types/monitor.ts`

```typescript
export type VercelState = 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED' | string;

export interface VercelDeploymentRow {
  project_name: string;
  state: VercelState;
  url: string | null;
  prod_url: string | null;
  branch: string | null;
  commit_msg: string | null;
  author: string | null;
  created_at: string | null;  // ISO
  ready_at: string | null;
  build_ms: number | null;
}

export interface StackSummary {
  name: string;
  vercel_state: VercelState | null;
  backend_running: boolean;
  container_names: string[];
}

export interface StackDetail {
  name: string;
  vercel: VercelDeploymentRow | null;
  containers: ContainerSnapshot[];
  endpoint_health: HealthSummary | null;
}
```

### Task D3: Componentes React

**Files:**
- Create: `src/components/StackGrid.tsx`
- Create: `src/components/StackCard.tsx`
- Create: `src/components/VercelStatusBadge.tsx`
- Edit: `src/components/VmTab.tsx`
- Edit: `src/components/VmContainerGrid.tsx` (filtrar containers já em stack)

- [ ] **Step 1: VercelStatusBadge.tsx**

Simple component: cor baseado em state, label, opcional icon spinner pra BUILDING/QUEUED.

- [ ] **Step 2: StackCard.tsx**

Layout vertical: header (nome + bolinha agregada) → 3 sub-blocos:
1. Frontend Vercel (badge + "deploy 4h atrás · 1.2s build · main@abcd1234" + link)
2. Backend (CPU% + RAM% + uptime — usa UsageBar existente)
3. Endpoint (200 · 142ms · 99.94% / 30d — usa dados de health_checks)

- [ ] **Step 3: StackGrid.tsx**

Grid 1-2 col responsivo. Loading skeleton, empty state ("Nenhuma stack ativa — adicione `monitor.stack` ao docker-compose").

- [ ] **Step 4: Integrar no VmTab.tsx**

Section nova entre `<HealthChecksSection>` e `<TimeWindowSelector>`.

- [ ] **Step 5: Filtrar containers já agrupados em VmContainerGrid**

```typescript
const grouped = new Set(stacks.flatMap(s => s.container_names));
const orphans = containers.filter(c => !grouped.has(c.name));
```

Render só `orphans` na grid existente.

- [ ] **Step 6: Build + tsc + smoke test**

```bash
pnpm exec tsc --noEmit
pnpm tauri dev
```

Expected: launcher abre, aba VM mostra stack `falcao-financas`, containers `caddy` e `falcao-monitor-db` continuam visíveis na grid.

- [ ] **Step 7: Build release + reinstalar**

```bash
pnpm tauri build --bundles deb,rpm
rm -f ~/.local/bin/falcao-launcher
cp src-tauri/target/release/falcao-launcher ~/.local/bin/
```

- [ ] **Step 8: Commit phase D**

```bash
git add -A
git commit -m "feat(launcher): aba VM agora agrega frontend Vercel + backend container

- Queries Rust novas: list_stacks, stack_detail
- Comandos Tauri: monitor_list_stacks, monitor_stack_detail
- Tipos TS: StackSummary, StackDetail, VercelDeploymentRow, VercelState
- Componentes: StackGrid, StackCard, VercelStatusBadge
- Section 'Stacks em produção' acima da grid de containers
- Containers em stack são absorvidos do grid cru (sem duplicar)
- Empty state instrutivo (como adicionar monitor.stack ao compose)"
```

---

## Phase E — Validation, docs, PR

### Task E1: Atualizar agent.md das pastas tocadas

**Files (todos editados):**
- `src-tauri/crates/monitor-agent/src/collectors/.agent.md` (novo coletor vercel)
- `src-tauri/crates/monitor-shared/.agent.md` (variant Vercel + struct novo)
- `src-tauri/src/monitor/.agent.md` (queries+commands novos)
- `src/components/.agent.md` (StackGrid, StackCard, VercelStatusBadge)
- `src/types/.agent.md` (tipos Vercel)
- `docs/superpowers/vm-migrations/.agent.md` se existir (007)

- [ ] **Step 1: Verificar quais agent.md existem nessas pastas**

```bash
find src-tauri/crates src-tauri/src/monitor src/components src/types docs/superpowers -name '.agent.md' -o -name 'agent.md'
```

- [ ] **Step 2: Editar cada um, adicionando uma linha do escopo Vercel**

### Task E2: Atualizar CLAUDE.md

- [ ] Adicionar bullet em "Componentes frontend novos" listando `StackGrid.tsx`, `StackCard.tsx`, `VercelStatusBadge.tsx`.
- [ ] Atualizar seção "Crates novos" mencionando `vercel.rs` e bump v0.2.0.
- [ ] Tabela de agent.md continua válida (mesmas pastas).

### Task E3: Atualizar VALIDATION.md

Adicionar seção "Sprint 2 (Vercel stacks)" com:
- Acceptance criteria do spec, marcado ✅ pra cada
- Disk usage observado pós-sprint
- Volume de rows Vercel após 24h

### Task E4: Atualizar skill `falcao-launcher`

- [ ] Adicionar bloco "2026-05-07 — sessão 7 (Vercel stacks)" no diário de bordo
- [ ] Anotar gotchas descobertos durante implementação

### Task E5: PR

- [ ] Garantir branch `feature/vercel-stacks` está pushed
- [ ] Abrir PR pra main com descrição linkando spec + plan + recap

```bash
gh pr create --title "feat(monitor): Sprint 2 — Vercel stacks (frontend + backend agrupados)" --body "$(cat <<'EOF'
## Summary
- Coletor Vercel via REST API no monitor-agent v0.2.0
- Tabela nova `vercel_deployments` (hypertable, retention 90d)
- Container collector lê label `monitor.stack` e propaga em `metrics.labels`
- Aba VM ganha section 'Stacks em produção' agregando frontend Vercel + backend container + endpoint health
- Convenção: `monitor.stack=<nome>` no docker-compose declara agrupamento

## Spec & plan
- Spec: `docs/superpowers/specs/2026-05-07-vercel-stacks-design.md`
- Plan: `docs/superpowers/plans/2026-05-07-vercel-stacks.md`

## Acceptance
Todos os 12 critérios de aceite do spec validados — ver VALIDATION.md.

## Test plan
- [x] cargo test -p monitor-agent (incl. 5 testes novos do vercel.rs)
- [x] migration 007 aplicada via apply-vm-migrations.sh, idempotente
- [x] agente v0.2.0 deployado, journalctl sem erros, primeiro tick Vercel < 5min
- [x] launcher mostra StackCard `falcao-financas` com Vercel state + métricas backend
- [x] containers caddy/monitor-db ainda na grid crua

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Task E6: Aguardar merge do Falcão

PR pra main, Falcão decide.

---

## Resumo das phases

| Phase | Escopo | Tempo estimado |
|---|---|---|
| **A** | Migration 007 (DB) | ~15 min |
| **B** | Coletor Rust + label reading + persistência + main.rs | ~90 min |
| **C** | Setup VM (.env, systemd, compose, deploy) | ~30 min |
| **D** | Frontend (queries + componentes + integração) | ~90 min |
| **E** | Docs + PR | ~30 min |
| **Total** | | **~4-5h** |

## Riscos de execução

- Vercel API muda shape do JSON entre versões: testes cobrem casos comuns; defesas pra missing fields.
- Token Vercel rate limit em conta com muitos projetos: hoje só 1, sem risco. Quando crescer, considerar pagination + parallel cap.
- Recriar container pode causar downtime breve do `falcao-financas`. Compose `up -d` é < 5s. Aceito.
- Sintaxe sed pra adicionar EnvironmentFile pode quebrar em unit files com formatos diferentes. Mitigação: validar manualmente após sed.
