# Sprint 2 — Vercel stacks (frontend + backend agrupados)

**Data:** 2026-05-07
**Autor:** Falcão (supervisão) + Claude (escrita)
**Status:** rascunho — aguardando aprovação

---

## Contexto

Phase 1 do VM Monitor entregou observabilidade da VM Hetzner: containers, métricas de host, health checks externos. Hoje, no entanto, o frontend dos projetos não aparece em lugar nenhum: ele vive na Vercel e só é monitorado indiretamente via probe HTTP externo (status 200/erro). Falta a dimensão "este deploy quebrou na build", "o último deploy foi há 4h", "o front em produção é desta branch".

Hoje a única stack em produção é o **falcao-financas**:
- Backend: container Docker `falcao-financas` na VM (`/opt/apps/falcao-financas/`)
- Frontend: projeto Vercel `falcao-financas` na conta pessoal (team `noreason`, plano Hobby)

Já que projetos novos virão (`Sonar`, `SIGOF`, etc.), a sprint precisa entregar uma **abstração** que escala automaticamente quando o segundo projeto chegar — sem editar config no launcher cada vez.

## Objetivos

1. Coletar status do último deploy de **todos** os projetos Vercel da conta automaticamente (sem allowlist no launcher).
2. Agrupar **frontend Vercel + backend container** numa visão única "stack em produção".
3. Permitir que stacks novas surjam sem mudança no launcher: convenção declarativa via Docker label `monitor.stack=<nome>`.
4. Mostrar status agregado (deploy state + métricas backend + health do endpoint público) por stack na aba VM.
5. Persistir histórico de deploys pra debug futuro de regressões.

## Não-objetivos (Sprint 2)

- Alertas/Telegram bot (sprint futura).
- Web App PWA / Web Push (sprint futura, separada).
- Bandwidth/build minutes Vercel (depende de endpoints gated em paid — investigar separadamente).
- Métricas de runtime do front (Web Vitals, etc.) — escopo Vercel Analytics, não API básica.
- Detecção automática de stacks por heurística de nome (descartado em favor de label declarativa — ver decisão D1).
- Multi-team Vercel (single user, single team `noreason`).

## Decisões de design

### D1 — Agrupamento via Docker label `monitor.stack`

**Decisão:** cada container que faz parte de uma stack em produção declara em label Docker:
```yaml
labels:
  - monitor.stack=falcao-financas
```

Coletor `container.rs` lê labels via `docker inspect` e propaga o valor pra coluna `stack` do `MetricRow`. Coletor Vercel separadamente lista todos os projetos da conta e grava por `project_name`. Frontend faz a junção: `stack_name == vercel_project_name` ⇒ é a mesma stack.

**Por que não JSON manual no launcher** — testado em rascunho de proposta anterior (8 mensagens atrás). Falcão rejeitou: "quero automático". Manter JSON manual sincronizado entre projetos é trabalho recorrente toda vez que renomear container.

**Por que não heurística de nome (auto-match)** — frágil quando container chamar simplesmente `api` ou quando renomear projeto Vercel sem renomear container. Surpresa silenciosa.

**Convenção de override** (caso nome do projeto Vercel ≠ valor da label): segunda label opcional `monitor.vercel_project=<slug-vercel>` força matching. Sprint 2 não precisa (falcao-financas casa nos dois lados), mas spec já reserva o caminho.

### D2 — Coletor Vercel via REST API direta (não Vercel CLI)

**Decisão:** novo coletor `crates/monitor-agent/src/collectors/vercel.rs` usa `reqwest` pra chamar `https://api.vercel.com/v9/projects` e `https://api.vercel.com/v6/deployments`. Não depende do binário `vercel` na VM.

**Por que não CLI** — CLI requer `vercel login` interativo, guarda token em `~/.vercel/auth.json`, e expõe comandos limitados (não tem `vercel projects ls --json --include-deployments`). REST API é direta, paginada, documentada, e permite usar token pessoal sem login interativo.

**Por que `reqwest`** — já é o crate HTTP padrão do ecossistema Rust async, pequeno (~3MB build extra), suporta JSON nativo via feature `json`, TLS via `rustls`. Já é deps transitiva do `tokio-postgres`.

### D3 — Schema da tabela `vercel_deployments`

**Decisão:** tabela dedicada (não usa a `metrics` genérica), porque o shape é heterogêneo (texto + timestamps + status enum) e não cabe num `value: f64`.

```sql
CREATE TABLE vercel_deployments (
  ts            TIMESTAMPTZ NOT NULL,        -- momento da observação (poll)
  project_id    TEXT        NOT NULL,        -- prj_xxxxx
  project_name  TEXT        NOT NULL,        -- "falcao-financas"
  deployment_id TEXT        NOT NULL,        -- dpl_xxxxx
  state         TEXT        NOT NULL,        -- READY|ERROR|BUILDING|QUEUED|CANCELED
  url           TEXT,                        -- https://falcao-financas-abc123.vercel.app
  prod_url      TEXT,                        -- https://falcao-financas.vercel.app
  branch        TEXT,
  commit_sha    TEXT,
  commit_msg    TEXT,
  author        TEXT,                        -- username vercel
  created_at    TIMESTAMPTZ,                 -- quando deploy começou
  ready_at      TIMESTAMPTZ,                 -- quando virou READY (NULL se ainda não)
  build_ms      INT                          -- duração build (ready_at - created_at)
);

SELECT create_hypertable('vercel_deployments', 'ts', if_not_exists => TRUE);
```

**Hypertable mesmo sendo dado lento?** Sim — TimescaleDB cobra zero overhead. Permite retention/compression policy uniformes com o resto. Volume estimado: ~3-10 deploys/dia × 1 row por deploy × 90 dias = ~900 rows. Trivial.

**Retention 90d, compression 7d** — alinhado com `health_checks`.

**Index** — `(project_name, ts DESC)` pra query "último deploy do projeto X" ser O(1).

**Continuous aggregate** — não precisa nessa sprint; volume é baixo. Adiciona depois se virar gargalo.

**Coluna `stack` na tabela?** — não. Stack name é inferido em query-time (`project_name == stack` ou via `monitor.vercel_project` override). Mantém tabela "fonte da verdade Vercel" desacoplada da convenção de mapeamento.

### D4 — Frequência de poll: 5 minutos

**Decisão:** coletor Vercel roda a cada **300s** (5 min). Não os 15s do agente principal.

**Por que** — deploys não acontecem com frequência > 1/hora em projeto pessoal. Polling agressivo desperdiça rate limit (Vercel API grátis tem ~100 req/h por token). 5 min mantém UX "praticamente real-time" pra dev pessoal e custa 12 req/h × N projetos.

**Implementação** — `tokio::time::interval(Duration::from_secs(300))` em task separada do loop principal de 15s. Não acopla com poll de métricas.

### D5 — Auth: token via `EnvironmentFile` no systemd

**Decisão:** token Vercel mora em `/home/falcao/.config/falcao-monitor/.env` na VM (`chmod 600`, owner `falcao:falcao`). Systemd unit `~/.config/systemd/user/falcao-monitor-agent.service` ganha:

```ini
[Service]
EnvironmentFile=-/home/falcao/.config/falcao-monitor/.env
```

Hífen prefixado: missing file não falha o service (graceful: coletor Vercel pula se `VERCEL_TOKEN` ausente). Coletor lê via `std::env::var("VERCEL_TOKEN")`.

**Por que não `MONITOR_READER_PASSWORD`-style fallback do `.env` de `falcao-launcher`** — esse `.env` mora na máquina **local** do Falcão. Agente roda na VM. Domínios diferentes.

**Permissões** — `chmod 600` impede outros users da VM lerem. Token tem scope read-only Full Account na Vercel — mesmo vazado, só permite leitura (não deploys, não env vars, não destruição). Defesa em profundidade aceita.

### D6 — UI: section "Stacks em produção" dentro da aba VM

**Decisão:** section nova entre `VmHeader` e `VmContainerGrid` na aba VM. Layout:

```
[VmHeader: status agente + load + RAM% + custo + bars]
[Health Checks section]                         ← já existe (Sprint 2 anterior)
[Stacks em produção]                            ← NEW
  └─ StackCard "falcao-financas"
       ├─ Header: nome + bolinha agregada (verde se tudo healthy)
       ├─ Frontend Vercel: badge state + "deploy 4h atrás · 1.2s build" + link
       ├─ Backend container: CPU% + RAM% + uptime
       └─ Endpoint público: 200 · 142ms · 99.94% / 30d (vem de health_checks)
[Time-window selector]                          ← já existe
[Charts VM (Load, RAM, CPU, Disk, Network)]    ← já existe
[Containers]                                    ← já existe (mostra crus os SEM stack)
```

**Containers já agrupados em stack desaparecem da grid de containers crua** — caso contrário o backend `falcao-financas` apareceria duas vezes (uma no card de stack, outra na grid). Critério: container com label `monitor.stack=X` é "absorvido" pelo StackCard correspondente.

**Containers sem label** — continuam aparecendo crus na grid existente. Caso típico: `caddy`, `falcao-monitor-db`. Nada quebra do que já existe.

**Por que não aba nova "Produção"** — só temos 1 stack hoje. Aba dedicada vazia é UX pior que section dentro de aba existente. Quando tiver 5+ stacks, daí promove pra aba.

### D7 — Versão do agente: bump pra v0.2.0

**Decisão:** `monitor-agent` sai de v0.1.1 → v0.2.0. Minor version porque adiciona métricas novas (não breaking; schema do `metrics` ganha campo opcional `stack` em `labels` JSONB, não muda tipo). Tabela `vercel_deployments` é totalmente nova (zero impacto em consumers existentes).

## Arquitetura

```
┌──────────────────────────────────────────────────────────────────────┐
│  Vercel API (api.vercel.com)                                         │
│                                                                      │
│  GET /v9/projects               → lista todos projetos do team       │
│  GET /v6/deployments?projectId  → último deploy de cada              │
└──────────────────────┬───────────────────────────────────────────────┘
                       │ HTTPS Bearer token
                       │ poll 5min
                       ▼
┌──────────────────────────────────────────────────────────────────────┐
│  VM Hetzner                                                          │
│                                                                      │
│  monitor-agent v0.2.0 (systemd user service)                         │
│   ├─ task A (15s): vm.rs + container.rs + hetzner.rs (já existe)     │
│   │   └─ container.rs MODIFICADO: lê labels, propaga `stack`         │
│   └─ task B (5min): vercel.rs (NEW)                                  │
│       └─ INSERT em vercel_deployments                                │
│                                                                      │
│  /home/falcao/.config/falcao-monitor/.env                           │
│   └─ VERCEL_TOKEN=vcp_xxxxx (chmod 600)                              │
│                                                                      │
│  /opt/apps/falcao-financas/docker-compose.yml                        │
│   └─ labels: monitor.stack=falcao-financas (NEW)                     │
│                                                                      │
│  Postgres (timescale) — falcao-monitor-db                            │
│   └─ tabela nova vercel_deployments (hypertable, retention 90d)      │
└──────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │ SSH tunnel já existente (54322)
                                  │
┌──────────────────────────────────────────────────────────────────────┐
│  Launcher (Tauri) — máquina local do Falcão                         │
│                                                                      │
│  src-tauri/src/monitor/queries.rs (NEW queries):                    │
│   ├─ list_stacks() → lista stacks distintas (do labels)             │
│   ├─ stack_summary(name) → backend metrics + endpoint health         │
│   └─ stack_vercel_status(project_name) → último deploy               │
│                                                                      │
│  src/components/StackGrid.tsx + StackCard.tsx (NEW)                  │
│   └─ section "Stacks em produção" na aba VM                          │
└──────────────────────────────────────────────────────────────────────┘
```

## Componentes (detalhe técnico)

### 1. Migration `007_vercel_deployments.sql`

Conteúdo igual ao schema na seção D3. Aplicada via `./scripts/apply-vm-migrations.sh` (já existe). Grants: `monitor_writer` INSERT, `monitor_reader` SELECT.

### 2. Coletor `crates/monitor-agent/src/collectors/vercel.rs` (NEW)

**Estrutura** segue padrão de `hetzner.rs`:
- Função pública `pub async fn collect(ts, client) -> Result<Vec<VercelDeployment>>`
- Função privada `fn parse_projects_response(json) -> Vec<...>` testável sem rede
- Função privada `fn parse_deployments_response(json) -> Vec<...>` testável sem rede

**Fluxo:**
1. `GET /v9/projects?teamId=<auto>` → lista de project IDs e nomes
2. Pra cada projeto: `GET /v6/deployments?projectId=X&limit=1&teamId=<auto>` → último deploy
3. Map cada deploy → `VercelDeployment` row
4. Retorna `Vec<VercelDeployment>` pro main loop persistir

**Tipos novos em `monitor-shared`:**
```rust
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

**Defensive parsing:** missing fields → `None` (vão pra coluna NULL). Estado inválido (não-enum) → loga warn e ignora row específica, segue.

**Rate limit handling:** Vercel responde com `X-RateLimit-Remaining`. Se < 5, log warn e pula esse poll. (Sprint 2: log apenas, sem retry exponencial — reavaliar se virar problema.)

**Auth token ausente:** `std::env::var("VERCEL_TOKEN")` falha → `collect()` retorna `Ok(vec![])` com warn log. Não quebra o agente. Comportamento útil pra rodar agente em dev sem token.

**Testes (sem rede):**
- `parses_project_list_with_2_projects`
- `parses_deployment_with_all_fields`
- `parses_deployment_with_missing_optional_fields`
- `parses_deployment_in_building_state`
- `unknown_state_logged_and_skipped` (ou keeps as-is — decidir na implementação)

### 3. Modificação `container.rs`

**Mudança:** ao chamar `docker stats`, também chamar `docker inspect <name> --format '{{json .Config.Labels}}'` (ou usar `docker stats` com JSON e correlacionar). Extrair `monitor.stack` se presente, propagar pra `MetricRow.labels` (campo já é `Option<JsonValue>`).

**Alternativa mais eficiente:** usar Docker Engine API (`/var/run/docker.sock`) via crate `bollard` em vez de spawn `docker` repetido. Sprint 2: manter Command-based (mais simples, alinhado com padrão atual). Bollard fica pra refatoração futura se virar gargalo.

**Edge case:** container sem label `monitor.stack` → `labels` field continua `None` (comportamento atual). Sem regressão.

### 4. Loop principal do agente (`main.rs`)

Pseudo-código da mudança:

```rust
let interval_15s = tokio::time::interval(Duration::from_secs(15));
let interval_5min = tokio::time::interval(Duration::from_secs(300));

let vercel_token = std::env::var("VERCEL_TOKEN").ok();
let http_client = reqwest::Client::builder().timeout(...).build()?;

tokio::spawn(async move {  // task B
    loop {
        interval_5min.tick().await;
        if let Some(token) = &vercel_token {
            match vercel::collect(Utc::now(), &http_client, token).await {
                Ok(rows) => persist_vercel(&pool, rows).await,
                Err(e) => warn!("vercel collect failed: {e}"),
            }
        }
    }
});

loop {  // task A (já existe)
    interval_15s.tick().await;
    // vm + container + hetzner em paralelo (já existe)
}
```

### 5. Setup VM

**Arquivos novos:**
- `/home/falcao/.config/falcao-monitor/.env` (chmod 600)
- (opcional) `/home/falcao/.config/falcao-monitor/` dir (mkdir)

**Arquivos editados:**
- `~/.config/systemd/user/falcao-monitor-agent.service` → adicionar `EnvironmentFile=`
- `/opt/apps/falcao-financas/docker-compose.yml` → adicionar label no service

### 6. Frontend launcher

**Queries Rust novas em `src-tauri/src/monitor/queries.rs`:**

```rust
pub async fn list_stacks(pool: &Pool) -> Result<Vec<StackSummary>> {
    // SELECT DISTINCT labels->>'stack' FROM metrics WHERE labels ? 'stack'
    //   AND ts > now() - interval '5 min'
    // UNION
    // SELECT DISTINCT project_name FROM vercel_deployments WHERE ts > now() - interval '1 hour'
}

pub async fn stack_detail(pool: &Pool, stack: &str) -> Result<StackDetail> {
    // - container metrics where labels->>'stack' = $1, last 5min avg
    // - latest vercel_deployments where project_name = $1
    // - health_checks for endpoint matching pattern (best-effort)
}
```

**Componentes React novos** em `src/components/`:
- `StackGrid.tsx` — grid de StackCards
- `StackCard.tsx` — card único agregando 3 sub-blocos (Vercel, container, endpoint)
- `VercelStatusBadge.tsx` — bolinha colorida + label de state

**Tipos TS** em `src/types/monitor.ts` (espelham serde Rust):
```ts
type StackSummary = { name: string; vercel_state?: VercelState; backend_healthy?: boolean }
type VercelState = 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED'
type StackDetail = {
  name: string
  vercel?: VercelDeployment
  containers: ContainerSnapshot[]
  endpoint?: HealthSummary
}
```

**Cores Vercel state:**
- `READY` → verde (var --color-success)
- `ERROR` → vermelho (var --color-danger)
- `BUILDING` / `QUEUED` → amber (var --color-accent-primary)
- `CANCELED` → cinza (var --color-text-secondary)

## Edge cases e defensividade

| Edge | Comportamento |
|---|---|
| Token Vercel ausente | Coletor pula com warn; UI mostra StackCard sem bloco Vercel |
| Token inválido / 401 | Coletor loga error, retry no próximo tick (5 min), UI fica com último deploy conhecido |
| Vercel project sem deploys ainda | `deployments` vem `[]`; UI: "sem deploys ainda" |
| Container ganha label nova depois de já estar rodando | Próximo tick (15s) já reflete (não precisa restart) |
| Container removido/parado | UI: card desaparece; histórico fica em DB |
| Stack sem container ativo (ex: app pausado) | UI: card mostra só Vercel + endpoint, backend "offline" |
| Stack sem Vercel (só backend) | UI: card mostra só backend; sub-bloco Vercel oculto |
| Múltiplos containers com mesma label | UI: card mostra todos os containers como sub-itens |
| Deploy em BUILDING há > 1h | UI: badge amber + warning "build longo" (heurística) |
| Rate limit Vercel (X-RateLimit-Remaining < 5) | Pula esse poll, log warn |

## Não escopados (explícito)

- Webhook Vercel pra evento "deploy concluído" instantâneo (em vez de poll). Sprint futura — exige Caddy route + endpoint público autenticado.
- Bandwidth/build minutes. Endpoint `/v1/web/insights` é gated em paid plans em parte. Investigar separadamente.
- Domain status (cert SSL, DNS). Nice-to-have, fica pra próxima.
- Histórico de deploys no drawer (só mostra último). Drawer de stack pode vir em sprint subsequente.
- Comparação de métricas pré/pós-deploy. ML-like, fica pra Phase 3.

## Riscos

1. **Vercel API mudou shape do JSON** — defesa: parser tolerante a missing fields. Tests cobrem casos comuns.
2. **Token expirar silenciosamente** — agente loga 401, mas Falcão pode não ver. Mitigação: UI mostrar "última coleta Vercel há X horas" se > 30 min.
3. **`docker inspect` muda comportamento** — improvável; API estável há anos.
4. **Conflito com `EnvironmentFile` se sintaxe quebrar** — testar localmente o `.env` antes de subir.
5. **Falcão criar projeto Vercel novo e esquecer de adicionar label no compose** — UI mostra Vercel project sem container associado em "stacks órfãs" (pode ficar como melhoria de DX futura).

## Critérios de aceite

A sprint só fecha se:

1. ✅ Migration `007_vercel_deployments.sql` aplicada na VM, tabela existe
2. ✅ Agente v0.2.0 deployado, `systemctl --user status` healthy, logs sem erros
3. ✅ Após 5 min: `SELECT count(*) FROM vercel_deployments` ≥ 1 (pelo menos `falcao-financas`)
4. ✅ `docker inspect falcao-financas` mostra label `monitor.stack=falcao-financas`
5. ✅ `SELECT labels FROM metrics WHERE source='container' AND ts > now() - interval '1 min'` retorna `{"stack": "falcao-financas"}` em pelo menos uma row
6. ✅ Aba VM no launcher mostra section "Stacks em produção" com card `falcao-financas`
7. ✅ Card mostra: Vercel state + last deploy + backend metrics + endpoint health
8. ✅ Container `caddy` e `falcao-monitor-db` continuam aparecendo na grid de containers crua (não absorvidos)
9. ✅ Build release do launcher passa sem warnings novos
10. ✅ Testes Rust passando (incluindo novos do `vercel.rs`)
11. ✅ Documentação atualizada: agent.md das pastas tocadas + CLAUDE.md + skill `falcao-launcher`
12. ✅ PR aberto pra `main`

## Próximos passos pós-aprovação

→ Plan TDD em `docs/superpowers/plans/2026-05-07-vercel-stacks.md` quebrando essas decisões em fases A→E com tasks bite-sized e ordem de execução.
