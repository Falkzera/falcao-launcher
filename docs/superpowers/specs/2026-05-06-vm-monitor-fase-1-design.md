# VM Monitor — Fase 1 (Coletor + Dashboard básico)

**Data:** 2026-05-06
**Autor:** Falcão (supervisão) + Claude (escrita)
**Status:** aprovado (pré-implementação)

---

## Contexto

Falcão tem 1 VM Hetzner (`falcao-main`, CX23, Nuremberg) hospedando backends de projetos pessoais e, futuramente, projetos de produção (`Sonar`, `SIGOF` — atualmente no Railway). Precisa de monitoramento 24/7 com:

- Métricas detalhadas da VM e por container
- Histórico persistido
- Visualização integrada ao fluxo de trabalho (dentro do `falcao-launcher`)
- Base pra futuras fases: alertas, anomaly detection, integração Claude

**Princípio orientador:** construir do zero por aprendizado/portfólio/independência. Sem dependência de SaaS (Netdata Cloud, Datadog, etc.).

**Escopo da Fase 1:** coletor 24/7 na VM + persistência em Postgres local da VM + aba "VM" no launcher mostrando dashboard atual e histórico. Sem alertas, sem anomaly detection, sem integração Claude (essas são Fases 2-5).

## Objetivos

1. Coletar métricas a cada 15s sem gaps (24/7)
2. Persistir histórico longo (anos) sem comprometer disco da VM
3. Dashboard responsivo na aba "VM" do launcher mostrando estado atual + tendências
4. Drill-down por projeto/container (CPU, RAM, network, status do health endpoint)
5. Custo Hetzner estimado em tempo real (calculado: `uptime × preço/h`)
6. Logs de containers acessíveis on-demand (sem persistir em DB)

## Não-objetivos (Fase 1)

- Health checks externos do tipo UptimeRobot (Fase 2)
- Sistema de alertas configuráveis com push pro celular (Fase 3)
- Anomaly detection estatística ou ML (Fase 4)
- Botão "Investigar com Claude" com contexto pré-populado (Fase 5)
- Integração com APIs de Vercel/Supabase/GitHub Actions (futuro)
- Persistir logs de containers em DB (sempre on-demand via SSH)
- Dashboards customizáveis pelo usuário (UI fixa nesta fase)
- Multi-VM (apenas `falcao-main`)

## Arquitetura

```
┌─────────────────────────────────────────────────────────────────┐
│ VM Hetzner (162.55.217.189)                                     │
│                                                                  │
│  ┌────────────────────────┐     ┌───────────────────────────┐  │
│  │ Apps existentes        │     │ Stack monitoramento (NEW) │  │
│  │ ├── caddy              │     │                           │  │
│  │ └── falcao-financas    │     │ ┌─ Agente coletor ──────┐ │  │
│  │  (futuros: Sonar, …)   │◄────┤ │ Rust binary           │ │  │
│  │                        │     │ │ systemd user service  │ │  │
│  │                        │     │ │ poll a cada 15s       │ │  │
│  └────────────────────────┘     │ └──────────┬────────────┘ │  │
│                                  │             ▼              │  │
│                                  │ ┌─ Postgres + Timescale ─┐│  │
│                                  │ │ container Docker       ││  │
│                                  │ │ porta 5432 local-only  ││  │
│                                  │ │ volume persistente     ││  │
│                                  │ └────────────────────────┘│  │
│                                  └───────────────────────────┘  │
│                                              ▲                   │
│                                              │ SSH tunnel        │
└──────────────────────────────────────────────│───────────────────┘
                                               │
                            (porta local 54322 │ → 5432 da VM)
                                               │
┌──────────────────────────────────────────────│───────────────────┐
│ Máquina do Falcão                            │                   │
│                                              │                   │
│  falcao-launcher (Tauri + React)             │                   │
│  └─ Aba "VM" ────────────────────────────────┘                   │
│     ├─ Tauri abre tunnel quando aba abre                         │
│     ├─ React renderiza dashboards (Recharts)                      │
│     └─ Tunnel fecha quando aba fecha                              │
└──────────────────────────────────────────────────────────────────┘
```

## Componentes

### 1. Postgres + TimescaleDB (container Docker na VM)

**Imagem:** `timescale/timescaledb-ha:pg16-latest` (oficial, mantida pela Timescale Inc.)

**Localização na VM:** `/opt/falcao-monitor/`

**Estrutura:**
```
/opt/falcao-monitor/
├── docker-compose.yml
├── data/                    # volume Postgres (persistente)
└── migrations/              # SQL versionado
    ├── 001_init.sql
    ├── 002_compression.sql
    └── 003_continuous_aggregates.sql
```

**Configuração do container:**
- Porta `5432` exposta apenas em `127.0.0.1:5432` (Docker bind explícito)
- UFW continua bloqueando 5432 externamente (defesa em profundidade)
- Volume `./data` montado em `/var/lib/postgresql/data`
- Healthcheck: `pg_isready` a cada 30s
- Restart policy: `unless-stopped`
- Limites: `shared_buffers=128MB`, `work_mem=4MB`, `effective_cache_size=512MB`

**Database e usuário:**
- Database: `falcao_monitor`
- User app: `monitor_writer` (INSERT only nas tabelas, granted via role)
- User read: `monitor_reader` (SELECT only — usado pelo launcher)
- Senhas em `/opt/falcao-monitor/.env` (chmod 600)

### 2. Schema do Postgres

**Migration `001_init.sql`:**
```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE metrics (
  ts        TIMESTAMPTZ NOT NULL,
  host      TEXT NOT NULL,        -- 'falcao-main'
  source    TEXT NOT NULL,        -- 'vm' | 'container' | 'hetzner'
  resource  TEXT,                  -- nome do container, ou NULL pra VM
  metric    TEXT NOT NULL,         -- 'cpu_pct', 'mem_used_bytes', etc.
  value     DOUBLE PRECISION,
  labels    JSONB                  -- metadata extra opcional
);

SELECT create_hypertable('metrics', 'ts');

CREATE INDEX idx_metrics_lookup ON metrics (host, source, resource, metric, ts DESC);
```

**Migration `002_compression.sql`:**
```sql
ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'host, source, resource, metric'
);
SELECT add_compression_policy('metrics', INTERVAL '7 days');
SELECT add_retention_policy('metrics', INTERVAL '35 days');
-- 35 dias (não 30) garante margem sobre o continuous aggregate
-- mensal (start_offset='1 month'), evitando gap onde raw seria
-- apagado antes do aggregate processá-lo.
```

**Migration `003_continuous_aggregates.sql`:**
```sql
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', ts) AS bucket,
       host, source, resource, metric,
       avg(value) AS avg_value,
       max(value) AS max_value,
       min(value) AS min_value,
       count(*)   AS n
FROM metrics
GROUP BY bucket, host, source, resource, metric;

SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset => INTERVAL '1 month',
  end_offset   => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- Mesma coisa pra agregado diário
CREATE MATERIALIZED VIEW metrics_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', ts) AS bucket,
       host, source, resource, metric,
       avg(value), max(value), min(value), count(*)
FROM metrics
GROUP BY bucket, host, source, resource, metric;

SELECT add_continuous_aggregate_policy('metrics_daily',
  start_offset => INTERVAL '1 year',
  end_offset   => INTERVAL '1 day',
  schedule_interval => INTERVAL '1 day');
```

### 3. Agente coletor (Rust, systemd service)

**Crate:** `falcao-monitor-agent` — adicionado como **subcrate Rust no workspace do `falcao-launcher`** em `src-tauri/crates/monitor-agent/`. Compartilha tipos comuns (ex: `MetricRow`) com o launcher via crate compartilhada `monitor-shared`.

**Binário:** `/usr/local/bin/falcao-monitor-agent` (na VM, copiado pelo deploy)

**Build e deploy:**
- Tanto a máquina do Falcão quanto a VM são x86_64 → não precisa cross-compile
- Compilação local: `cargo build --release --bin falcao-monitor-agent`
- Deploy via `scp target/release/falcao-monitor-agent falcao@vm:/tmp/` + `sudo mv` na VM
- Versionado via tag git (ex: `monitor-agent-v0.1.0`)
- CI/CD futuro pode automatizar (Fase posterior, fora deste escopo)

**Service:** `~/.config/systemd/user/falcao-monitor-agent.service`
```ini
[Unit]
Description=Falcao VM Monitor Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/falcao-monitor-agent
Restart=always
RestartSec=5
Environment=DATABASE_URL=postgresql://monitor_writer:...@localhost:5432/falcao_monitor
Environment=POLL_INTERVAL_SECS=15

[Install]
WantedBy=default.target
```

**Loop principal (pseudo-código):**
```rust
loop {
    let timestamp = Utc::now();
    let mut batch = Vec::new();

    batch.extend(collect_vm_metrics(timestamp)?);          // /proc, /sys
    batch.extend(collect_container_metrics(timestamp)?);    // docker stats
    batch.extend(collect_hetzner_metrics(timestamp)?);      // hcloud cli

    db.insert_metrics_batch(&batch).await?;

    sleep(Duration::from_secs(15)).await;
}
```

**Coletas implementadas:**

| Source | Comando/API | Métricas |
|---|---|---|
| `vm` | `/proc/stat` | `cpu_pct` (calculado de delta) |
| `vm` | `/proc/meminfo` | `mem_total_bytes`, `mem_used_bytes`, `mem_available_bytes`, `swap_used_bytes` |
| `vm` | `df / -k` | `disk_used_bytes`, `disk_avail_bytes` |
| `vm` | `/proc/loadavg` | `load_1m`, `load_5m`, `load_15m` |
| `vm` | `/proc/net/dev` | `net_rx_bytes`, `net_tx_bytes` (cumulativos, app calcula taxa) |
| `container` | `docker stats --no-stream --format json` | `cpu_pct`, `mem_used_bytes`, `mem_limit_bytes`, `net_rx_bytes`, `net_tx_bytes`, `block_read_bytes`, `block_write_bytes` |
| `container` | `docker inspect --format '{{.State.Health.Status}}'` | `health` (1=healthy, 0=unhealthy, NULL=none) |
| `hetzner` | `hcloud server describe falcao-main -o json` | `included_traffic_bytes`, `outgoing_traffic_bytes`, `ingoing_traffic_bytes`, `status` (1=running, 0=other) |

**Resiliência:**
- Conexão DB caiu: bufferiza em memória até 1h (4 amostras × 60min × 27 métricas ≈ 6480 linhas, ~500KB)
- Buffer overflow: descarta amostras mais antigas, log em `journald`
- Crash do agente: systemd `Restart=always` + `RestartSec=5`
- Hetzner API quota (3600 req/h): coletor faz 240 req/h (15s), folgado. Se exceder, exponential backoff.
- Permissões pra `/proc`: lê como user normal (não precisa root)
- Permissões pra `docker stats`: user `falcao` é membro do grupo `docker`
- Permissões pra `hcloud`: usa `~/.config/hcloud/cli.toml` do user `falcao`

### 4. SSH tunnel + acesso DB do launcher

**Crate Rust no launcher:** `russh` (cliente SSH async puro Rust)

**Tauri commands criados (em `src-tauri/src/`):**

```rust
// monitor.rs (novo módulo)
#[tauri::command]
async fn monitor_open_tunnel() -> Result<u16, String> {
    // Abre tunnel: localhost:54322 -> falcao@162.55.217.189:5432
    // Usa ~/.ssh/id_ed25519 do user
    // Retorna porta local pra app conectar
}

#[tauri::command]
async fn monitor_close_tunnel() -> Result<(), String>;

#[tauri::command]
async fn monitor_query_metrics(
    source: String,
    resource: Option<String>,
    metrics: Vec<String>,
    since: String,    // ISO 8601
    until: Option<String>,
    bucket: Option<String>,  // '1m' | '1h' | '1d', null = raw
) -> Result<Vec<MetricPoint>, String>;

#[tauri::command]
async fn monitor_list_containers() -> Result<Vec<ContainerInfo>, String>;

#[tauri::command]
async fn monitor_fetch_logs(container: String, lines: u32) -> Result<String, String> {
    // SSH falcao@vm "docker logs <container> --tail <lines>"
}
```

**Cliente Postgres:** `tokio-postgres` + `deadpool-postgres` pra connection pool.

**Lifecycle:**
- Aba "VM" é aberta no launcher → `monitor_open_tunnel()` → app começa a fazer queries
- Aba é fechada → `monitor_close_tunnel()`
- Erros de conexão: UI mostra mensagem clara, retry button, não trava o resto do app

### 5. Frontend (aba "VM" no launcher)

**Componente novo:** `src/components/VmTab.tsx`

**Layout:**

```
┌─ Header (sempre visível) ─────────────────────────────────────┐
│ ● falcao-main · CX23 · Nuremberg · 162.55.217.189            │
│ Uptime: 3d 14h     Custo estimado: $1.24 / $5.59 (forecast)  │
└──────────────────────────────────────────────────────────────┘

┌─ Section "VM geral" ─────────────────────────────────────────┐
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌──────────┐│
│ │ CPU         │ │ RAM         │ │ Disk        │ │ Network  ││
│ │ [chart]     │ │ [chart]     │ │ [chart]     │ │ [chart]  ││
│ │ atual: 12%  │ │ atual: 45%  │ │ atual: 8%   │ │ in/out   ││
│ └─────────────┘ └─────────────┘ └─────────────┘ └──────────┘│
└──────────────────────────────────────────────────────────────┘

┌─ Section "Projetos rodando" ─────────────────────────────────┐
│ ┌─ falcao-financas ──┐  ┌─ caddy ──────────┐                │
│ │ ● healthy           │  │ ● running         │                │
│ │ CPU 1.2% RAM 18%    │  │ CPU 0.1% RAM 2%  │                │
│ │ [click pra detalhe] │  │ [click pra det.] │                │
│ └─────────────────────┘  └──────────────────┘                │
└──────────────────────────────────────────────────────────────┘
```

**Drawer "Detalhe do container"** (abre ao clicar num card):
- Gráficos do container (CPU, RAM, net I/O ao longo do tempo)
- Seletor de janela: últimos 1h / 6h / 24h / 7d / 30d
- Botão "Ver logs" → puxa via SSH on-demand (não armazenado), mostra em modal scrollable
- Status do health endpoint (ex: `https://falcao-financas.duckdns.org/api/health`)

**Charts:** Recharts (já está na stack do launcher).
- LineChart pra séries temporais
- AreaChart pra "uso atual" (cor preenchida com `var(--accent-primary)`)
- Tooltip custom mostrando timestamp + valor formatado

**Polling no frontend:**
- Header e cards: refresh a cada 15s (alinhado com agente)
- Drawer aberto: refresh a cada 5s pra sensação live
- Histórico (gráficos): query inicial + refresh a cada 30s

## Decisões e justificativas

### D1: Postgres na VM (não na máquina local)
Garante 24/7 sem depender da máquina do Falcão estar ligada. Trade-off de ~250MB RAM aceito (CX23 tem 4GB, sobra muito).

### D2: TimescaleDB sobre Postgres puro
Compressão e continuous aggregates fazem retenção de longo prazo viável (~500MB total estável depois de 1 ano). Postgres puro daria O(disk grows forever) sem trabalho manual de aggregation.

### D3: Agente em Rust (não Python)
Consistência com launcher (já é Rust+Tauri), binário único sem deps de sistema, performance excelente. Falcão aprende Rust junto.

### D4: SSH tunnel (não expor Postgres na internet)
Segurança em profundidade. Postgres nunca acessível externamente. SSH key já configurada na VM.

### D5: Schema "wide" único (não tabelas separadas por tipo)
Padrão TimescaleDB, performa muito bem, simplifica queries. Adicionar nova métrica = só inserir linha (não precisa migration de schema).

### D6: Frequência 15s default, configurável por métrica depois
Balance entre granularidade e custo. Padrão da indústria. Configuração por métrica fica pra fase futura (Fase 1 usa 15s pra tudo).

### D7: Logs via SSH on-demand (não persistidos em DB)
Logs são heavy (centenas de KB/dia/container). Persistir multiplica disco usage. Acesso on-demand via `docker logs` é suficiente pra debug. Ferramenta dedicada (Loki) pode entrar numa fase futura se sentir falta.

### D8: User separados pra writer e reader
Princípio do menor privilégio. Agente tem INSERT only. Launcher tem SELECT only. Reduz blast radius se uma chave vazar.

## Riscos e mitigações

| Risco | Severidade | Mitigação |
|---|---|---|
| Postgres consome RAM em excesso | Médio | `shared_buffers=128MB`, `work_mem=4MB`. Total ~200MB. Monitorar com próprio agente. |
| Agente trava silenciosamente | Médio | systemd `Restart=always`. Healthcheck próprio do agente: escreve heartbeat na DB a cada minuto. |
| DB cresce sem controle | Baixo | Retention + compression policies do dia 1. Alerta visual no launcher se DB > 1GB. |
| SSH tunnel falha | Baixo | Mensagem clara na UI, retry automático, não trava o resto do launcher. |
| Quota API Hetzner (3600/h) | Baixo | Coletor faz 240/h (15s × 1 chamada). Folgado. |
| Bug no schema bloqueia upgrade | Médio | Migrations versionadas (`migrations/NNN_description.sql`). Tested rollback localmente. |
| `docker stats` lento (>1s) | Baixo | Comando é rápido (<200ms tipicamente). Se demorar, log warning e segue. |
| Coletor sem permissão pra `/proc` | Baixo | Usa user `falcao` que tem leitura padrão. Validado em testes. |
| Postgres init demora muito | Médio | Container só roda migrations 1x na primeira inicialização. Healthcheck espera. |

## Acceptance criteria (Fase 1)

A Fase 1 está concluída quando:

- [ ] Postgres + TimescaleDB rodando na VM em `/opt/falcao-monitor/`
- [ ] Schema aplicado, retention/compression configurados
- [ ] Agente Rust compilado e instalado em `/usr/local/bin/`
- [ ] systemd service rodando, sobrevive a reboot da VM
- [ ] Métricas chegando no DB a cada 15s (validável via `SELECT count(*) FROM metrics`)
- [ ] Aba "VM" no launcher mostra dados em tempo real
- [ ] SSH tunnel abre e fecha sem vazar processos
- [ ] Drill-down num container mostra histórico
- [ ] Logs on-demand funcionam
- [ ] Agente sobrevive a queda do DB (re-conecta sozinho)
- [ ] Disk usage do DB documentado depois de 24h de operação
- [ ] Skill `falcao-launcher` atualizada com a feature
- [ ] CLAUDE.md do launcher atualizado
- [ ] `agent.md` em cada nova pasta criada
- [ ] PR mergeado em `main` (ou `master` conforme padrão)

## Próximas fases (contexto, não escopo)

**Fase 2 — Health checks externos:** cron rodando em GitHub Actions ou Vercel Cron pinga endpoints públicos a cada 1min, salva resultado no mesmo Postgres.

**Fase 3 — Alerting:** regras configuráveis ("CPU > 80% por 5min"), Telegram bot envia push pro celular.

**Fase 4 — Anomaly detection:** estatística simples (média móvel ± 3σ) sobre métricas histórias.

**Fase 5 — Integração Claude:** botão "Investigar" em cada card/alerta spawna agent com contexto pré-populado (métricas + logs + git status do projeto).

## Referências

- Skill `falcao-launcher` (especialmente Sub-projeto E)
- Skill `falcao-hetzner` (infra da VM, hcloud CLI)
- Skill `falcao-default` (workflow Git, agent.md)
- Spec anterior `2026-05-05-claude-awareness-design.md` (mesma pasta) — contexto sobre awareness do Claude no launcher
- TimescaleDB docs: https://docs.timescale.com/
- Hetzner Cloud API: https://docs.hetzner.cloud/
