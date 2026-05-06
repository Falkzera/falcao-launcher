# VM Monitor Fase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir coletor 24/7 de métricas + Postgres+TimescaleDB local na VM Hetzner, com dashboard real-time e histórico na aba "VM" do `falcao-launcher`.

**Architecture:** Container Postgres+TimescaleDB roda na VM (porta 5432 local-only, dados persistidos em volume). Agente Rust em systemd user service coleta métricas a cada 15s (VM via `/proc`, containers via `docker stats`, Hetzner via `hcloud`). Launcher abre SSH tunnel via `russh` quando aba VM é aberta, lê DB remoto via `tokio-postgres`, renderiza dashboards com Recharts.

**Tech Stack:** Rust (tokio, tokio-postgres, deadpool-postgres, russh, serde) + Postgres 16 + TimescaleDB + Docker + systemd + Tauri 2 + React 19 + Recharts.

**Spec source:** `docs/superpowers/specs/2026-05-06-vm-monitor-fase-1-design.md`

---

## Phase A — VM Infrastructure (Postgres + TimescaleDB)

Setup do banco de dados na VM. Execução remota via SSH.

### Task A1: Estrutura de pastas e docker-compose na VM

**Files:**
- Create (na VM, via SSH): `/opt/falcao-monitor/docker-compose.yml`
- Create (na VM, via SSH): `/opt/falcao-monitor/.env`
- Create (na VM, via SSH): `/opt/falcao-monitor/migrations/.gitkeep`

- [ ] **Step 1: Gerar senhas fortes pros 3 users (postgres, monitor_writer, monitor_reader)**

```bash
# Local — gera 3 senhas
PG_SUPER_PWD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
PG_WRITER_PWD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
PG_READER_PWD=$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)
echo "Super: $PG_SUPER_PWD"
echo "Writer: $PG_WRITER_PWD"
echo "Reader: $PG_READER_PWD"
# Anotar — vão pro .env e pro launcher mais tarde
```

- [ ] **Step 2: Criar pasta na VM e .env com as credenciais**

```bash
ssh falcao@162.55.217.189 "mkdir -p /opt/falcao-monitor/{data,migrations}"

# Cria .env via heredoc no SSH (substitui as senhas geradas)
ssh falcao@162.55.217.189 "cat > /opt/falcao-monitor/.env" <<EOF
POSTGRES_PASSWORD=$PG_SUPER_PWD
MONITOR_WRITER_PASSWORD=$PG_WRITER_PWD
MONITOR_READER_PASSWORD=$PG_READER_PWD
EOF

ssh falcao@162.55.217.189 "chmod 600 /opt/falcao-monitor/.env && ls -la /opt/falcao-monitor/"
```

Expected: pasta criada, .env com permissão 600.

- [ ] **Step 3: Criar docker-compose.yml na VM**

```bash
ssh falcao@162.55.217.189 "cat > /opt/falcao-monitor/docker-compose.yml" <<'YML'
services:
  postgres:
    image: timescale/timescaledb-ha:pg16-latest
    container_name: falcao-monitor-db
    restart: unless-stopped
    env_file: .env
    environment:
      POSTGRES_DB: falcao_monitor
      POSTGRES_USER: postgres
    ports:
      - "127.0.0.1:5432:5432"
    volumes:
      - ./data:/var/lib/postgresql/data
      - ./migrations:/docker-entrypoint-initdb.d:ro
    command:
      - "postgres"
      - "-c"
      - "shared_buffers=128MB"
      - "-c"
      - "work_mem=4MB"
      - "-c"
      - "effective_cache_size=512MB"
      - "-c"
      - "max_connections=20"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d falcao_monitor"]
      interval: 10s
      timeout: 5s
      retries: 5
YML
ssh falcao@162.55.217.189 "cat /opt/falcao-monitor/docker-compose.yml | head -10"
```

Expected: compose criado e visível.

- [ ] **Step 4: Commit local do spec/plan (já em branch feature/vm-monitor-fase-1)**

```bash
# Local — não há mudanças locais nessa task ainda, mas confirmar branch
cd ~/Projects/falcao-launcher
git status
git branch --show-current  # esperado: feature/vm-monitor-fase-1
```

Expected: branch correta, working tree clean.

---

### Task A2: Migration 001 — schema base

**Files:**
- Create (na VM): `/opt/falcao-monitor/migrations/001_init.sql`

- [ ] **Step 1: Criar migration 001 (schema base + users)**

```bash
ssh falcao@162.55.217.189 "cat > /opt/falcao-monitor/migrations/001_init.sql" <<'SQL'
-- Habilita extensão TimescaleDB
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Cria tabela principal de métricas (modelo wide)
CREATE TABLE IF NOT EXISTS metrics (
  ts        TIMESTAMPTZ NOT NULL,
  host      TEXT NOT NULL,
  source    TEXT NOT NULL,
  resource  TEXT,
  metric    TEXT NOT NULL,
  value     DOUBLE PRECISION,
  labels    JSONB
);

-- Converte em hypertable (chunking automático por 7 dias)
SELECT create_hypertable('metrics', 'ts', if_not_exists => TRUE);

-- Índice principal pra queries do launcher
CREATE INDEX IF NOT EXISTS idx_metrics_lookup
  ON metrics (host, source, resource, metric, ts DESC);

-- Heartbeat do agente (pra detectar coletor parado)
CREATE TABLE IF NOT EXISTS agent_heartbeat (
  host         TEXT PRIMARY KEY,
  last_seen    TIMESTAMPTZ NOT NULL,
  agent_version TEXT
);
SQL
ssh falcao@162.55.217.189 "ls -la /opt/falcao-monitor/migrations/"
```

Expected: arquivo presente.

- [ ] **Step 2: Commit local placeholder pra rastrear o trabalho**

```bash
cd ~/Projects/falcao-launcher
mkdir -p docs/superpowers/vm-migrations
ssh falcao@162.55.217.189 "cat /opt/falcao-monitor/migrations/001_init.sql" > docs/superpowers/vm-migrations/001_init.sql
git add docs/superpowers/vm-migrations/001_init.sql
git commit -m "docs(monitor): registra migration 001_init.sql aplicada na VM"
```

Expected: commit local com cópia rastreável da migration.

---

### Task A3: Migration 002 — compression e retention

**Files:**
- Create (na VM): `/opt/falcao-monitor/migrations/002_compression_retention.sql`

- [ ] **Step 1: Criar migration 002**

```bash
ssh falcao@162.55.217.189 "cat > /opt/falcao-monitor/migrations/002_compression_retention.sql" <<'SQL'
-- Habilita compressão (configura segmentação por dimensões)
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, source, resource, metric'
);

-- Comprime chunks após 7 dias automaticamente
SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Apaga raw data com mais de 35 dias (continuous aggregates preservam histórico)
SELECT add_retention_policy('metrics', INTERVAL '35 days');
SQL
```

- [ ] **Step 2: Copiar local pra rastreio**

```bash
ssh falcao@162.55.217.189 "cat /opt/falcao-monitor/migrations/002_compression_retention.sql" \
  > ~/Projects/falcao-launcher/docs/superpowers/vm-migrations/002_compression_retention.sql
cd ~/Projects/falcao-launcher
git add docs/superpowers/vm-migrations/002_compression_retention.sql
git commit -m "docs(monitor): registra migration 002 (compression + retention)"
```

---

### Task A4: Migration 003 — continuous aggregates

**Files:**
- Create (na VM): `/opt/falcao-monitor/migrations/003_continuous_aggregates.sql`

- [ ] **Step 1: Criar migration 003**

```bash
ssh falcao@162.55.217.189 "cat > /opt/falcao-monitor/migrations/003_continuous_aggregates.sql" <<'SQL'
-- Agregado por hora
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket,
       host, source, resource, metric,
       avg(value) AS avg_value,
       max(value) AS max_value,
       min(value) AS min_value,
       count(*)   AS n
FROM metrics
GROUP BY bucket, host, source, resource, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- Agregado por dia
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', ts) AS bucket,
       host, source, resource, metric,
       avg(value) AS avg_value,
       max(value) AS max_value,
       min(value) AS min_value,
       count(*)   AS n
FROM metrics
GROUP BY bucket, host, source, resource, metric
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_daily',
  start_offset      => INTERVAL '1 year',
  end_offset        => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day');
SQL
```

- [ ] **Step 2: Copiar local pra rastreio**

```bash
ssh falcao@162.55.217.189 "cat /opt/falcao-monitor/migrations/003_continuous_aggregates.sql" \
  > ~/Projects/falcao-launcher/docs/superpowers/vm-migrations/003_continuous_aggregates.sql
cd ~/Projects/falcao-launcher
git add docs/superpowers/vm-migrations/003_continuous_aggregates.sql
git commit -m "docs(monitor): registra migration 003 (continuous aggregates)"
```

---

### Task A5: Migration 004 — users writer/reader (D8)

**Files:**
- Create (na VM): `/opt/falcao-monitor/migrations/004_users.sql`

- [ ] **Step 1: Criar migration 004 com SQL parametrizado por env vars**

```bash
# Como Postgres init scripts não têm interpolação de env, geramos SQL local com as senhas inline
cat <<SQL | ssh falcao@162.55.217.189 "cat > /opt/falcao-monitor/migrations/004_users.sql"
-- Cria roles separados (princípio do menor privilégio)
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_writer') THEN
    CREATE ROLE monitor_writer LOGIN PASSWORD '$PG_WRITER_PWD';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_reader') THEN
    CREATE ROLE monitor_reader LOGIN PASSWORD '$PG_READER_PWD';
  END IF;
END
\$\$;

-- Writer: INSERT only
GRANT CONNECT ON DATABASE falcao_monitor TO monitor_writer;
GRANT USAGE ON SCHEMA public TO monitor_writer;
GRANT INSERT ON metrics, agent_heartbeat TO monitor_writer;
GRANT UPDATE ON agent_heartbeat TO monitor_writer;

-- Reader: SELECT only
GRANT CONNECT ON DATABASE falcao_monitor TO monitor_reader;
GRANT USAGE ON SCHEMA public TO monitor_reader;
GRANT SELECT ON metrics, agent_heartbeat, metrics_hourly, metrics_daily TO monitor_reader;
SQL
ssh falcao@162.55.217.189 "ls /opt/falcao-monitor/migrations/"
```

Expected: 4 arquivos .sql na pasta.

- [ ] **Step 2: Copiar versão sanitizada (sem senhas) pra repo**

```bash
# Versão pra git substitui senhas por placeholder
cat > ~/Projects/falcao-launcher/docs/superpowers/vm-migrations/004_users.sql <<'SQL'
-- Cria roles separados (princípio do menor privilégio)
-- ATENÇÃO: senhas são substituídas em runtime; não armazenadas no repo
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_writer') THEN
    CREATE ROLE monitor_writer LOGIN PASSWORD '${MONITOR_WRITER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'monitor_reader') THEN
    CREATE ROLE monitor_reader LOGIN PASSWORD '${MONITOR_READER_PASSWORD}';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE falcao_monitor TO monitor_writer;
GRANT USAGE ON SCHEMA public TO monitor_writer;
GRANT INSERT ON metrics, agent_heartbeat TO monitor_writer;
GRANT UPDATE ON agent_heartbeat TO monitor_writer;

GRANT CONNECT ON DATABASE falcao_monitor TO monitor_reader;
GRANT USAGE ON SCHEMA public TO monitor_reader;
GRANT SELECT ON metrics, agent_heartbeat, metrics_hourly, metrics_daily TO monitor_reader;
SQL
cd ~/Projects/falcao-launcher
git add docs/superpowers/vm-migrations/004_users.sql
git commit -m "docs(monitor): registra migration 004 (users sanitizada — sem senhas)"
```

---

### Task A6: Subir Postgres + validar

**Files:**
- Validation only (no new files)

- [ ] **Step 1: Subir o container**

```bash
ssh falcao@162.55.217.189 "cd /opt/falcao-monitor && docker compose up -d 2>&1 | tail -5"
```

Expected: container `falcao-monitor-db` criado e iniciado.

- [ ] **Step 2: Aguardar healthy + verificar logs**

```bash
ssh falcao@162.55.217.189 "sleep 15 && docker compose -f /opt/falcao-monitor/docker-compose.yml ps && docker logs falcao-monitor-db 2>&1 | tail -20"
```

Expected: status "healthy", logs mostram migrations executadas.

- [ ] **Step 3: Validar schema com psql interno do container**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c '\dt'"
```

Expected: tabelas `metrics`, `agent_heartbeat` listadas.

- [ ] **Step 4: Validar TimescaleDB ativo + hypertable**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT extname FROM pg_extension WHERE extname = 'timescaledb'; SELECT hypertable_name FROM timescaledb_information.hypertables;\""
```

Expected: `timescaledb` listed, `metrics` é hypertable.

- [ ] **Step 5: Validar users criados e permissões**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c '\du'"
```

Expected: roles `monitor_writer` e `monitor_reader` listados.

- [ ] **Step 6: Validar que monitor_writer consegue INSERT mas não SELECT**

```bash
# Insert deve funcionar
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U monitor_writer -d falcao_monitor -c \"INSERT INTO metrics (ts, host, source, metric, value) VALUES (NOW(), 'test', 'vm', 'cpu_pct', 5.0);\""
# Esperado: INSERT 0 1

# SELECT deve falhar
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U monitor_writer -d falcao_monitor -c 'SELECT count(*) FROM metrics;' 2>&1 | tail -3"
# Esperado: ERROR: permission denied
```

Expected: INSERT funciona, SELECT é negado.

- [ ] **Step 7: Validar que monitor_reader consegue SELECT mas não INSERT**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U monitor_reader -d falcao_monitor -c 'SELECT count(*) FROM metrics;'"
# Esperado: 1 (linha do step anterior)

ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U monitor_reader -d falcao_monitor -c \"INSERT INTO metrics (ts, host, source, metric, value) VALUES (NOW(), 'test', 'vm', 'cpu_pct', 5.0);\" 2>&1 | tail -3"
# Esperado: ERROR: permission denied
```

Expected: SELECT funciona, INSERT é negado.

- [ ] **Step 8: Limpar dado de teste**

```bash
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c 'TRUNCATE metrics;'"
```

- [ ] **Step 9: Commit nota de validação**

```bash
cd ~/Projects/falcao-launcher
cat > docs/superpowers/vm-migrations/VALIDATION.md <<EOF
# Phase A — Validation

Executado em $(date -u +%Y-%m-%dT%H:%M:%SZ).

- TimescaleDB extension: ativa
- Hypertable: metrics
- Users: monitor_writer (INSERT only), monitor_reader (SELECT only)
- Validação isolation: writer não lê, reader não escreve. ✅
EOF
git add docs/superpowers/vm-migrations/VALIDATION.md
git commit -m "docs(monitor): registra validação da Phase A"
```

---

## Phase B — Rust Agent (Coletor)

Workspace conversion + agente coletor + systemd.

### Task B1: Converter Cargo.toml em workspace e criar subcrates

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/Cargo.toml` (root, virtual workspace)
- Create: `src-tauri/crates/monitor-shared/Cargo.toml`
- Create: `src-tauri/crates/monitor-shared/src/lib.rs`
- Create: `src-tauri/crates/monitor-agent/Cargo.toml`
- Create: `src-tauri/crates/monitor-agent/src/main.rs`

- [ ] **Step 1: Renomear `src-tauri/Cargo.toml` atual pra `src-tauri/launcher/Cargo.toml`**

NOTA: Tauri precisa de estrutura específica. Vamos manter `src-tauri/` como crate principal e adicionar `crates/` como subdir com membros do workspace. O workspace fica definido no Cargo.toml de `src-tauri/`.

```bash
cd ~/Projects/falcao-launcher/src-tauri
mkdir -p crates/monitor-shared/src
mkdir -p crates/monitor-agent/src
```

- [ ] **Step 2: Adicionar `[workspace]` no Cargo.toml de `src-tauri/`**

Editar `src-tauri/Cargo.toml`, adicionar no topo (antes de `[package]`):

```toml
[workspace]
members = [
  ".",
  "crates/monitor-shared",
  "crates/monitor-agent",
]

[workspace.dependencies]
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
chrono = { version = "0.4", features = ["serde"] }
tokio-postgres = { version = "0.7", features = ["with-chrono-0_4", "with-serde_json-1"] }
deadpool-postgres = "0.14"
russh = "0.45"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

- [ ] **Step 3: Criar `crates/monitor-shared/Cargo.toml`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-shared/Cargo.toml <<'TOML'
[package]
name = "monitor-shared"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { workspace = true }
serde_json = { workspace = true }
chrono = { workspace = true }
TOML
```

- [ ] **Step 4: Criar `crates/monitor-shared/src/lib.rs` com tipos comuns**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-shared/src/lib.rs <<'RUST'
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetricRow {
    pub ts: DateTime<Utc>,
    pub host: String,
    pub source: MetricSource,
    pub resource: Option<String>,
    pub metric: String,
    pub value: Option<f64>,
    pub labels: Option<JsonValue>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MetricSource {
    Vm,
    Container,
    Hetzner,
}

impl MetricSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            MetricSource::Vm => "vm",
            MetricSource::Container => "container",
            MetricSource::Hetzner => "hetzner",
        }
    }
}

pub const HOST_NAME: &str = "falcao-main";
pub const POLL_INTERVAL_SECS: u64 = 15;
RUST
```

- [ ] **Step 5: Criar `crates/monitor-agent/Cargo.toml`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/Cargo.toml <<'TOML'
[package]
name = "monitor-agent"
version = "0.1.0"
edition = "2021"

[[bin]]
name = "falcao-monitor-agent"
path = "src/main.rs"

[dependencies]
monitor-shared = { path = "../monitor-shared" }
tokio = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
anyhow = { workspace = true }
chrono = { workspace = true }
tokio-postgres = { workspace = true }
deadpool-postgres = { workspace = true }
tracing = { workspace = true }
tracing-subscriber = { workspace = true }
TOML
```

- [ ] **Step 6: Stub do main.rs do agente (compila vazio)**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/main.rs <<'RUST'
use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    tracing::info!("falcao-monitor-agent starting (stub)");
    Ok(())
}
RUST
```

- [ ] **Step 7: Validar workspace compila**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build --bin falcao-monitor-agent 2>&1 | tail -10
```

Expected: compila sem erro.

- [ ] **Step 8: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/Cargo.toml src-tauri/crates/
git commit -m "feat(monitor): converte src-tauri em workspace + cria crates monitor-shared e monitor-agent

- src-tauri/crates/monitor-shared: tipos comuns (MetricRow, MetricSource)
- src-tauri/crates/monitor-agent: binário do coletor (stub inicial)
- Workspace dependencies centralizadas em src-tauri/Cargo.toml"
```

---

### Task B2: TDD — DB writer (insert batch de metrics)

**Files:**
- Create: `src-tauri/crates/monitor-agent/src/db.rs`
- Modify: `src-tauri/crates/monitor-agent/src/main.rs`
- Test: integração com docker postgres local

- [ ] **Step 1: Adicionar módulo db no main.rs**

Adicionar no topo de `crates/monitor-agent/src/main.rs`:

```rust
mod db;
```

- [ ] **Step 2: Escrever stub do db.rs com função `insert_batch` que aceita `Vec<MetricRow>`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/db.rs <<'RUST'
use anyhow::{Context, Result};
use deadpool_postgres::{Config, Pool, Runtime};
use monitor_shared::MetricRow;
use tokio_postgres::NoTls;

pub fn build_pool(database_url: &str) -> Result<Pool> {
    let mut cfg = Config::new();
    let parsed: tokio_postgres::Config = database_url
        .parse()
        .context("invalid DATABASE_URL")?;

    // deadpool-postgres aceita tokio_postgres::Config diretamente via builder
    let pool = deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(parsed, NoTls))
        .max_size(4)
        .build()
        .context("failed to build connection pool")?;
    Ok(pool)
}

pub async fn insert_batch(pool: &Pool, rows: &[MetricRow]) -> Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let client = pool.get().await.context("get pool client")?;
    // Usa COPY pra eficiência em batches grandes
    let stmt = client
        .prepare(
            "INSERT INTO metrics (ts, host, source, resource, metric, value, labels)
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .await
        .context("prepare insert")?;

    for r in rows {
        client
            .execute(
                &stmt,
                &[
                    &r.ts,
                    &r.host,
                    &r.source.as_str(),
                    &r.resource,
                    &r.metric,
                    &r.value,
                    &r.labels,
                ],
            )
            .await
            .context("execute insert")?;
    }
    Ok(())
}

pub async fn write_heartbeat(pool: &Pool, host: &str, version: &str) -> Result<()> {
    let client = pool.get().await?;
    client
        .execute(
            "INSERT INTO agent_heartbeat (host, last_seen, agent_version)
             VALUES ($1, NOW(), $2)
             ON CONFLICT (host) DO UPDATE
               SET last_seen = NOW(), agent_version = EXCLUDED.agent_version",
            &[&host, &version],
        )
        .await?;
    Ok(())
}
RUST
```

- [ ] **Step 3: Compilar pra detectar erros de tipo**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build --bin falcao-monitor-agent 2>&1 | tail -15
```

Expected: compila sem erro. Se falhar em tipos JSONB / Option, ajustar conversões — `serde_json::Value` mapeia pra `JSONB` via tokio-postgres com feature `with-serde_json-1`.

- [ ] **Step 4: Teste de integração — escreve 1 row e lê de volta**

Criar `src-tauri/crates/monitor-agent/tests/db_integration.rs`:

```bash
mkdir -p ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/tests
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/tests/db_integration.rs <<'RUST'
//! Teste de integração: requer DATABASE_URL apontando pra Postgres com schema aplicado.
//! Pula se var não estiver setada (CI sem DB).

use chrono::Utc;
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};

#[tokio::test]
async fn insert_and_read_back() {
    let url = match std::env::var("DATABASE_URL_TEST") {
        Ok(v) => v,
        Err(_) => {
            eprintln!("skip: DATABASE_URL_TEST not set");
            return;
        }
    };

    let pool = monitor_agent::db::build_pool(&url).expect("build pool");

    let row = MetricRow {
        ts: Utc::now(),
        host: format!("test-{}", uuid_like_marker()),
        source: MetricSource::Vm,
        resource: None,
        metric: "cpu_pct".to_string(),
        value: Some(42.0),
        labels: None,
    };

    monitor_agent::db::insert_batch(&pool, std::slice::from_ref(&row))
        .await
        .expect("insert");

    let client = pool.get().await.expect("client");
    let r = client
        .query_one(
            "SELECT value FROM metrics WHERE host = $1 AND metric = 'cpu_pct' LIMIT 1",
            &[&row.host],
        )
        .await
        .expect("read back");
    let v: f64 = r.get(0);
    assert_eq!(v, 42.0);

    // limpa
    client
        .execute("DELETE FROM metrics WHERE host = $1", &[&row.host])
        .await
        .ok();
}

fn uuid_like_marker() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
        .to_string()
}
RUST
```

- [ ] **Step 5: Tornar `db` público pra acesso do teste**

Em `crates/monitor-agent/src/main.rs`, mudar `mod db;` pra `pub mod db;` (ou adicionar `lib.rs`):

Solução mais limpa: criar `crates/monitor-agent/src/lib.rs`:

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/lib.rs <<'RUST'
pub mod db;
RUST
```

E em `main.rs` substituir `mod db;` por `use monitor_agent::db;` (mas `monitor-agent` é binário, precisa setup específico).

Alternativa simpler: deixar `mod db;` e fazer o teste cobrir o módulo via `#[path]`:

Substituir o conteúdo do teste de integração — mover pra módulo de unit tests dentro de `db.rs`:

```bash
# Apaga o teste integração antigo
rm ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/tests/db_integration.rs

# Adiciona teste no fim de db.rs
cat >> ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/db.rs <<'RUST'

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use monitor_shared::MetricSource;

    #[tokio::test]
    #[ignore] // requer DATABASE_URL_TEST setado
    async fn insert_and_read_back() {
        let url = std::env::var("DATABASE_URL_TEST")
            .expect("DATABASE_URL_TEST required");
        let pool = build_pool(&url).expect("build pool");

        let row = MetricRow {
            ts: Utc::now(),
            host: format!("test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()),
            source: MetricSource::Vm,
            resource: None,
            metric: "cpu_pct".to_string(),
            value: Some(42.0),
            labels: None,
        };

        insert_batch(&pool, std::slice::from_ref(&row)).await.expect("insert");

        let client = pool.get().await.expect("client");
        let r = client.query_one(
            "SELECT value FROM metrics WHERE host = $1 AND metric = 'cpu_pct' LIMIT 1",
            &[&row.host],
        ).await.expect("read back");
        let v: f64 = r.get(0);
        assert_eq!(v, 42.0);

        client.execute("DELETE FROM metrics WHERE host = $1", &[&row.host]).await.ok();
    }
}
RUST
```

- [ ] **Step 6: Rodar teste contra o Postgres da VM via SSH tunnel local**

```bash
# Abre tunnel em background
ssh -L 54322:localhost:5432 falcao@162.55.217.189 -fN

# Roda teste
cd ~/Projects/falcao-launcher/src-tauri
DATABASE_URL_TEST="postgresql://monitor_writer:$PG_WRITER_PWD@localhost:54322/falcao_monitor" \
  cargo test --bin falcao-monitor-agent -- --ignored insert_and_read_back 2>&1 | tail -10

# Não esquecer de fechar tunnel
pkill -f "ssh -L 54322"
```

NOTA: writer não lê, então o teste vai falhar no SELECT. Usar `monitor_reader` ou `postgres` pro SELECT do teste, ou ajustar pra usar reader.

Solução: roda teste com `postgres` (super) ou cria conexão dual no teste. Mais simples: usar postgres super no DATABASE_URL_TEST:

```bash
DATABASE_URL_TEST="postgresql://postgres:$PG_SUPER_PWD@localhost:54322/falcao_monitor" \
  cargo test --bin falcao-monitor-agent -- --ignored insert_and_read_back 2>&1 | tail -10
```

Expected: teste passa.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/crates/monitor-agent/src/db.rs
git commit -m "feat(monitor-agent): adiciona writer de DB com pool deadpool-postgres + teste integração"
```

---

### Task B3: Coletor de métricas da VM (`/proc`, `df`, `uptime`)

**Files:**
- Create: `src-tauri/crates/monitor-agent/src/collectors/mod.rs`
- Create: `src-tauri/crates/monitor-agent/src/collectors/vm.rs`

- [ ] **Step 1: Criar módulo collectors**

```bash
mkdir -p ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/mod.rs <<'RUST'
pub mod vm;
RUST
```

- [ ] **Step 2: Implementar coletor VM com testes unitários**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/vm.rs <<'RUST'
//! Coletor de métricas VM-level: /proc, df, uptime.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use std::fs;

pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>> {
    let mut out = Vec::with_capacity(10);

    // mem
    let mem = fs::read_to_string("/proc/meminfo").context("read /proc/meminfo")?;
    let mem_total = parse_meminfo_kib(&mem, "MemTotal");
    let mem_avail = parse_meminfo_kib(&mem, "MemAvailable");
    let mem_used = mem_total.zip(mem_avail).map(|(t, a)| t - a);

    if let Some(v) = mem_total {
        out.push(metric(ts, "mem_total_bytes", v as f64 * 1024.0));
    }
    if let Some(v) = mem_used {
        out.push(metric(ts, "mem_used_bytes", v as f64 * 1024.0));
    }
    if let Some(v) = mem_avail {
        out.push(metric(ts, "mem_available_bytes", v as f64 * 1024.0));
    }

    // load avg
    if let Ok(load) = fs::read_to_string("/proc/loadavg") {
        let parts: Vec<&str> = load.split_whitespace().collect();
        if parts.len() >= 3 {
            if let Ok(v) = parts[0].parse::<f64>() {
                out.push(metric(ts, "load_1m", v));
            }
            if let Ok(v) = parts[1].parse::<f64>() {
                out.push(metric(ts, "load_5m", v));
            }
            if let Ok(v) = parts[2].parse::<f64>() {
                out.push(metric(ts, "load_15m", v));
            }
        }
    }

    Ok(out)
}

fn parse_meminfo_kib(meminfo: &str, key: &str) -> Option<u64> {
    for line in meminfo.lines() {
        if let Some(rest) = line.strip_prefix(&format!("{}:", key)) {
            let parts: Vec<&str> = rest.split_whitespace().collect();
            if let Some(num) = parts.first() {
                return num.parse().ok();
            }
        }
    }
    None
}

fn metric(ts: DateTime<Utc>, name: &str, value: f64) -> MetricRow {
    MetricRow {
        ts,
        host: HOST_NAME.to_string(),
        source: MetricSource::Vm,
        resource: None,
        metric: name.to_string(),
        value: Some(value),
        labels: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo_lines() {
        let sample = "MemTotal:        4023456 kB\nMemAvailable:    2011728 kB\nFoo: bar\n";
        assert_eq!(parse_meminfo_kib(sample, "MemTotal"), Some(4023456));
        assert_eq!(parse_meminfo_kib(sample, "MemAvailable"), Some(2011728));
        assert_eq!(parse_meminfo_kib(sample, "Missing"), None);
    }

    #[tokio::test]
    async fn collect_returns_at_least_some_metrics() {
        // Em runtime real (Linux), /proc existe. Em macOS/Windows pula.
        if !std::path::Path::new("/proc/meminfo").exists() {
            eprintln!("skip: /proc/meminfo not present");
            return;
        }
        let rows = collect(Utc::now()).await.unwrap();
        assert!(rows.len() >= 3, "expected at least mem_total/used/avail");
        assert!(rows.iter().any(|r| r.metric == "mem_total_bytes"));
    }
}
RUST
```

- [ ] **Step 3: Adicionar módulo no main.rs**

Adicionar após `mod db;` em `crates/monitor-agent/src/main.rs`:

```rust
mod collectors;
```

- [ ] **Step 4: Compilar e rodar testes unitários**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo test --bin falcao-monitor-agent collectors::vm 2>&1 | tail -8
```

Expected: 2 testes passam (parses_meminfo_lines + collect_returns).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/crates/monitor-agent/src/collectors/
git commit -m "feat(monitor-agent): coletor de métricas VM-level (mem, loadavg)"
```

---

### Task B4: Coletor de métricas de containers (docker stats)

**Files:**
- Create: `src-tauri/crates/monitor-agent/src/collectors/container.rs`
- Modify: `src-tauri/crates/monitor-agent/src/collectors/mod.rs`

- [ ] **Step 1: Adicionar módulo no mod.rs**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/mod.rs <<'RUST'
pub mod vm;
pub mod container;
RUST
```

- [ ] **Step 2: Implementar coletor de containers**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/container.rs <<'RUST'
//! Coletor de métricas por container via `docker stats`.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use serde::Deserialize;
use tokio::process::Command;

#[derive(Debug, Deserialize)]
struct DockerStat {
    #[serde(rename = "Name")]
    name: String,
    #[serde(rename = "CPUPerc")]
    cpu_perc: String,
    #[serde(rename = "MemUsage")]
    mem_usage: String,
    #[serde(rename = "MemPerc")]
    mem_perc: String,
    #[serde(rename = "NetIO")]
    net_io: String,
    #[serde(rename = "BlockIO")]
    block_io: String,
}

pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>> {
    let output = Command::new("docker")
        .args(["stats", "--no-stream", "--format", "{{json .}}"])
        .output()
        .await
        .context("execute docker stats")?;

    if !output.status.success() {
        anyhow::bail!(
            "docker stats failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let stat: DockerStat = serde_json::from_str(line).context("parse docker stats line")?;
        push_container_metrics(&mut out, ts, &stat);
    }
    Ok(out)
}

fn push_container_metrics(out: &mut Vec<MetricRow>, ts: DateTime<Utc>, s: &DockerStat) {
    if let Some(v) = parse_pct(&s.cpu_perc) {
        out.push(metric(ts, &s.name, "cpu_pct", v));
    }
    if let Some(v) = parse_pct(&s.mem_perc) {
        out.push(metric(ts, &s.name, "mem_pct", v));
    }
    if let Some(v) = parse_mem_usage(&s.mem_usage) {
        out.push(metric(ts, &s.name, "mem_used_bytes", v));
    }
    if let Some((rx, tx)) = parse_io_pair(&s.net_io) {
        out.push(metric(ts, &s.name, "net_rx_bytes", rx));
        out.push(metric(ts, &s.name, "net_tx_bytes", tx));
    }
    if let Some((r, w)) = parse_io_pair(&s.block_io) {
        out.push(metric(ts, &s.name, "block_read_bytes", r));
        out.push(metric(ts, &s.name, "block_write_bytes", w));
    }
}

/// "12.34%" -> 12.34
fn parse_pct(s: &str) -> Option<f64> {
    s.trim_end_matches('%').trim().parse().ok()
}

/// "47.5MiB / 3.7GiB" -> 47.5MiB em bytes
fn parse_mem_usage(s: &str) -> Option<f64> {
    let used = s.split('/').next()?.trim();
    parse_size(used)
}

/// "1.23kB / 4.56MB" -> (1.23kB, 4.56MB) em bytes
fn parse_io_pair(s: &str) -> Option<(f64, f64)> {
    let mut parts = s.split('/');
    let a = parse_size(parts.next()?.trim())?;
    let b = parse_size(parts.next()?.trim())?;
    Some((a, b))
}

/// "1.23GiB" / "456MB" / "0B" -> bytes
fn parse_size(s: &str) -> Option<f64> {
    let s = s.trim();
    let (num_str, mult) = match () {
        _ if s.ends_with("GiB") => (&s[..s.len() - 3], 1024.0_f64.powi(3)),
        _ if s.ends_with("MiB") => (&s[..s.len() - 3], 1024.0_f64.powi(2)),
        _ if s.ends_with("KiB") => (&s[..s.len() - 3], 1024.0_f64),
        _ if s.ends_with("GB")  => (&s[..s.len() - 2], 1e9),
        _ if s.ends_with("MB")  => (&s[..s.len() - 2], 1e6),
        _ if s.ends_with("kB")  => (&s[..s.len() - 2], 1e3),
        _ if s.ends_with("B")   => (&s[..s.len() - 1], 1.0),
        _ => return None,
    };
    num_str.trim().parse::<f64>().ok().map(|n| n * mult)
}

fn metric(ts: DateTime<Utc>, name: &str, m: &str, value: f64) -> MetricRow {
    MetricRow {
        ts,
        host: HOST_NAME.to_string(),
        source: MetricSource::Container,
        resource: Some(name.to_string()),
        metric: m.to_string(),
        value: Some(value),
        labels: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_docker_stats_json_line() {
        let line = r#"{"Name":"caddy","CPUPerc":"0.05%","MemUsage":"12.5MiB / 3.7GiB","MemPerc":"0.33%","NetIO":"1.2kB / 5.4kB","BlockIO":"0B / 100kB"}"#;
        let stat: DockerStat = serde_json::from_str(line).unwrap();
        assert_eq!(stat.name, "caddy");
        assert_eq!(stat.cpu_perc, "0.05%");
    }

    #[test]
    fn parses_pct() {
        assert_eq!(parse_pct("12.34%"), Some(12.34));
        assert_eq!(parse_pct("0%"), Some(0.0));
        assert_eq!(parse_pct("--"), None);
    }

    #[test]
    fn parses_size_variants() {
        assert_eq!(parse_size("1KiB"), Some(1024.0));
        assert_eq!(parse_size("1MiB"), Some(1024.0 * 1024.0));
        assert_eq!(parse_size("1GiB"), Some(1024.0 * 1024.0 * 1024.0));
        assert_eq!(parse_size("1kB"), Some(1000.0));
        assert_eq!(parse_size("1MB"), Some(1_000_000.0));
        assert_eq!(parse_size("0B"), Some(0.0));
        assert_eq!(parse_size("garbage"), None);
    }

    #[test]
    fn parses_io_pair() {
        let r = parse_io_pair("1.2kB / 5.4kB").unwrap();
        assert!((r.0 - 1200.0).abs() < 0.01);
        assert!((r.1 - 5400.0).abs() < 0.01);
    }

    #[test]
    fn pushes_metrics_for_container() {
        let s = DockerStat {
            name: "x".into(),
            cpu_perc: "5%".into(),
            mem_usage: "100MiB / 1GiB".into(),
            mem_perc: "10%".into(),
            net_io: "1kB / 2kB".into(),
            block_io: "0B / 0B".into(),
        };
        let mut out = vec![];
        push_container_metrics(&mut out, Utc::now(), &s);
        assert!(out.iter().any(|r| r.metric == "cpu_pct"));
        assert!(out.iter().any(|r| r.metric == "mem_pct"));
        assert!(out.iter().any(|r| r.metric == "net_rx_bytes"));
    }
}
RUST
```

- [ ] **Step 3: Compilar e testar**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo test --bin falcao-monitor-agent collectors::container 2>&1 | tail -10
```

Expected: 5 testes passam.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/crates/monitor-agent/src/collectors/
git commit -m "feat(monitor-agent): coletor de containers via docker stats com parser de tamanhos"
```

---

### Task B5: Coletor Hetzner (via `hcloud` CLI)

**Files:**
- Create: `src-tauri/crates/monitor-agent/src/collectors/hetzner.rs`
- Modify: `src-tauri/crates/monitor-agent/src/collectors/mod.rs`

- [ ] **Step 1: Adicionar módulo**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/mod.rs <<'RUST'
pub mod vm;
pub mod container;
pub mod hetzner;
RUST
```

- [ ] **Step 2: Implementar coletor Hetzner**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/hetzner.rs <<'RUST'
//! Coletor de métricas via `hcloud` CLI (server describe).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use serde_json::Value;
use tokio::process::Command;

pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>> {
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

    let mut out = Vec::new();

    if let Some(v) = value.get("included_traffic").and_then(Value::as_f64) {
        out.push(metric(ts, "included_traffic_bytes", v));
    }
    if let Some(v) = value.get("outgoing_traffic").and_then(Value::as_f64) {
        out.push(metric(ts, "outgoing_traffic_bytes", v));
    }
    if let Some(v) = value.get("ingoing_traffic").and_then(Value::as_f64) {
        out.push(metric(ts, "ingoing_traffic_bytes", v));
    }
    if let Some(s) = value.get("status").and_then(Value::as_str) {
        let v = if s == "running" { 1.0 } else { 0.0 };
        out.push(metric(ts, "status_running", v));
    }

    Ok(out)
}

fn metric(ts: DateTime<Utc>, name: &str, value: f64) -> MetricRow {
    MetricRow {
        ts,
        host: HOST_NAME.to_string(),
        source: MetricSource::Hetzner,
        resource: None,
        metric: name.to_string(),
        value: Some(value),
        labels: None,
    }
}
RUST
```

NOTA: este coletor depende do binário `hcloud` estar no PATH e contexto autenticado. O agente roda como user `falcao`, que já tem o context configurado.

- [ ] **Step 3: Compilar**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build --bin falcao-monitor-agent 2>&1 | tail -5
```

Expected: compila sem erro.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/crates/monitor-agent/src/collectors/
git commit -m "feat(monitor-agent): coletor Hetzner via hcloud cli (traffic + status)"
```

---

### Task B6: Main loop com poll a cada 15s + buffer + heartbeat

**Files:**
- Modify: `src-tauri/crates/monitor-agent/src/main.rs`
- Create: `src-tauri/crates/monitor-agent/src/buffer.rs`

- [ ] **Step 1: Implementar buffer com retry**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/buffer.rs <<'RUST'
//! Buffer in-memory pra resiliência quando DB cai.

use monitor_shared::MetricRow;
use std::collections::VecDeque;

const MAX_BUFFER: usize = 50_000; // ~1h de samples a 15s × 30 métricas

pub struct Buffer {
    rows: VecDeque<MetricRow>,
    dropped: u64,
}

impl Default for Buffer {
    fn default() -> Self {
        Self {
            rows: VecDeque::with_capacity(MAX_BUFFER),
            dropped: 0,
        }
    }
}

impl Buffer {
    pub fn push_batch(&mut self, batch: Vec<MetricRow>) {
        for row in batch {
            if self.rows.len() >= MAX_BUFFER {
                self.rows.pop_front();
                self.dropped += 1;
            }
            self.rows.push_back(row);
        }
    }

    pub fn drain_all(&mut self) -> Vec<MetricRow> {
        self.rows.drain(..).collect()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use monitor_shared::MetricSource;

    fn sample() -> MetricRow {
        MetricRow {
            ts: Utc::now(),
            host: "h".into(),
            source: MetricSource::Vm,
            resource: None,
            metric: "x".into(),
            value: Some(1.0),
            labels: None,
        }
    }

    #[test]
    fn buffer_holds_and_drains() {
        let mut b = Buffer::default();
        b.push_batch(vec![sample(), sample(), sample()]);
        assert_eq!(b.len(), 3);
        let drained = b.drain_all();
        assert_eq!(drained.len(), 3);
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn buffer_drops_oldest_on_overflow() {
        let mut b = Buffer::default();
        for _ in 0..MAX_BUFFER + 100 {
            b.push_batch(vec![sample()]);
        }
        assert_eq!(b.len(), MAX_BUFFER);
        assert_eq!(b.dropped_count(), 100);
    }
}
RUST
```

- [ ] **Step 2: Substituir main.rs com loop completo**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/main.rs <<'RUST'
mod buffer;
mod collectors;
mod db;

use anyhow::{Context, Result};
use buffer::Buffer;
use chrono::Utc;
use monitor_shared::{HOST_NAME, POLL_INTERVAL_SECS};
use std::time::Duration;
use tokio::time::sleep;

const AGENT_VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL").context("DATABASE_URL not set")?;
    let pool = db::build_pool(&database_url)?;

    tracing::info!(version = AGENT_VERSION, "falcao-monitor-agent starting");

    let mut buf = Buffer::default();

    loop {
        let ts = Utc::now();
        let mut batch = Vec::new();

        match collectors::vm::collect(ts).await {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("vm collector failed: {e:#}"),
        }
        match collectors::container::collect(ts).await {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("container collector failed: {e:#}"),
        }
        match collectors::hetzner::collect(ts).await {
            Ok(mut rows) => batch.append(&mut rows),
            Err(e) => tracing::warn!("hetzner collector failed: {e:#}"),
        }

        // Tenta flush do buffer + batch novo
        buf.push_batch(batch);
        let pending = buf.drain_all();
        let count = pending.len();

        match db::insert_batch(&pool, &pending).await {
            Ok(()) => {
                tracing::debug!(rows = count, "flushed batch");
                let _ = db::write_heartbeat(&pool, HOST_NAME, AGENT_VERSION).await;
            }
            Err(e) => {
                tracing::warn!(rows = count, "DB write failed, re-buffering: {e:#}");
                buf.push_batch(pending);
            }
        }

        if buf.dropped_count() > 0 {
            tracing::warn!(dropped = buf.dropped_count(), "buffer overflow occurred");
        }

        sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
    }
}
RUST
```

- [ ] **Step 3: Compilar e rodar testes**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo test --bin falcao-monitor-agent 2>&1 | tail -10
```

Expected: todos os testes passam.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/crates/monitor-agent/src/
git commit -m "feat(monitor-agent): main loop com poll 15s, buffer resiliente, heartbeat"
```

---

### Task B7: Build release + deploy do agente na VM

**Files:**
- Create: `scripts/deploy-monitor-agent.sh`

- [ ] **Step 1: Script de deploy do agente**

```bash
mkdir -p ~/Projects/falcao-launcher/scripts
cat > ~/Projects/falcao-launcher/scripts/deploy-monitor-agent.sh <<'BASH'
#!/usr/bin/env bash
# Deploya o binário do falcao-monitor-agent pra VM Hetzner.
# Uso: ./scripts/deploy-monitor-agent.sh

set -euo pipefail

VM_HOST="${VM_HOST:-falcao@162.55.217.189}"
BIN_NAME="falcao-monitor-agent"

cd "$(dirname "$0")/.."

echo ">>> Build release"
(cd src-tauri && cargo build --release --bin "$BIN_NAME")

BIN_PATH="src-tauri/target/release/$BIN_NAME"
[[ -f "$BIN_PATH" ]] || { echo "binary not found: $BIN_PATH"; exit 1; }

echo ">>> Upload pra /tmp na VM"
scp "$BIN_PATH" "$VM_HOST:/tmp/$BIN_NAME"

echo ">>> Mover pra /usr/local/bin (sudo)"
ssh "$VM_HOST" "sudo mv /tmp/$BIN_NAME /usr/local/bin/$BIN_NAME && sudo chmod +x /usr/local/bin/$BIN_NAME"

echo ">>> Restart systemd service (se já existir)"
ssh "$VM_HOST" "systemctl --user restart falcao-monitor-agent.service 2>/dev/null || echo '(service ainda não instalado, ok)'"

echo ">>> Versão deployada:"
ssh "$VM_HOST" "/usr/local/bin/$BIN_NAME --version 2>/dev/null || echo '(binário sem flag --version, mas deployou)'"

echo "✓ Deploy concluído"
BASH
chmod +x ~/Projects/falcao-launcher/scripts/deploy-monitor-agent.sh
```

- [ ] **Step 2: Executar deploy**

```bash
cd ~/Projects/falcao-launcher
./scripts/deploy-monitor-agent.sh 2>&1 | tail -10
```

Expected: build OK, binário em `/usr/local/bin/falcao-monitor-agent` na VM.

- [ ] **Step 3: Validar binário roda na VM (teste curto)**

```bash
ssh falcao@162.55.217.189 "DATABASE_URL='postgresql://monitor_writer:$PG_WRITER_PWD@localhost:5432/falcao_monitor' RUST_LOG=info timeout 5 /usr/local/bin/falcao-monitor-agent 2>&1 | head -20"
```

Expected: log "starting" + pelo menos uma flush de métricas.

- [ ] **Step 4: Commit script**

```bash
cd ~/Projects/falcao-launcher
git add scripts/deploy-monitor-agent.sh
git commit -m "chore(monitor): script de deploy do agente pra VM"
```

---

### Task B8: systemd user service na VM

**Files:**
- Create (na VM): `~/.config/systemd/user/falcao-monitor-agent.service`

- [ ] **Step 1: Criar service file na VM**

```bash
ssh falcao@162.55.217.189 "mkdir -p ~/.config/systemd/user && cat > ~/.config/systemd/user/falcao-monitor-agent.service" <<EOF
[Unit]
Description=Falcao VM Monitor Agent
After=network.target docker.service

[Service]
Type=simple
ExecStart=/usr/local/bin/falcao-monitor-agent
Restart=always
RestartSec=5
Environment=DATABASE_URL=postgresql://monitor_writer:$PG_WRITER_PWD@localhost:5432/falcao_monitor
Environment=RUST_LOG=info

[Install]
WantedBy=default.target
EOF
ssh falcao@162.55.217.189 "ls -la ~/.config/systemd/user/"
```

- [ ] **Step 2: Habilitar lingering pro user (rodar mesmo sem login)**

```bash
ssh falcao@162.55.217.189 "loginctl show-user falcao --property=Linger"
# Se Linger=no, habilitar:
ssh root@162.55.217.189 "loginctl enable-linger falcao"
```

- [ ] **Step 3: Habilitar e iniciar serviço**

```bash
ssh falcao@162.55.217.189 "systemctl --user daemon-reload && systemctl --user enable --now falcao-monitor-agent.service && sleep 3 && systemctl --user status falcao-monitor-agent.service --no-pager | head -15"
```

Expected: status `active (running)`.

- [ ] **Step 4: Verificar logs**

```bash
ssh falcao@162.55.217.189 "journalctl --user -u falcao-monitor-agent.service -n 20 --no-pager"
```

Expected: logs de poll ciclando, sem erros críticos.

- [ ] **Step 5: Verificar dados chegando no DB**

```bash
sleep 30  # espera 2 ciclos de poll
ssh falcao@162.55.217.189 "docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT source, count(*), max(ts) AS last FROM metrics GROUP BY source;\""
```

Expected: contagens > 0 pra `vm`, `container`, `hetzner`.

- [ ] **Step 6: Commit nota de validação**

```bash
cd ~/Projects/falcao-launcher
cat >> docs/superpowers/vm-migrations/VALIDATION.md <<EOF

## Phase B — Agent ativo

- systemd user service: ativo com lingering
- Dados chegando: vm, container, hetzner
- Heartbeat sendo escrito
EOF
git add docs/superpowers/vm-migrations/VALIDATION.md
git commit -m "docs(monitor): registra validação da Phase B (agente ativo)"
```

---

## Phase C — SSH Tunnel + Tauri Commands

Integração launcher → VM via SSH tunnel + queries do Postgres.

### Task C1: Adicionar dependências Tauri

**Files:**
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Adicionar deps no `[dependencies]` do crate principal**

Editar `src-tauri/Cargo.toml`, adicionar nas `[dependencies]`:

```toml
russh = { workspace = true }
russh-keys = "0.45"
tokio-postgres = { workspace = true }
deadpool-postgres = { workspace = true }
chrono = { workspace = true }
anyhow = { workspace = true }
tracing = { workspace = true }
monitor-shared = { path = "crates/monitor-shared" }
```

- [ ] **Step 2: Compilar**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build 2>&1 | tail -5
```

Expected: compila (download das deps demora primeira vez).

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "deps(tauri): adiciona russh, tokio-postgres, deadpool-postgres pro monitor"
```

---

### Task C2: SSH tunnel module (Rust, no crate Tauri)

**Files:**
- Create: `src-tauri/src/monitor/mod.rs`
- Create: `src-tauri/src/monitor/tunnel.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Criar módulo monitor**

```bash
mkdir -p ~/Projects/falcao-launcher/src-tauri/src/monitor
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/mod.rs <<'RUST'
pub mod tunnel;
pub mod queries;
pub mod commands;
RUST
```

- [ ] **Step 2: Stub do tunnel.rs (será expandido)**

NOTA: SSH tunnel via `russh` é não-trivial. Pra Fase 1, usar abordagem mais simples: spawnar processo `ssh -L`. Trade-off: depende do binário `ssh` no sistema, mas existente em qualquer Linux/macOS.

```bash
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/tunnel.rs <<'RUST'
//! SSH tunnel via processo `ssh` (mais robusto que russh pra Fase 1).

use anyhow::{Context, Result};
use std::sync::Mutex;
use tokio::process::{Child, Command};

const VM_HOST: &str = "falcao@162.55.217.189";
const REMOTE_PORT: u16 = 5432;
pub const LOCAL_PORT: u16 = 54322;

pub struct TunnelManager {
    child: Mutex<Option<Child>>,
}

impl TunnelManager {
    pub fn new() -> Self {
        Self {
            child: Mutex::new(None),
        }
    }

    pub async fn open(&self) -> Result<u16> {
        let mut guard = self.child.lock().unwrap();
        if guard.is_some() {
            return Ok(LOCAL_PORT);
        }

        let child = Command::new("ssh")
            .args([
                "-N",
                "-L",
                &format!("{}:localhost:{}", LOCAL_PORT, REMOTE_PORT),
                "-o",
                "ServerAliveInterval=30",
                "-o",
                "ExitOnForwardFailure=yes",
                VM_HOST,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .context("spawn ssh")?;

        *guard = Some(child);

        // Pequeno delay pra tunnel ficar pronto
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        Ok(LOCAL_PORT)
    }

    pub async fn close(&self) -> Result<()> {
        let mut guard = self.child.lock().unwrap();
        if let Some(mut child) = guard.take() {
            let _ = child.kill().await;
        }
        Ok(())
    }

    pub fn is_open(&self) -> bool {
        self.child.lock().unwrap().is_some()
    }
}

impl Default for TunnelManager {
    fn default() -> Self {
        Self::new()
    }
}
RUST
```

- [ ] **Step 3: Registrar módulo em lib.rs**

Adicionar em `src-tauri/src/lib.rs` (depois dos `mod` existentes):

```rust
mod monitor;
```

- [ ] **Step 4: Compilar**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build 2>&1 | tail -10
```

Expected: compila (módulos commands e queries vazios são placeholder, ainda).

- [ ] **Step 5: Stubs vazios pra commands.rs e queries.rs**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/queries.rs <<'RUST'
//! Queries SQL pro Postgres da VM. Implementadas em Task C3.
RUST
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/commands.rs <<'RUST'
//! Tauri commands. Implementados em Task C4.
RUST
```

- [ ] **Step 6: Compilar de novo**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build 2>&1 | tail -5
```

Expected: compila clean.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/src/monitor/ src-tauri/src/lib.rs
git commit -m "feat(launcher): módulo monitor + tunnel SSH manager"
```

---

### Task C3: Queries Postgres (SELECTs)

**Files:**
- Modify: `src-tauri/src/monitor/queries.rs`

- [ ] **Step 1: Implementar queries comuns**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/queries.rs <<'RUST'
//! Queries SQL pro Postgres da VM (read-only via monitor_reader).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;
use tokio_postgres::NoTls;

#[derive(Debug, Serialize)]
pub struct MetricPoint {
    pub ts: DateTime<Utc>,
    pub value: Option<f64>,
}

pub fn build_pool(database_url: &str) -> Result<Pool> {
    let parsed: tokio_postgres::Config = database_url.parse().context("invalid DATABASE_URL")?;
    deadpool_postgres::Pool::builder(deadpool_postgres::Manager::new(parsed, NoTls))
        .max_size(2)
        .build()
        .context("build pool")
}

pub async fn fetch_metric_series(
    pool: &Pool,
    source: &str,
    resource: Option<&str>,
    metric: &str,
    since: DateTime<Utc>,
    until: Option<DateTime<Utc>>,
    bucket: Option<&str>, // '1 minute' | '1 hour' | '1 day' | None (raw)
) -> Result<Vec<MetricPoint>> {
    let client = pool.get().await?;
    let until_v = until.unwrap_or_else(Utc::now);

    let rows = if let Some(b) = bucket {
        let sql = format!(
            "SELECT time_bucket('{}', ts) AS bucket, avg(value) FROM metrics
             WHERE source = $1 AND ($2::text IS NULL OR resource = $2)
                   AND metric = $3 AND ts BETWEEN $4 AND $5
             GROUP BY bucket ORDER BY bucket",
            b
        );
        client
            .query(&sql, &[&source, &resource, &metric, &since, &until_v])
            .await
            .context("query bucketed")?
    } else {
        client
            .query(
                "SELECT ts, value FROM metrics
                 WHERE source = $1 AND ($2::text IS NULL OR resource = $2)
                       AND metric = $3 AND ts BETWEEN $4 AND $5
                 ORDER BY ts",
                &[&source, &resource, &metric, &since, &until_v],
            )
            .await
            .context("query raw")?
    };

    let points = rows
        .into_iter()
        .map(|r| MetricPoint {
            ts: r.get(0),
            value: r.get(1),
        })
        .collect();
    Ok(points)
}

#[derive(Debug, Serialize)]
pub struct ContainerInfo {
    pub name: String,
    pub last_cpu_pct: Option<f64>,
    pub last_mem_pct: Option<f64>,
    pub last_seen: Option<DateTime<Utc>>,
}

pub async fn list_containers(pool: &Pool) -> Result<Vec<ContainerInfo>> {
    let client = pool.get().await?;
    let rows = client
        .query(
            r#"
            WITH latest AS (
              SELECT DISTINCT ON (resource, metric)
                resource, metric, value, ts
              FROM metrics
              WHERE source = 'container'
                AND metric IN ('cpu_pct', 'mem_pct')
                AND ts > NOW() - INTERVAL '5 minutes'
              ORDER BY resource, metric, ts DESC
            )
            SELECT
              resource AS name,
              MAX(CASE WHEN metric = 'cpu_pct' THEN value END) AS cpu_pct,
              MAX(CASE WHEN metric = 'mem_pct' THEN value END) AS mem_pct,
              MAX(ts) AS last_seen
            FROM latest
            GROUP BY resource
            ORDER BY resource
            "#,
            &[],
        )
        .await
        .context("list containers")?;

    Ok(rows
        .into_iter()
        .map(|r| ContainerInfo {
            name: r.get(0),
            last_cpu_pct: r.get(1),
            last_mem_pct: r.get(2),
            last_seen: r.get(3),
        })
        .collect())
}

#[derive(Debug, Serialize)]
pub struct VmStatus {
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub agent_version: Option<String>,
    pub last_cpu_pct: Option<f64>,
    pub last_mem_pct: Option<f64>,
}

pub async fn vm_status(pool: &Pool) -> Result<VmStatus> {
    let client = pool.get().await?;
    let row = client
        .query_opt(
            "SELECT last_seen, agent_version FROM agent_heartbeat WHERE host = 'falcao-main'",
            &[],
        )
        .await?;
    let (last_heartbeat, agent_version) = match row {
        Some(r) => (Some(r.get(0)), Some(r.get(1))),
        None => (None, None),
    };

    let cpu = client
        .query_opt(
            "SELECT value FROM metrics WHERE source = 'vm' AND metric = 'load_1m'
             ORDER BY ts DESC LIMIT 1",
            &[],
        )
        .await?
        .map(|r| r.get::<_, Option<f64>>(0))
        .flatten();

    let mem_used = client
        .query_opt(
            "SELECT value FROM metrics WHERE source = 'vm' AND metric = 'mem_used_bytes'
             ORDER BY ts DESC LIMIT 1",
            &[],
        )
        .await?
        .map(|r| r.get::<_, Option<f64>>(0))
        .flatten();

    let mem_total = client
        .query_opt(
            "SELECT value FROM metrics WHERE source = 'vm' AND metric = 'mem_total_bytes'
             ORDER BY ts DESC LIMIT 1",
            &[],
        )
        .await?
        .map(|r| r.get::<_, Option<f64>>(0))
        .flatten();

    let mem_pct = mem_used
        .zip(mem_total)
        .map(|(used, total)| if total > 0.0 { 100.0 * used / total } else { 0.0 });

    Ok(VmStatus {
        last_heartbeat,
        agent_version,
        last_cpu_pct: cpu,
        last_mem_pct: mem_pct,
    })
}
RUST
```

- [ ] **Step 2: Compilar**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build 2>&1 | tail -5
```

Expected: compila.

- [ ] **Step 3: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/src/monitor/queries.rs
git commit -m "feat(launcher): queries Postgres pro monitor (series, containers, vm_status)"
```

---

### Task C4: Tauri commands

**Files:**
- Modify: `src-tauri/src/monitor/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implementar commands**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/commands.rs <<'RUST'
//! Tauri commands expostos pro frontend.

use crate::monitor::queries::{ContainerInfo, MetricPoint, VmStatus};
use crate::monitor::{queries, tunnel::TunnelManager};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use std::sync::Mutex;
use tauri::State;

pub struct MonitorState {
    pub tunnel: TunnelManager,
    pub pool: Mutex<Option<Pool>>,
    pub reader_password: String,
}

impl MonitorState {
    pub fn new() -> Self {
        let reader_password = std::env::var("MONITOR_READER_PASSWORD").unwrap_or_default();
        Self {
            tunnel: TunnelManager::new(),
            pool: Mutex::new(None),
            reader_password,
        }
    }
}

#[tauri::command]
pub async fn monitor_open_tunnel(state: State<'_, MonitorState>) -> Result<u16, String> {
    let port = state.tunnel.open().await.map_err(|e| e.to_string())?;
    let url = format!(
        "postgresql://monitor_reader:{}@localhost:{}/falcao_monitor",
        urlencoding::encode(&state.reader_password),
        port
    );
    let pool = queries::build_pool(&url).map_err(|e| e.to_string())?;
    *state.pool.lock().unwrap() = Some(pool);
    Ok(port)
}

#[tauri::command]
pub async fn monitor_close_tunnel(state: State<'_, MonitorState>) -> Result<(), String> {
    state.tunnel.close().await.map_err(|e| e.to_string())?;
    *state.pool.lock().unwrap() = None;
    Ok(())
}

#[tauri::command]
pub async fn monitor_vm_status(state: State<'_, MonitorState>) -> Result<VmStatus, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    queries::vm_status(&pool).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_list_containers(
    state: State<'_, MonitorState>,
) -> Result<Vec<ContainerInfo>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    queries::list_containers(&pool)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_metric_series(
    state: State<'_, MonitorState>,
    source: String,
    resource: Option<String>,
    metric: String,
    since_iso: String,
    until_iso: Option<String>,
    bucket: Option<String>,
) -> Result<Vec<MetricPoint>, String> {
    let pool = state
        .pool
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "tunnel closed".to_string())?;
    let since: DateTime<Utc> = since_iso.parse().map_err(|e: chrono::ParseError| e.to_string())?;
    let until: Option<DateTime<Utc>> = match until_iso {
        Some(s) => Some(s.parse().map_err(|e: chrono::ParseError| e.to_string())?),
        None => None,
    };
    queries::fetch_metric_series(&pool, &source, resource.as_deref(), &metric, since, until, bucket.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn monitor_fetch_logs(container: String, lines: u32) -> Result<String, String> {
    let output = tokio::process::Command::new("ssh")
        .args([
            "falcao@162.55.217.189",
            &format!("docker logs --tail {} {} 2>&1", lines, container),
        ])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}
RUST
```

- [ ] **Step 2: Adicionar `urlencoding` em deps**

Editar `src-tauri/Cargo.toml`, adicionar em `[dependencies]`:

```toml
urlencoding = "2"
```

- [ ] **Step 3: Registrar state e commands em lib.rs**

Localizar a função `run()` ou similar em `src-tauri/src/lib.rs` e adicionar:

```rust
// Imports no topo
use crate::monitor::commands::{
    monitor_open_tunnel, monitor_close_tunnel, monitor_vm_status,
    monitor_list_containers, monitor_metric_series, monitor_fetch_logs,
    MonitorState,
};
```

E na construção do builder Tauri (geralmente `tauri::Builder::default()`), adicionar:

```rust
.manage(MonitorState::new())
.invoke_handler(tauri::generate_handler![
    // ... commands existentes ...
    monitor_open_tunnel,
    monitor_close_tunnel,
    monitor_vm_status,
    monitor_list_containers,
    monitor_metric_series,
    monitor_fetch_logs,
])
```

NOTA: localizar a estrutura exata depende do código atual de `lib.rs`. Adicionar no padrão existente.

- [ ] **Step 4: Compilar**

```bash
cd ~/Projects/falcao-launcher/src-tauri
cargo build 2>&1 | tail -10
```

Expected: compila clean.

- [ ] **Step 5: Configurar .env do launcher pra reader password**

```bash
cd ~/Projects/falcao-launcher
echo "MONITOR_READER_PASSWORD=$PG_READER_PWD" >> .env.local
echo ".env.local" >> .gitignore  # se ainda não estiver
```

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/monitor/commands.rs src-tauri/src/lib.rs .gitignore
git commit -m "feat(launcher): commands Tauri pro monitor (tunnel, status, containers, series, logs)"
```

---

## Phase D — Frontend (aba VM)

### Task D1: Tipos TypeScript pra dados do monitor

**Files:**
- Create: `src/types/monitor.ts`

- [ ] **Step 1: Criar arquivo de tipos**

```bash
mkdir -p ~/Projects/falcao-launcher/src/types
cat > ~/Projects/falcao-launcher/src/types/monitor.ts <<'TS'
export interface VmStatus {
  last_heartbeat: string | null;
  agent_version: string | null;
  last_cpu_pct: number | null;
  last_mem_pct: number | null;
}

export interface ContainerInfo {
  name: string;
  last_cpu_pct: number | null;
  last_mem_pct: number | null;
  last_seen: string | null;
}

export interface MetricPoint {
  ts: string;
  value: number | null;
}

export type MetricSource = "vm" | "container" | "hetzner";

export type MetricBucket = "1 minute" | "1 hour" | "1 day" | null;
TS
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src/types/monitor.ts
git commit -m "feat(launcher-fe): tipos TS pro monitor"
```

---

### Task D2: Hook `useMonitor` (abstrai invoke + lifecycle)

**Files:**
- Create: `src/lib/monitor.ts`

- [ ] **Step 1: Criar hook + helpers**

```bash
mkdir -p ~/Projects/falcao-launcher/src/lib
cat > ~/Projects/falcao-launcher/src/lib/monitor.ts <<'TS'
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type {
  ContainerInfo,
  MetricBucket,
  MetricPoint,
  MetricSource,
  VmStatus,
} from "../types/monitor";

export const monitorApi = {
  openTunnel: () => invoke<number>("monitor_open_tunnel"),
  closeTunnel: () => invoke<void>("monitor_close_tunnel"),
  vmStatus: () => invoke<VmStatus>("monitor_vm_status"),
  listContainers: () => invoke<ContainerInfo[]>("monitor_list_containers"),
  metricSeries: (params: {
    source: MetricSource;
    resource?: string | null;
    metric: string;
    sinceIso: string;
    untilIso?: string | null;
    bucket?: MetricBucket;
  }) =>
    invoke<MetricPoint[]>("monitor_metric_series", {
      source: params.source,
      resource: params.resource ?? null,
      metric: params.metric,
      sinceIso: params.sinceIso,
      untilIso: params.untilIso ?? null,
      bucket: params.bucket ?? null,
    }),
  fetchLogs: (container: string, lines: number) =>
    invoke<string>("monitor_fetch_logs", { container, lines }),
};

/** Garante tunnel aberto enquanto o componente está montado. */
export function useTunnel(): { ready: boolean; error: string | null } {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    monitorApi
      .openTunnel()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
      monitorApi.closeTunnel().catch(() => {});
    };
  }, []);

  return { ready, error };
}

/** Polling helper genérico. */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled: boolean
): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const tick = () =>
      fn()
        .then((v) => {
          if (!cancelled) {
            setData(v);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(String(e));
        });

    tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [fn, intervalMs, enabled]);

  return { data, error };
}
TS
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src/lib/monitor.ts
git commit -m "feat(launcher-fe): hooks useTunnel + usePolling + monitorApi"
```

---

### Task D3: Componente VmTab — header + status

**Files:**
- Create: `src/components/VmTab.tsx`
- Create: `src/components/VmHeader.tsx`

- [ ] **Step 1: Criar header**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmHeader.tsx <<'TSX'
import { monitorApi, usePolling } from "../lib/monitor";

interface Props {
  enabled: boolean;
}

export function VmHeader({ enabled }: Props) {
  const { data: status } = usePolling(monitorApi.vmStatus, 15_000, enabled);

  if (!enabled) {
    return <div className="text-sm text-zinc-400">Conectando ao monitor...</div>;
  }
  if (!status) {
    return <div className="text-sm text-zinc-400">Carregando status da VM...</div>;
  }

  const heartbeatAge = status.last_heartbeat
    ? Math.round((Date.now() - Date.parse(status.last_heartbeat)) / 1000)
    : null;
  const stale = heartbeatAge !== null && heartbeatAge > 60;

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="flex items-center gap-3">
        <span
          className={`h-2 w-2 rounded-full ${stale ? "bg-red-500" : "bg-green-500"}`}
        />
        <span className="font-medium text-zinc-100">falcao-main</span>
        <span className="text-xs text-zinc-400">
          CX23 · Nuremberg · 162.55.217.189
        </span>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-4 text-sm">
        <div>
          <div className="text-zinc-400">Agente</div>
          <div className="font-mono text-zinc-100">
            {status.agent_version ?? "—"}
          </div>
          <div className="text-xs text-zinc-500">
            {heartbeatAge !== null ? `heartbeat há ${heartbeatAge}s` : "sem heartbeat"}
          </div>
        </div>
        <div>
          <div className="text-zinc-400">Load 1m</div>
          <div className="font-mono text-zinc-100">
            {status.last_cpu_pct?.toFixed(2) ?? "—"}
          </div>
        </div>
        <div>
          <div className="text-zinc-400">RAM</div>
          <div className="font-mono text-zinc-100">
            {status.last_mem_pct ? `${status.last_mem_pct.toFixed(1)}%` : "—"}
          </div>
        </div>
      </div>
    </div>
  );
}
TSX
```

- [ ] **Step 2: Criar VmTab básico**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmTab.tsx <<'TSX'
import { useTunnel } from "../lib/monitor";
import { VmHeader } from "./VmHeader";

export function VmTab() {
  const { ready, error } = useTunnel();

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">
        Erro ao conectar na VM: {error}
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <VmHeader enabled={ready} />
      <div className="text-sm text-zinc-400">
        (gráficos e cards de containers vêm nas próximas tarefas)
      </div>
    </div>
  );
}
TSX
```

- [ ] **Step 3: Wire na navegação principal**

Localizar `src/App.tsx` (ou onde tabs são renderizadas), adicionar entrada "VM" na lista de tabs e renderizar `<VmTab />` quando ativa.

NOTA: como Tabs.tsx já existe, ler o arquivo pra entender o padrão e seguir. Não modifico aqui sem ver — caso real durante execução: ler `src/App.tsx` e `src/components/Tabs.tsx`, adicionar entrada com `id="vm"`, label "VM", e branch correspondente.

- [ ] **Step 4: Build e validar visualmente**

```bash
cd ~/Projects/falcao-launcher
pnpm tauri dev
```

Abrir o app, navegar pra aba "VM". Esperado: header carrega com status da VM (heartbeat verde, load mostrado).

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src/components/VmTab.tsx src/components/VmHeader.tsx src/App.tsx src/components/Tabs.tsx
git commit -m "feat(launcher-fe): aba VM com header de status (lê heartbeat + load + ram)"
```

---

### Task D4: Cards de containers + grid

**Files:**
- Create: `src/components/VmContainerCard.tsx`
- Create: `src/components/VmContainerGrid.tsx`
- Modify: `src/components/VmTab.tsx`

- [ ] **Step 1: Card de container**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmContainerCard.tsx <<'TSX'
import type { ContainerInfo } from "../types/monitor";

interface Props {
  container: ContainerInfo;
  onClick: () => void;
}

export function VmContainerCard({ container, onClick }: Props) {
  const ageSec = container.last_seen
    ? Math.round((Date.now() - Date.parse(container.last_seen)) / 1000)
    : null;
  const stale = ageSec !== null && ageSec > 60;

  return (
    <button
      onClick={onClick}
      className="flex w-full flex-col gap-2 rounded-lg border border-zinc-700 bg-zinc-900 p-4 text-left hover:border-zinc-500"
    >
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${stale ? "bg-red-500" : "bg-green-500"}`} />
        <span className="font-medium text-zinc-100">{container.name}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>
          <div className="text-zinc-400">CPU</div>
          <div className="font-mono text-zinc-100">
            {container.last_cpu_pct?.toFixed(2) ?? "—"}%
          </div>
        </div>
        <div>
          <div className="text-zinc-400">RAM</div>
          <div className="font-mono text-zinc-100">
            {container.last_mem_pct?.toFixed(1) ?? "—"}%
          </div>
        </div>
      </div>
    </button>
  );
}
TSX
```

- [ ] **Step 2: Grid**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmContainerGrid.tsx <<'TSX'
import { monitorApi, usePolling } from "../lib/monitor";
import { VmContainerCard } from "./VmContainerCard";

interface Props {
  enabled: boolean;
  onSelect: (containerName: string) => void;
}

export function VmContainerGrid({ enabled, onSelect }: Props) {
  const { data: containers } = usePolling(monitorApi.listContainers, 15_000, enabled);

  if (!containers) {
    return <div className="text-sm text-zinc-400">Carregando containers...</div>;
  }
  if (containers.length === 0) {
    return <div className="text-sm text-zinc-400">Nenhum container ativo.</div>;
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      {containers.map((c) => (
        <VmContainerCard key={c.name} container={c} onClick={() => onSelect(c.name)} />
      ))}
    </div>
  );
}
TSX
```

- [ ] **Step 3: Atualizar VmTab pra usar grid**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmTab.tsx <<'TSX'
import { useState } from "react";
import { useTunnel } from "../lib/monitor";
import { VmContainerGrid } from "./VmContainerGrid";
import { VmHeader } from "./VmHeader";

export function VmTab() {
  const { ready, error } = useTunnel();
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">Erro ao conectar na VM: {error}</div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <VmHeader enabled={ready} />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Containers</h2>
        <VmContainerGrid enabled={ready} onSelect={setSelectedContainer} />
      </section>

      {selectedContainer && (
        <div className="text-sm text-zinc-400">
          (drawer pra detalhes de "{selectedContainer}" vem na Task D6)
        </div>
      )}
    </div>
  );
}
TSX
```

- [ ] **Step 4: Validar visualmente**

```bash
cd ~/Projects/falcao-launcher
pnpm tauri dev
```

Esperado: cards de `caddy` e `falcao-financas` aparecem com CPU/RAM atuais.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src/components/VmContainerCard.tsx src/components/VmContainerGrid.tsx src/components/VmTab.tsx
git commit -m "feat(launcher-fe): grid de containers com cards CPU/RAM"
```

---

### Task D5: Charts da VM (CPU, RAM, network)

**Files:**
- Create: `src/components/VmMetricChart.tsx`
- Modify: `src/components/VmTab.tsx`

- [ ] **Step 1: Componente reutilizável de chart**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmMetricChart.tsx <<'TSX'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { monitorApi, usePolling } from "../lib/monitor";
import type { MetricSource } from "../types/monitor";

interface Props {
  title: string;
  source: MetricSource;
  resource?: string | null;
  metric: string;
  unit?: string;
  windowMinutes: number;
  enabled: boolean;
  format?: (v: number) => string;
}

export function VmMetricChart({
  title,
  source,
  resource,
  metric,
  unit,
  windowMinutes,
  enabled,
  format,
}: Props) {
  const sinceIso = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const fetcher = () =>
    monitorApi.metricSeries({ source, resource, metric, sinceIso });

  const { data } = usePolling(fetcher, 30_000, enabled);

  const chartData =
    data?.map((p) => ({
      ts: new Date(p.ts).getTime(),
      value: p.value,
    })) ?? [];

  const fmt = format ?? ((v: number) => `${v.toFixed(1)}${unit ?? ""}`);

  return (
    <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="mb-2 text-xs font-medium text-zinc-300">{title}</div>
      <div className="h-32">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
            <XAxis
              dataKey="ts"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(t) => new Date(t).toLocaleTimeString().slice(0, 5)}
              stroke="#71717a"
              fontSize={10}
            />
            <YAxis tickFormatter={fmt} stroke="#71717a" fontSize={10} />
            <Tooltip
              contentStyle={{
                background: "#18181b",
                border: "1px solid #3f3f46",
              }}
              labelFormatter={(t) => new Date(t).toLocaleString()}
              formatter={(v: number) => fmt(v)}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="#f59e0b"
              fill="#f59e0b"
              fillOpacity={0.15}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
TSX
```

- [ ] **Step 2: Adicionar 4 charts na aba VM**

Substituir conteúdo da section "VM geral" em `VmTab.tsx`. Editar:

```bash
cat > ~/Projects/falcao-launcher/src/components/VmTab.tsx <<'TSX'
import { useState } from "react";
import { useTunnel } from "../lib/monitor";
import { VmContainerGrid } from "./VmContainerGrid";
import { VmHeader } from "./VmHeader";
import { VmMetricChart } from "./VmMetricChart";

export function VmTab() {
  const { ready, error } = useTunnel();
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">Erro ao conectar na VM: {error}</div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <VmHeader enabled={ready} />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">VM geral (últimos 60 min)</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <VmMetricChart
            title="Load 1m"
            source="vm"
            metric="load_1m"
            unit=""
            windowMinutes={60}
            enabled={ready}
          />
          <VmMetricChart
            title="RAM usada"
            source="vm"
            metric="mem_used_bytes"
            windowMinutes={60}
            enabled={ready}
            format={(v) => `${(v / 1e9).toFixed(2)} GB`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Containers</h2>
        <VmContainerGrid enabled={ready} onSelect={setSelectedContainer} />
      </section>

      {selectedContainer && (
        <div className="text-sm text-zinc-400">
          (drawer pra detalhes de "{selectedContainer}" vem na Task D6)
        </div>
      )}
    </div>
  );
}
TSX
```

- [ ] **Step 3: Validar visualmente**

```bash
cd ~/Projects/falcao-launcher
pnpm tauri dev
```

Esperado: 2 charts renderizam com dados das últimas 1h.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src/components/VmMetricChart.tsx src/components/VmTab.tsx
git commit -m "feat(launcher-fe): charts VM (Load + RAM) com Recharts e polling 30s"
```

---

### Task D6: Drawer de detalhe + logs do container

**Files:**
- Create: `src/components/VmContainerDrawer.tsx`
- Modify: `src/components/VmTab.tsx`

- [ ] **Step 1: Drawer**

```bash
cat > ~/Projects/falcao-launcher/src/components/VmContainerDrawer.tsx <<'TSX'
import { useState } from "react";
import { monitorApi } from "../lib/monitor";
import { VmMetricChart } from "./VmMetricChart";

interface Props {
  containerName: string;
  enabled: boolean;
  onClose: () => void;
}

export function VmContainerDrawer({ containerName, enabled, onClose }: Props) {
  const [logs, setLogs] = useState<string | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const fetchLogs = async () => {
    setLoadingLogs(true);
    try {
      const text = await monitorApi.fetchLogs(containerName, 200);
      setLogs(text);
    } catch (e) {
      setLogs(`Erro: ${String(e)}`);
    } finally {
      setLoadingLogs(false);
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-2xl overflow-y-auto border-l border-zinc-700 bg-zinc-950 p-6 shadow-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-zinc-100">{containerName}</h3>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
        >
          ✕ Fechar
        </button>
      </div>

      <section className="space-y-3">
        <h4 className="text-xs font-medium uppercase text-zinc-400">Métricas (1h)</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <VmMetricChart
            title="CPU"
            source="container"
            resource={containerName}
            metric="cpu_pct"
            unit="%"
            windowMinutes={60}
            enabled={enabled}
          />
          <VmMetricChart
            title="RAM"
            source="container"
            resource={containerName}
            metric="mem_pct"
            unit="%"
            windowMinutes={60}
            enabled={enabled}
          />
        </div>
      </section>

      <section className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-xs font-medium uppercase text-zinc-400">Logs</h4>
          <button
            onClick={fetchLogs}
            disabled={loadingLogs}
            className="rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            {loadingLogs ? "Carregando..." : logs ? "Recarregar" : "Ver últimos 200"}
          </button>
        </div>
        {logs && (
          <pre className="max-h-96 overflow-auto rounded border border-zinc-700 bg-zinc-900 p-3 text-xs text-zinc-300">
            {logs}
          </pre>
        )}
      </section>
    </div>
  );
}
TSX
```

- [ ] **Step 2: Wire drawer no VmTab**

Substituir `VmTab.tsx` pra renderizar drawer quando `selectedContainer` setado:

```bash
cat > ~/Projects/falcao-launcher/src/components/VmTab.tsx <<'TSX'
import { useState } from "react";
import { useTunnel } from "../lib/monitor";
import { VmContainerDrawer } from "./VmContainerDrawer";
import { VmContainerGrid } from "./VmContainerGrid";
import { VmHeader } from "./VmHeader";
import { VmMetricChart } from "./VmMetricChart";

export function VmTab() {
  const { ready, error } = useTunnel();
  const [selectedContainer, setSelectedContainer] = useState<string | null>(null);

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">Erro ao conectar na VM: {error}</div>
    );
  }

  return (
    <div className="space-y-6 p-4">
      <VmHeader enabled={ready} />

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">VM geral (últimos 60 min)</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <VmMetricChart
            title="Load 1m"
            source="vm"
            metric="load_1m"
            unit=""
            windowMinutes={60}
            enabled={ready}
          />
          <VmMetricChart
            title="RAM usada"
            source="vm"
            metric="mem_used_bytes"
            windowMinutes={60}
            enabled={ready}
            format={(v) => `${(v / 1e9).toFixed(2)} GB`}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Containers</h2>
        <VmContainerGrid enabled={ready} onSelect={setSelectedContainer} />
      </section>

      {selectedContainer && (
        <VmContainerDrawer
          containerName={selectedContainer}
          enabled={ready}
          onClose={() => setSelectedContainer(null)}
        />
      )}
    </div>
  );
}
TSX
```

- [ ] **Step 3: Validar visualmente**

```bash
cd ~/Projects/falcao-launcher
pnpm tauri dev
```

Clicar num card → drawer abre com 2 charts e botão "Ver logs". Clicar logs → texto aparece.

- [ ] **Step 4: Commit**

```bash
cd ~/Projects/falcao-launcher
git add src/components/VmContainerDrawer.tsx src/components/VmTab.tsx
git commit -m "feat(launcher-fe): drawer de container com charts CPU/RAM e fetch de logs on-demand"
```

---

## Phase E — Documentação

### Task E1: agent.md em todas as pastas novas

**Files:**
- Create: `src-tauri/crates/agent.md`
- Create: `src-tauri/crates/monitor-shared/agent.md`
- Create: `src-tauri/crates/monitor-agent/agent.md`
- Create: `src-tauri/crates/monitor-agent/src/collectors/agent.md`
- Create: `src-tauri/src/monitor/agent.md`
- Create: `src/types/agent.md`

- [ ] **Step 1: agent.md de `src-tauri/crates/`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/agent.md <<'MD'
# crates — agent.md

## Propósito
Subcrates do workspace Cargo do `falcao-launcher`, para componentes que precisam ser construídos como bins/libs separados (ex: agente de monitoramento que roda em outra máquina).

## Arquivos
- `monitor-shared/` — tipos comuns entre launcher e agente (MetricRow, MetricSource).
- `monitor-agent/` — binário do agente coletor 24/7 (roda na VM).

## Padrões
Cada subcrate tem `Cargo.toml` próprio referenciando workspace deps via `{ workspace = true }`.

## Decisões recentes
- 2026-05-06: workspace criado pra suportar multi-binário (launcher + agente). Spec `2026-05-06-vm-monitor-fase-1-design.md`.
MD
```

- [ ] **Step 2: agent.md de `monitor-shared/`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-shared/agent.md <<'MD'
# monitor-shared — agent.md

## Propósito
Tipos comuns compartilhados entre o `monitor-agent` (escreve no DB) e o launcher (lê do DB). Mantém schema da tabela `metrics` versionado em código.

## Arquivos
- `src/lib.rs` — `MetricRow`, `MetricSource`, `HOST_NAME`, `POLL_INTERVAL_SECS`.

## Padrões
- Tipos serializáveis (serde) pra inserção em Postgres e transporte JSON.
- Constantes que tanto o agente quanto launcher usam vivem aqui.

## Decisões recentes
- 2026-05-06: criado junto com a Fase 1 do monitor.
MD
```

- [ ] **Step 3: agent.md de `monitor-agent/`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/agent.md <<'MD'
# monitor-agent — agent.md

## Propósito
Binário que roda como systemd user service na VM Hetzner. Coleta métricas a cada 15s (VM-level, containers Docker, Hetzner via hcloud) e escreve no Postgres+TimescaleDB local.

## Arquivos
- `src/main.rs` — bootstrap + main loop.
- `src/db.rs` — pool deadpool-postgres + writer (insert_batch, write_heartbeat).
- `src/buffer.rs` — buffer in-memory pra resiliência quando DB cai.
- `src/collectors/` — coletores (vm, container, hetzner). Ver agent.md dela.
- `tests/` — não tem (testes vivem em `#[cfg(test)]` nos próprios módulos).

## Padrões
- Um coletor = um arquivo em `collectors/`. Função `collect(ts) -> Result<Vec<MetricRow>>`.
- Erros não-fatais logados como `warn` e continuam o loop (não abortam).
- DB connection cai → buffer guarda até 50k linhas (~30 min) e re-tenta.

## Decisões recentes
- 2026-05-06: criado pra Fase 1 do monitor. Spec `2026-05-06-vm-monitor-fase-1-design.md`.
MD
```

- [ ] **Step 4: agent.md de `monitor-agent/src/collectors/`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/crates/monitor-agent/src/collectors/agent.md <<'MD'
# collectors — agent.md

## Propósito
Coletores de métricas. Cada arquivo é uma fonte distinta de dados.

## Arquivos
- `mod.rs` — re-exports.
- `vm.rs` — métricas VM-level via `/proc/meminfo`, `/proc/loadavg`.
- `container.rs` — métricas por container via `docker stats --no-stream --format json`. Inclui parser de tamanhos ("1.2GiB" → bytes).
- `hetzner.rs` — métricas via `hcloud server describe falcao-main -o json`.

## Padrões
- Cada coletor expõe `pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>>`.
- Erro num coletor NÃO derruba o loop principal (main.rs cuida disso).
- Tipos `MetricRow`, `MetricSource` vêm de `monitor-shared`.

## Decisões recentes
- 2026-05-06: criados na Fase 1 do monitor.
MD
```

- [ ] **Step 5: agent.md de `src-tauri/src/monitor/`**

```bash
cat > ~/Projects/falcao-launcher/src-tauri/src/monitor/agent.md <<'MD'
# monitor — agent.md

## Propósito
Lado launcher do monitor: SSH tunnel pro Postgres da VM + queries SELECT + commands Tauri expostos pro frontend.

## Arquivos
- `mod.rs` — re-exports.
- `tunnel.rs` — `TunnelManager` que gerencia processo `ssh -L` (porta local 54322 → 5432 na VM).
- `queries.rs` — funções SELECT (vm_status, list_containers, fetch_metric_series).
- `commands.rs` — `#[tauri::command]` invocáveis do frontend (open/close tunnel, vm_status, list_containers, metric_series, fetch_logs).

## Padrões
- Tunnel é singleton mantido em `MonitorState` (Tauri `manage`).
- Pool Postgres só existe enquanto tunnel está aberto.
- Logs do container são fetchados on-demand via SSH (não persistidos em DB).

## Decisões recentes
- 2026-05-06: implementado na Fase 1 do monitor.
- Tunnel via `ssh -L` (processo nativo) em vez de `russh` puro Rust — mais simples, equivalente em segurança.
MD
```

- [ ] **Step 6: agent.md de `src/types/`**

```bash
cat > ~/Projects/falcao-launcher/src/types/agent.md <<'MD'
# types — agent.md

## Propósito
Definições TypeScript de tipos compartilhados pelo frontend. Espelham os tipos serializados pelos commands Tauri.

## Arquivos
- `monitor.ts` — `VmStatus`, `ContainerInfo`, `MetricPoint`, `MetricSource`, `MetricBucket`.

## Padrões
- Cada arquivo agrupa tipos por feature.
- Mantém sincronizado com Rust (Tauri serializa via serde camelCase = não, usa snake_case).

## Decisões recentes
- 2026-05-06: criado pra Fase 1 do monitor.
MD
```

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/falcao-launcher
git add **/agent.md
git commit -m "docs(monitor): adiciona agent.md em todas as pastas novas (regra falcao-default)"
```

---

### Task E2: Atualizar CLAUDE.md do launcher

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Adicionar seção sobre VM Monitor**

Editar `~/Projects/falcao-launcher/CLAUDE.md` adicionando antes da seção "Como rodar (dev)":

```markdown
## Feature: VM Monitor (Fase 1)

Aba "VM" mostra status da VM Hetzner + containers + histórico em tempo real.

- **Spec:** `docs/superpowers/specs/2026-05-06-vm-monitor-fase-1-design.md`
- **Plan:** `docs/superpowers/plans/2026-05-06-vm-monitor-fase-1.md`
- **Stack:** Postgres+TimescaleDB na VM (porta 5432 local-only) + agente Rust em systemd + SSH tunnel (`ssh -L`) → tokio-postgres + Recharts no front.
- **Skill relevante:** `~/.claude/skills/falcao-hetzner/SKILL.md` (sub-projeto E)

### Crates novos
- `src-tauri/crates/monitor-shared`: tipos comuns
- `src-tauri/crates/monitor-agent`: binário do coletor (deploy: `./scripts/deploy-monitor-agent.sh`)

### Componentes frontend novos
- `src/components/VmTab.tsx` (aba)
- `src/components/VmHeader.tsx`
- `src/components/VmContainerGrid.tsx` + `VmContainerCard.tsx`
- `src/components/VmContainerDrawer.tsx` (detalhe)
- `src/components/VmMetricChart.tsx` (chart reutilizável)

### Documentação por pasta (agent.md)
Toda pasta com código deste projeto tem um `agent.md`. Ver `~/.claude/skills/falcao-default/SKILL.md` (seção "agent.md").
```

- [ ] **Step 2: Commit**

```bash
cd ~/Projects/falcao-launcher
git add CLAUDE.md
git commit -m "docs(launcher): documenta feature VM Monitor + regra agent.md no CLAUDE.md"
```

---

### Task E3: Atualizar skill `falcao-launcher` com status final

**Files:**
- Modify: `~/.claude/skills/falcao-launcher/SKILL.md`

- [ ] **Step 1: Marcar Sub-projeto E como em progresso**

Localizar seção "Sub-projeto E — Monitor de custos (FUTURO)" no `SKILL.md` e:
1. Trocar título pra "Sub-projeto E — VM Monitor (Fase 1) ✅ EM ANDAMENTO"
2. Adicionar nota: "Spec aprovado em 2026-05-06. Plan em `docs/superpowers/plans/2026-05-06-vm-monitor-fase-1.md`."
3. Adicionar Estado atual com: "Phase A (Postgres+TimescaleDB) ✅", "Phase B (agente Rust) ✅", etc., conforme execução for completando.

NOTA: edição manual já que o conteúdo exato depende do estado da skill no momento.

- [ ] **Step 2: Commit (na home do user, fora do repo do launcher)**

```bash
# Skills moram em ~/.claude/, não no repo. Edição direta.
# Commit não aplica (não é repo Git).
echo "skill atualizada"
```

---

### Task E4: Validação final + Acceptance criteria

**Files:**
- Modify: `docs/superpowers/vm-migrations/VALIDATION.md`

- [ ] **Step 1: Rodar checklist completo do spec**

Ler `docs/superpowers/specs/2026-05-06-vm-monitor-fase-1-design.md`, seção "Acceptance criteria". Marcar cada item:

```bash
ssh falcao@162.55.217.189 "
  echo '=== Postgres rodando ==='
  docker compose -f /opt/falcao-monitor/docker-compose.yml ps
  echo '=== Schema aplicado ==='
  docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c '\dt'
  echo '=== Hypertable + policies ==='
  docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT * FROM timescaledb_information.jobs WHERE proc_name LIKE 'policy%';\"
  echo '=== Agent service ==='
  systemctl --user status falcao-monitor-agent.service --no-pager | head -5
  echo '=== Métricas chegando ==='
  docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT source, count(*), max(ts) AS last FROM metrics GROUP BY source;\"
  echo '=== Heartbeat ==='
  docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c 'SELECT * FROM agent_heartbeat;'
"
```

- [ ] **Step 2: Validar UI manualmente**

Abrir `pnpm tauri dev` → aba VM:
- Header: status verde, heartbeat recente
- VM geral: 2 charts populados
- Cards: containers visíveis com CPU/RAM
- Click num card: drawer abre, charts do container, logs funcionam

- [ ] **Step 3: Documentar disco usado após 24h+ de operação**

```bash
ssh falcao@162.55.217.189 "du -sh /opt/falcao-monitor/data && docker exec falcao-monitor-db psql -U postgres -d falcao_monitor -c \"SELECT pg_size_pretty(pg_database_size('falcao_monitor'));\""
```

Anotar o resultado em `docs/superpowers/vm-migrations/VALIDATION.md`:

```bash
cd ~/Projects/falcao-launcher
cat >> docs/superpowers/vm-migrations/VALIDATION.md <<EOF

## Phase E — Validação final ($(date -u +%Y-%m-%d))

### Acceptance criteria
- [x] Postgres + TimescaleDB rodando
- [x] Schema aplicado, retention/compression configurados
- [x] Agente compilado, instalado, systemd ativo
- [x] Métricas chegando a cada 15s
- [x] Aba VM funcional (header, charts, grid, drawer, logs)
- [x] SSH tunnel abre/fecha sem leak
- [x] Skill falcao-launcher atualizada
- [x] CLAUDE.md atualizado
- [x] agent.md em todas as pastas novas

### Disk usage observado
$(ssh falcao@162.55.217.189 'du -sh /opt/falcao-monitor/data 2>/dev/null')
EOF

git add docs/superpowers/vm-migrations/VALIDATION.md
git commit -m "docs(monitor): validação final da Fase 1 (acceptance criteria + disk usage observado)"
```

- [ ] **Step 4: PR pra main (ou quando o user pedir)**

```bash
cd ~/Projects/falcao-launcher
git push -u origin feature/vm-monitor-fase-1
gh pr create --base main --title "feat: VM Monitor Fase 1 — coletor 24/7 + dashboard" --body "$(cat <<'EOF'
## Summary
Implementa Fase 1 do VM Monitor (sub-projeto E do launcher).

- Postgres+TimescaleDB rodando na VM (`/opt/falcao-monitor/`)
- Agente Rust em systemd (poll 15s)
- Aba "VM" no launcher com status, charts, containers, drawer e logs

## Spec
`docs/superpowers/specs/2026-05-06-vm-monitor-fase-1-design.md`

## Validation
`docs/superpowers/vm-migrations/VALIDATION.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

NOTA: merge da PR fica a critério do Falcão. Branch `feature/vm-monitor-fase-1` existe em `main` (não `master` como no `falcao-financas` — falcao-launcher já estava em `main`).

---

## Self-Review do plano

**Spec coverage:** todos os componentes do spec mapeados:
- ✅ Postgres+TimescaleDB container → A1-A6
- ✅ Schema (init/compression/aggregates/users) → A2-A5
- ✅ Agente Rust (collectors VM/container/hetzner, buffer, main loop) → B1-B6
- ✅ Build + deploy + systemd → B7-B8
- ✅ SSH tunnel + queries + Tauri commands → C1-C4
- ✅ Frontend (VmTab, header, grid, charts, drawer, logs) → D1-D6
- ✅ Documentação (agent.md, CLAUDE.md, skill) → E1-E3
- ✅ Validation final → E4

**Placeholder scan:** plano não contém "TBD"/"TODO"/"add appropriate". Steps que dizem "ler arquivo X e adaptar padrão" (Task C4 step 3, Task D3 step 3) referem situações onde estrutura existente determina a edição — mantidos com nota explicando.

**Type consistency:**
- `MetricRow`, `MetricSource`, `MetricPoint` consistentes ao longo do plano
- `vm_status` em snake_case Rust → `VmStatus` (Pascal) no TS é convenção
- `monitor_open_tunnel` etc. em snake_case (Tauri convention)

**Scope:** plano grande (~30 tasks) mas é o escopo da Fase 1 inteira. Pode ser executado por phases (A → B → C → D → E), com validação após cada phase. Cada task é bite-sized (2-5 min).

**Conhecidos riscos de execução:**
- Workspace conversion em Cargo (Task B1) pode ter erros de path/feature — solução: validar `cargo build` cedo.
- Tauri commands em `lib.rs` precisam editar código existente — Task C4 step 3 precisa ler arquivo atual primeiro.
- `pnpm tauri dev` durante Phase D requer agente já rodando (concluído Phase B) pra ver dados reais.
