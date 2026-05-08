# Sprint B3 — Monitor de custos multi-serviço

**Data:** 2026-05-08
**Autor:** Falcão (supervisão) + Claude (escrita)
**Status:** rascunho — aguardando aprovação

---

## Contexto

A Sprint 1 entregou tracking de custo Hetzner (`cost_accumulated_usd` + forecast mensal no header da aba VM). Tudo bem enquanto a única fonte de custo era a VM. Mas hoje o launcher orquestra três fontes externas com risco real de estourar free tier:

- **Vercel Hobby** — 100 GB/mês bandwidth + 6000 min/mês build (conta-wide). O `monitor-agent` já tem coletor de deploys (Sprint 2), mas não lê usage.
- **GitHub Actions** — 2000 min/mês free. Sprint B1 adicionou cron diário (scan-dependabot) que consome ~2 min/dia. Sprint 2 adicionou health checks externos cron 5min, ~24 min/dia. Soma já passa de 10% do free tier mensal sem ninguém olhar.
- **Hetzner CX23** — ~$5,59/mês, sempre-ligado, já trackeado.

Free tier não estourado é dinheiro economizado, mas estourar sem perceber vira fatura inesperada. B3 entrega visibilidade unificada: **um lugar pra ver onde a conta tá indo, em tempo de detectar antes de virar bill**.

## Objetivos

1. Coletar uso de Vercel + GH Actions automaticamente, todo hora, sem intervenção manual.
2. Persistir histórico de uso por 90 dias (igual demais hypertables).
3. Apresentar consumo agregado de cada serviço numa aba dedicada "Custos", lado a lado com Hetzner.
4. Sinalizar visualmente quando algum serviço passa 70% (amber) e 90% (vermelho) do free tier.
5. Permitir investigar tendência via chart histórico (idem padrão dos charts da aba VM).

## Não-objetivos (Sprint B3)

- **Supabase.** Hoje só `falcao-tcc` usa, e tá parado. Adicionar depois é trivial (mesmo padrão de coletor + nova linha em `service`).
- **Push notifications / Telegram bot.** Depende de bot futuro.
- **Predição "vai estourar em X dias".** Estatística, fora do escopo.
- **Multi-team Vercel ou multi-org GitHub.** Single user, single team `noreason`.
- **Breakdown de bandwidth por projeto Vercel.** API Hobby não expõe — só agregado da conta.
- **Alertas inline nos `ProjectCards`.** Custos são conta-wide, não per-project — a UI mora exclusivamente na aba "Custos" + chip na topbar.
- **Reset day awareness.** Free tiers resetam em datas diferentes (Vercel: dia 1, GH Actions: dia da assinatura). Sprint mostra `period_start` na linha mas não calcula "dias até reset".

## Decisões de design

### D1 — Tabela única `external_metrics` heterogênea

```sql
CREATE TABLE external_metrics (
  ts            TIMESTAMPTZ NOT NULL,
  service       TEXT        NOT NULL,    -- 'vercel' | 'gh_actions' | 'hetzner'
  metric        TEXT        NOT NULL,    -- ver tabela abaixo
  value         DOUBLE PRECISION NOT NULL,
  quota         DOUBLE PRECISION,        -- free tier limit (NULL se não aplicável)
  unit          TEXT        NOT NULL,    -- 'bytes' | 'minutes' | 'count' | 'usd'
  period_start  TIMESTAMPTZ,             -- início do mês de billing
  PRIMARY KEY (ts, service, metric)
);
SELECT create_hypertable('external_metrics', 'ts');
ALTER TABLE external_metrics SET (timescaledb.compress, timescaledb.compress_segmentby='service,metric');
SELECT add_compression_policy('external_metrics', INTERVAL '7 days');
SELECT add_retention_policy('external_metrics', INTERVAL '90 days');
GRANT SELECT ON external_metrics TO monitor_reader;
GRANT INSERT ON external_metrics TO monitor_writer;
```

**Métricas previstas:**

| service     | metric                  | unit    | quota (free) |
|-------------|-------------------------|---------|--------------|
| vercel      | bandwidth_bytes         | bytes   | 107374182400 (100 GB) |
| vercel      | build_minutes           | minutes | 6000         |
| vercel      | image_optimization_count| count   | 5000         |
| vercel      | function_invocations    | count   | 1000000 (1M) |
| gh_actions  | minutes_used            | minutes | 2000         |
| hetzner     | cost_accumulated_usd    | usd     | NULL (sem free tier) |

**Por que tabela única e não `vercel_usage`/`gh_actions_usage`:** todas têm shape idêntico (timestamp + número + quota). Tabelas separadas multiplicariam migrations, grants, retention policies sem ganho. A `metrics` interna (de host/container) já fica separada porque tem volume completamente diferente (15 segundos vs 1 hora) e ciclo de vida diferente (15s polling vs daily-ish).

**Por que `quota` na linha e não em config:** Vercel já mudou limites de free tier no passado. Persistir junto com a amostra deixa histórico fiel ("naquele dia o quota era 100 GB").

**Por que Hetzner também aparece nesta tabela** (mesmo já tendo dado em `metrics`): a aba Custos lê só `external_metrics`. Coletor `hetzner` ganha um espelhamento opcional pra manter padrão único. Ver D5.

### D2 — Coletores Rust no `monitor-agent` (não GH Actions cron)

Novos arquivos:
- `crates/monitor-agent/src/collectors/vercel_usage.rs` — chama `GET https://api.vercel.com/v1/usage` (Bearer `VERCEL_TOKEN` já existente desde Sprint 2). Endpoint retorna usage do mês corrente: `bandwidth`, `buildMinutes`, `imageOptimizations`, `serverlessFunctionExecution`. Retorna 4 `ExternalMetric` por tick.
- `crates/monitor-agent/src/collectors/gh_actions.rs` — chama `GET https://api.github.com/users/Falkzera/settings/billing/actions` com `Authorization: Bearer $GH_PAT_SECURITY` + `Accept: application/vnd.github+json`. Retorna `{total_minutes_used, total_paid_minutes_used, included_minutes}`. Emite 1 `ExternalMetric` por tick (`minutes_used`).
- `crates/monitor-shared/src/lib.rs` — adicionar struct `ExternalMetric { ts, service, metric, value, quota, unit, period_start }` com derive `Serialize`.

**Por que não GH Actions cron pro `gh_actions` collector:** já temos `reqwest::Client` no agente, mesmo lugar do Vercel collector. SSH push complicaria sem ganho. O agente fica self-contained.

**Por que tick de 1h:** free tier reseta mensal, mas runaway de build minutes (loop infinito num CI mal escrito) precisa ser detectado em horas, não dias. Rate limit folgado: 24 req/dia/serviço numa cota de 100/h (Vercel) ou 5000/h (GitHub).

**Endpoint Vercel `/v1/usage`:** schema verificado público em https://api.vercel.com/v1/usage (Bearer auth). Spec assume disponibilidade no plano Hobby — verificar em runtime na implementação. Se algum subset for paid-only, registramos como `value=NULL` e UI esconde a métrica especificamente (não derruba o coletor).

### D3 — Pipeline de INSERT

Reusa o pipeline atual do agente: cada coletor emite `Vec<ExternalMetric>` no canal de envio, o `inserter.rs` faz INSERT batch. Adicionar nova função `insert_external_metrics(rows)` ao lado do `insert_metric_rows` existente.

`ON CONFLICT (ts, service, metric) DO UPDATE SET value=EXCLUDED.value, quota=EXCLUDED.quota` — se o tick rodar 2x no mesmo segundo (improvável, mas possível em retry), atualiza em vez de duplicar.

### D4 — Backend Tauri (queries + commands)

Novo módulo `src-tauri/src/monitor/costs.rs`:

```rust
pub struct CostUsage {
    pub service: String,
    pub metric: String,
    pub value: f64,
    pub quota: Option<f64>,
    pub unit: String,
    pub pct: Option<f64>,         // value/quota * 100, NULL se quota é NULL
    pub period_start: Option<DateTime<Utc>>,
    pub ts: DateTime<Utc>,
}

pub async fn cost_summary(client) -> Result<Vec<CostUsage>>;       // última amostra por (service, metric)
pub async fn cost_history(client, service, metric, since, until) -> Result<Vec<MetricPoint>>;
```

Query `cost_summary` usa `DISTINCT ON (service, metric) ... ORDER BY service, metric, ts DESC` (mesmo padrão de `stacks.rs`).

Dois commands Tauri novos em `src-tauri/src/monitor/commands.rs`: `monitor_cost_summary`, `monitor_cost_history`. Validações de input: `service` whitelist, `metric` whitelist, range time-bound (max 90d).

### D5 — Espelhamento Hetzner em `external_metrics`

Coletor `hetzner.rs` (existente) ganha emissão paralela: além de inserir `cost_accumulated_usd` em `metrics` (mantém compat com `VmHeader` existente), espelha em `external_metrics` com `service='hetzner'`. Single source na aba Custos.

Quota = NULL pra Hetzner (sem free tier). UI mostra forecast mensal (já calculado em `lib/cost.ts`) na barra em vez de pct.

### D6 — UI: Aba "Custos" no topbar

Topbar passa a ter: **Projetos · Skills · Segurança · Custos · VM**.

Novos componentes:
- `src/components/CostTab.tsx` — orquestrador. `useTunnel()` + `usePolling(monitorApi.costSummary, 60_000)`.
- `src/components/CostServiceCard.tsx` — card por serviço (3 cards: Vercel / GH Actions / Hetzner). Mostra título, ícone do serviço, todas as métricas do serviço como linhas internas com barra de progresso colorida.
- `src/components/CostUsageBar.tsx` — barra horizontal de progresso (`value/quota`) com gradiente de cor:
  - `< 70%` → verde (`--color-success`)
  - `70-89%` → amber (`--color-accent-primary`)
  - `≥ 90%` → vermelho (`--color-danger`)
  - quota NULL → barra cinza com label "sem free tier"
- `src/components/CostHistoryChart.tsx` — Recharts `<LineChart>` reutilizando padrão de `VmMetricChart`. Selectbox pra `(service, metric)`. Default = primeira métrica em alerta, ou bandwidth Vercel se nenhuma.
- `src/components/CostChip.tsx` — chip pequeno na topbar, ao lado do label "Custos", visível só quando algum serviço passa 90%. Mostra count de métricas em alerta. Clicar leva à aba Custos. Pattern espelha `SecurityChip` da B1.

### D7 — Tipos compartilhados (frontend)

`src/types/costs.ts` novo:
```ts
export type CostService = "vercel" | "gh_actions" | "hetzner";
export type CostUnit = "bytes" | "minutes" | "count" | "usd";
export interface CostUsage { service, metric, value, quota, unit, pct, period_start, ts }
export interface CostHistoryPoint { ts, value }
export const COST_THRESHOLDS = { warning: 70, danger: 90 };
export function pctColor(pct: number | null): "success" | "warning" | "danger" | "muted";
```

`src/lib/monitor.ts` ganha 2 wrappers: `costSummary()`, `costHistory(service, metric, sinceIso, untilIso)`.

### D8 — Configuração de secrets

Nada novo. Reusa:
- `VERCEL_TOKEN` em `/home/falcao/.config/falcao-monitor/.env` (Sprint 2). Verificar scope: o token atual é "full account read-only" — `/v1/usage` exige scopes que esse token já tem.
- `GH_PAT_SECURITY` no mesmo arquivo (Sprint B1). Scope `read:user` cobre billing endpoint.

Em ambos os casos: se o coletor receber 401/403, loga e segue (não derruba agente).

## Arquitetura

```
┌──────────────────────────── VM Hetzner ────────────────────────────┐
│                                                                    │
│  monitor-agent (systemd user service, v0.3.0)                      │
│  ├─ collectors/vm.rs           (existente, 15s)                    │
│  ├─ collectors/container.rs    (existente, 15s)                    │
│  ├─ collectors/hetzner.rs      (existente, 60s) ─── espelha p/     │
│  ├─ collectors/vercel.rs       (existente, 5min, deploys)   external│
│  ├─ collectors/vercel_usage.rs (NOVO, 1h)        ────────► metrics │
│  └─ collectors/gh_actions.rs   (NOVO, 1h)        ─────────►  table │
│                                                                    │
│  Postgres + TimescaleDB (5432, local-only)                         │
│  └─ external_metrics (NOVA hypertable)                             │
└────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │ ssh -L 54322:localhost:5432
                                    │
┌──────────────────── falcao-launcher (Tauri 2) ──────────────────────┐
│  src-tauri/src/monitor/costs.rs  (queries + 2 commands Tauri)      │
│  src/components/CostTab.tsx + CostServiceCard + CostHistoryChart   │
│  src/components/CostChip (topbar)                                   │
└────────────────────────────────────────────────────────────────────┘
```

## Fluxo de dados

1. Agente Rust desperta a cada 1h (task paralela ao loop principal de 15s).
2. Cada um dos coletores novos faz HTTP GET na API do serviço.
3. Resposta parseada → `Vec<ExternalMetric>` → canal mpsc → `inserter` → INSERT batch.
4. Launcher abre tunnel SSH (já existe), chama `monitor_cost_summary` → query DISTINCT ON → retorna `Vec<CostUsage>`.
5. `CostTab` renderiza 3 cards (Vercel/GH/Hetzner) com barras coloridas. Polling 60s mantém atualizado.
6. `CostHistoryChart` busca série histórica sob demanda quando user troca o select.
7. `CostChip` na topbar consome o mesmo `costSummary` (cacheado em escopo de App).

## Tratamento de erros

| Falha                          | Comportamento                                       |
|--------------------------------|-----------------------------------------------------|
| Vercel API 401/429             | Log warn, skip tick, próximo retry em 1h            |
| GH API 401/403                 | Log warn, skip tick                                 |
| Endpoint paid-only             | Não derruba: emite linha com `value` ausente; UI esconde a métrica específica |
| Postgres INSERT falha          | Log warn (já existe); next tick reescreve via UPSERT |
| Tunnel SSH morre               | UI mostra estado "carregando" até reabrir          |
| Aba Custos sem dados ainda     | Skeleton loading + mensagem "aguardando primeira coleta (até 1h)" |

## Testes

- **Rust unitário** (`monitor-agent`): parsing de resposta Vercel + GitHub mockada (fixtures JSON em `crates/monitor-agent/tests/fixtures/`). Cobertura: campos faltando, valores zero, quota NULL.
- **Rust unitário** (`monitor/costs.rs`): query helpers (validação de service whitelist, range max 90d) — espelha pattern de B1.
- **Frontend**: `pctColor()` em `types/costs.ts` (puro, fácil cobrir).
- **Manual end-to-end**: rodar agente local com tokens válidos, esperar 1h ou disparar manualmente (`SIGUSR1` futuro? por enquanto: redeploy = primeiro tick imediato).

## Validação pós-deploy (VALIDATION.md ganha seção)

1. Migration `009_external_metrics.sql` aplicada na VM.
2. Agente v0.3.0 rebuild + deploy via `scripts/deploy-monitor-agent.sh`.
3. Esperar 1h. Conferir `psql -c "SELECT * FROM external_metrics ORDER BY ts DESC LIMIT 20"`.
4. Abrir launcher, conferir aba Custos: 3 cards renderizam com valores não-zero.
5. Forçar pct alto (mock no DB: UPDATE quota pra valor menor) → conferir cor amber/vermelho + chip topbar.

## Roadmap pós-B3

- Supabase quando algum projeto entrar em produção (mesmo pattern: coletor novo, linha nova em `service`).
- Predição "estouro em X dias" via regressão linear simples sobre últimos 7 dias.
- Telegram bot pra alertas push (depende de Sprint Telegram futura).
- Daily digest no Claude Code via Sprint 4 pattern (`spawn_claude_investigation` com prompt de custos).
