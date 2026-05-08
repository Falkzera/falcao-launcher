# Sprint B1 — Snyk-like (vulnerabilidades cross-repo + imagens Docker)

**Data:** 2026-05-08
**Autor:** Falcão (supervisão) + Claude (escrita)
**Status:** rascunho — aguardando aprovação do Falcão

---

## Contexto

Launcher é observability hub: VM monitor + Vercel stacks + análise temporal + integração Claude (5 PRs em main). Falta a terceira pata do trio que Falcão sinalizou desde o início:

| Dimensão | Equivalente comercial | Estado |
|---|---|---|
| Métricas VM/containers | Netdata | ✅ entregue (Sprint 1+) |
| Health checks externos | UptimeRobot | ✅ entregue (Sprint 2 health) |
| **Vulnerabilidades cross-repo + imagens** | **Snyk** | **Sprint atual** |

Sprint B1 entrega visibilidade de CVEs em 3 fontes:

1. **Dependabot** — alerts em deps de cada repo `Falkzera/*` (npm/cargo/pip/go.mod). Cobertura cross-repo automática.
2. **Trivy** — CVEs em imagens Docker rodando na VM (`caddy:2-alpine`, `timescale/timescaledb-ha:pg16`, `falcao-financas-app`). Cobre OS layer + libs runtime.
3. **GitHub Security Advisories (GHSA)** — feed cross-cutting de advisories que afetam packages dos teus repos antes de Dependabot processar.

UI: aba **"Segurança"** dedicada no topbar + chip vermelho discreto em cards de projeto na aba Projetos quando há CVE Critical/High aberto.

## Objetivos

1. Coletor diário de Dependabot alerts pra todos os repos `Falkzera/*` (auto-discovery)
2. Coletor diário de Trivy scan nas imagens Docker ativas na VM
3. Tabela `vulnerabilities` unificada no Postgres (kind discriminator)
4. Aba "Segurança" no launcher com lista filtrada, agrupada por source
5. Chip vermelho nos `ProjectCard` da aba Projetos pra alerta visual passivo
6. Botão "Re-escanear agora" dispara scan on-demand
7. Dismiss persistente de CVEs (false positives) com revalidação automática quando `fix_version` muda
8. Severidade default Critical+High; Medium/Low atrás de toggle
9. Documentação completa (agent.md + CLAUDE.md + VALIDATION.md + skill)

## Não-objetivos (Sprint B1)

- **Push pra Telegram/email** — Sprint futura (depende de bot Telegram)
- **Auto-fix / criar PR de bump** — Dependabot já faz nativamente, não duplicar
- **Trivy SBOM scan** — focar em CVE; SBOM é outra camada
- **CVSS custom scoring** — usar severity vinda da fonte (Dependabot/Trivy já normalizam)
- **Multi-org repos** (`nor-noreason/*`, etc.) — apenas `Falkzera/*` nessa Sprint
- **Histórico/timeline de CVEs no UI** — DB persiste, mas UI mostra apenas estado atual
- **Auto-discovery de imagens privadas em registries externos** — apenas imagens já rodando na VM
- **Snyk SaaS integration** — não vamos usar Snyk pago; o "Snyk-like" é apenas referência funcional

## Decisões de design

### D1 — Fontes: Dependabot + Trivy + GHSA

**Decisão:** três fontes complementares.

- **Dependabot** cobre deps de cada repo (npm/cargo/pip/go.mod), normalização automática de severidade, expansão automática de GHSA. Free, incluso em todo repo público.
- **Trivy** cobre imagens Docker (OS layer + libs runtime). CVEs que Dependabot não vê. Free, open source.
- **GHSA standalone** preenche gap raro: advisories que afetam packages dos teus repos antes de Dependabot processar (latência típica < 24h, mas vale ter).

**Por que não npm audit / cargo audit local:** redundante com Dependabot e adiciona dependência de toolchain instalado.
**Por que não Snyk SaaS:** custo. E nossa solução com Dependabot+Trivy cobre 90%+ do uso real.

### D2 — Coleta hybrid: GH Actions + VM systemd

**Decisão:** cada fonte vai onde faz sentido topologicamente.

- **Dependabot + GHSA** rodam em **GitHub Actions cron** (precedente: health checks). Razão: dados são GitHub-native, sem transferência. Free tier sobrando.
- **Trivy** roda em **systemd timer na VM**. Razão: imagens Docker estão lá; pull pra runner GitHub seria desperdício de bandwidth.

**Persistência uniforme:** ambos escrevem na mesma tabela `vulnerabilities` no Postgres da VM. GH Actions usa SSH command-restricted (mesma chave dedicada do `falcao-monitor-push` da Sprint 2). Trivy escreve direto via `\COPY` local.

### D3 — Schema: tabela única `vulnerabilities` heterogênea

**Decisão:** uma hypertable TimescaleDB com `kind` discriminator (`'deps'`, `'image'`, `'advisory'`).

```sql
CREATE TABLE vulnerabilities (
  ts            TIMESTAMPTZ NOT NULL,
  kind          TEXT        NOT NULL,         -- discriminator
  severity      TEXT        NOT NULL,         -- critical|high|medium|low|unknown
  cve_id        TEXT,
  ghsa_id       TEXT,
  source_id     TEXT        NOT NULL,         -- repo full_name | image name+digest
  package_name  TEXT,
  package_version TEXT,
  fix_version   TEXT,
  title         TEXT,
  url           TEXT,
  state         TEXT        NOT NULL,         -- open|fixed|dismissed
  raw           JSONB                          -- payload original
);

SELECT create_hypertable('vulnerabilities', 'ts', if_not_exists => TRUE);
CREATE INDEX idx_vuln_lookup ON vulnerabilities (kind, severity, source_id, ts DESC);
CREATE INDEX idx_vuln_open_critical
  ON vulnerabilities (severity, ts DESC)
  WHERE state = 'open' AND severity IN ('critical', 'high');

-- Compression segmentby kind+source_id; retention 90d
```

**Trade-off aceito:** NULLs em campos específicos por kind (ex: `package_version` pode ser NULL pra `kind='advisory'`). Vale pelo benefício de uma única query servir toda a UI.

### D4 — Scope: auto-discovery de `Falkzera/*` apenas

**Decisão:** `gh api /user/repos --paginate` lista todos os repos do user, filter por `owner.login == "Falkzera"`. Repos sem Dependabot habilitado retornam 404 silencioso (skip + log).

**Por que não multi-org:** Falcão tem `nor-noreason/*` como collaborator, mas esses são produtos de equipe — não-objetivo nessa Sprint. Adicionar via allowlist em config se precisar.

**Repo novo:** entra automaticamente no próximo cron daily.

### D5 — UI: aba "Segurança" dedicada + chip nos projetos

**Decisão:** nova aba no topbar entre Skills e VM. Chip vermelho discreto nos `ProjectCard` quando repo tem CVE Critical/High open & não-dismissado.

**Por que não section dentro da aba VM:** vulnerabilidades não são vinculadas só à VM (Dependabot é cross-repo). Aba dedicada é mais correta semanticamente.

**Por que não chip-only (sem aba):** chip dá alerta passivo, mas pra investigar precisa drilldown rico — agrupamento por source, filtros por severidade, dismiss por CVE. Aba comporta isso melhor que drawer.

### D6 — Frequência: on-demand + cron diário

**Decisão:** cron diário (06:00 UTC = 03:00 Brasil) + botão "🔄 Re-escanear agora" no header da aba Segurança.

- **Diário:** vulnerabilidades aparecem em escala de dias, não horas. Cron mais frequente = desperdício de minutos GH Actions.
- **On-demand:** útil pra debug, após deploy de imagem nova, ou validar fix.

**On-demand mecanismo:** Tauri command `monitor_trigger_scan(kind)` que:
- Pra `image` ou `all`: SSH na VM rodando `scan-trivy.sh`
- Pra `deps` ou `all`: `gh workflow run security-scan.yml` via PAT

### D7 — Filtros default: Critical+High + dismiss persistente

**Decisão:** aba abre mostrando só Critical+High. Toggles "Mostrar Medium" e "Mostrar Low/Unknown" no header. Cada CVE tem botão "Dismissar" que persiste em `~/.config/falcao-launcher/config.json` com `fix_version` no momento do dismiss.

**Revalidação automática:** quando próximo scan trouxer mesmo CVE com `fix_version` diferente do dismissed, CVE reaparece (assume "patch novo, vale revisitar").

**Chip vermelho** nos ProjectCards conta apenas Critical+High open & não-dismissado.

## Arquitetura

```
┌──────────────────────────────────────────────────────────────────────┐
│ GitHub                                                               │
│   Falkzera/* (auto-discovery via gh api /user/repos)                │
│   Dependabot alerts + GHSA expansion                                 │
└────────────────┬─────────────────────────────────────────────────────┘
                 │
                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ GitHub Actions                                                       │
│   .github/workflows/security-scan.yml                                │
│   ├─ cron: 0 6 * * *  +  workflow_dispatch                           │
│   ├─ scripts/scan-dependabot.sh                                      │
│   │   ├─ gh api /user/repos --jq filter Falkzera                     │
│   │   ├─ pra cada: gh api /repos/{r}/dependabot/alerts --paginate    │
│   │   └─ gh api /advisories?affects=<package> (top 10)               │
│   └─ Push CSV → SSH falcao-monitor-push@vm \COPY                     │
└────────────────┬─────────────────────────────────────────────────────┘
                 │ SSH command-restricted
                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│ VM Hetzner                                                           │
│                                                                      │
│   Postgres TimescaleDB                                               │
│   └─ Tabela `vulnerabilities` (hypertable, retention 90d, comp 7d)  │
│                                                                      │
│   Trivy scanner (systemd user service + timer)                       │
│   └─ /home/falcao/.local/bin/scan-trivy.sh                           │
│       ├─ docker ps --format '{{.Image}}' | sort -u                   │
│       ├─ trivy image --quiet --format json --severity ... <img>      │
│       ├─ jq → CSV                                                    │
│       └─ \COPY local pro Postgres                                    │
│                                                                      │
│   Trivy DB cache: ~/.cache/trivy/ (~60 MB, mantido entre runs)       │
└────────────────┬─────────────────────────────────────────────────────┘
                 ▲ SSH tunnel já existente (54322) + monitor_reader
                 │
┌────────────────┴─────────────────────────────────────────────────────┐
│ Launcher (Tauri)                                                     │
│                                                                      │
│   src-tauri/src/monitor/security.rs (NEW)                           │
│   └─ list_vulnerabilities, vuln_summary, vuln_count_by_repo          │
│                                                                      │
│   src-tauri/src/monitor/commands.rs (extended)                       │
│   └─ monitor_list_vulnerabilities, monitor_vuln_summary,             │
│       monitor_vuln_count_by_repo, monitor_trigger_scan,              │
│       monitor_dismiss_cve, monitor_undismiss_cve                     │
│                                                                      │
│   src-tauri/src/config.rs (extended)                                 │
│   └─ dismissed_vulnerabilities: HashMap<String, DismissedVuln>      │
│                                                                      │
│   src-tauri/src/external.rs (extended)                               │
│   └─ trigger_trivy_scan_on_vm (SSH ssh ... scan-trivy.sh)            │
│                                                                      │
│   src/components/ (NEW)                                              │
│   ├─ SecurityTab.tsx (~250 linhas)                                   │
│   │   header (contadores + re-scan), filtros, lista                  │
│   ├─ VulnerabilityRow.tsx                                            │
│   │   severity chip, título, package, fix_version, dismiss btn       │
│   ├─ SecurityChip.tsx                                                │
│   │   chip compacto pros ProjectCards                                │
│   └─ SecurityScanProgress.tsx                                        │
│       overlay durante scan on-demand (reusa <InlineLoading>)         │
│                                                                      │
│   src/App.tsx (extended)                                             │
│   ├─ TopView ganha "security"                                        │
│   ├─ Botão na topbar entre Skills e VM                               │
│   └─ State global vulnCountByRepo p/ ProjectCards consumirem         │
│                                                                      │
│   src/components/ProjectCard.tsx (extended)                          │
│   └─ Render <SecurityChip count={vulnCountByRepo[repo]}>             │
└──────────────────────────────────────────────────────────────────────┘
```

## Componentes

### Backend

#### `src-tauri/src/monitor/security.rs` (NEW)

```rust
#[derive(Serialize, Debug, Clone)]
pub struct VulnerabilityRow {
    pub kind: String,
    pub severity: String,
    pub cve_id: Option<String>,
    pub ghsa_id: Option<String>,
    pub source_id: String,
    pub package_name: Option<String>,
    pub package_version: Option<String>,
    pub fix_version: Option<String>,
    pub title: Option<String>,
    pub url: Option<String>,
    pub state: String,
    pub last_seen: DateTime<Utc>,
}

#[derive(Serialize, Debug)]
pub struct VulnSummary {
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub last_scan: Option<DateTime<Utc>>,
    pub last_scan_error: Option<String>,
}

pub async fn list_vulnerabilities(
    pool: &Pool,
    severities: &[String],
    kinds: &[String],
) -> Result<Vec<VulnerabilityRow>>;

pub async fn vuln_summary(pool: &Pool) -> Result<VulnSummary>;

pub async fn vuln_count_by_repo(pool: &Pool) -> Result<HashMap<String, i64>>;
```

#### `src-tauri/src/monitor/commands.rs` (extended)

Comandos novos:
- `monitor_list_vulnerabilities(severities: Vec<String>, kinds: Vec<String>) -> Vec<VulnerabilityRow>`
- `monitor_vuln_summary() -> VulnSummary`
- `monitor_vuln_count_by_repo() -> HashMap<String, i64>`
- `monitor_trigger_scan(kind: String) -> ()` — async, emite eventos `vuln-scan-progress` durante execução
- `monitor_dismiss_cve(cve_key: String, fix_version_at_time: Option<String>) -> ()`
- `monitor_undismiss_cve(cve_key: String) -> ()`

#### `src-tauri/src/external.rs` (extended)

- `trigger_trivy_scan_on_vm(progress_emitter: AppHandle) -> Result<(), String>` — SSH na VM, executa `scan-trivy.sh`, lê stdout linha a linha, emite eventos `vuln-scan-progress { line, kind: "image" }`
- `trigger_dependabot_scan_via_gh(pat: String, progress_emitter: AppHandle) -> Result<(), String>` — `gh workflow run security-scan.yml -R Falkzera/falcao-launcher` via API

#### `src-tauri/src/config.rs` (extended)

```rust
#[derive(Serialize, Deserialize, Default)]
pub struct DismissedVuln {
    pub fix_version_at_time: Option<String>,
    pub dismissed_at: DateTime<Utc>,
}

pub struct Config {
    // ...campos existentes
    pub dismissed_vulnerabilities: HashMap<String, DismissedVuln>,  // key: "<source_id>:<cve_id>"
}
```

### Scripts

#### `scripts/scan-dependabot.sh` (NEW, ~80 linhas bash)

```bash
#!/usr/bin/env bash
set -euo pipefail

# 1. Listar repos Falkzera/*
REPOS=$(gh api /user/repos --paginate --jq '.[] | select(.owner.login=="Falkzera") | .full_name')

# 2. CSV header em stdout
echo "ts,kind,severity,cve_id,ghsa_id,source_id,package_name,package_version,fix_version,title,url,state"

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# 3. Pra cada repo
for repo in $REPOS; do
  # Dependabot alerts (tolera 404)
  alerts=$(gh api "/repos/$repo/dependabot/alerts?state=open&per_page=100" --paginate 2>/dev/null || echo "[]")
  echo "$alerts" | jq -r --arg ts "$NOW" --arg src "$repo" '.[] | [$ts, "deps", .security_advisory.severity, (.security_advisory.cve_id // ""), .security_advisory.ghsa_id, $src, .dependency.package.name, .security_vulnerability.vulnerable_version_range, (.security_vulnerability.first_patched_version.identifier // ""), .security_advisory.summary, .html_url, "open"] | @csv'
done

# 4. GHSA cross-cutting (top 10 mais recentes pra cada package único)
# (omitido pra economizar espaço — implementação no plan)
```

Output: CSV via stdout. Workflow GH Actions captura e faz pipe via SSH `\COPY`.

#### `/home/falcao/.local/bin/scan-trivy.sh` (NEW na VM, ~50 linhas bash)

```bash
#!/usr/bin/env bash
set -euo pipefail

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
IMAGES=$(docker ps --format '{{.Image}}' | sort -u)

CSV=$(mktemp)
trap 'rm -f "$CSV"' EXIT

for img in $IMAGES; do
  trivy image --quiet --format json --severity CRITICAL,HIGH,MEDIUM,LOW --no-progress "$img" 2>/dev/null | \
    jq -r --arg ts "$NOW" --arg src "$img" '
      (.Results // [])[]
      | (.Vulnerabilities // [])[]
      | [$ts, "image", (.Severity | ascii_downcase), .VulnerabilityID, "", $src, .PkgName, .InstalledVersion, (.FixedVersion // ""), .Title, .PrimaryURL, "open"]
      | @csv' >> "$CSV" || echo "[scan-trivy] skip $img: trivy failed"
done

# \COPY pro Postgres local
docker exec -i falcao-monitor-db psql -U monitor_writer -d falcao_monitor \
  -c "\\COPY vulnerabilities(ts,kind,severity,cve_id,ghsa_id,source_id,package_name,package_version,fix_version,title,url,state) FROM STDIN WITH CSV" < "$CSV"
```

#### `~/.config/systemd/user/falcao-trivy-scanner.service` + `.timer`

```ini
# falcao-trivy-scanner.service
[Unit]
Description=Trivy vulnerability scanner pra imagens Docker

[Service]
Type=oneshot
ExecStart=/home/falcao/.local/bin/scan-trivy.sh

# falcao-trivy-scanner.timer
[Unit]
Description=Run trivy scanner daily

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
```

#### `.github/workflows/security-scan.yml` (NEW)

- Triggers: cron `0 6 * * *` UTC + `workflow_dispatch`
- Job: `setup gh + jq` → `scan-dependabot.sh > out.csv` → `ssh falcao-monitor-push@vm \COPY` (mesma SSH key dedicada)
- Cybersec: `command="docker exec ... psql ..."` + `no-port-forwarding` + `no-pty` + restrição de host (host pinning) — **mesmo padrão da Sprint 2 health-checks-push**

### Frontend

#### `src/types/security.ts` (NEW)

```typescript
export type VulnSeverity = "critical" | "high" | "medium" | "low" | "unknown";
export type VulnKind = "deps" | "image" | "advisory";

export interface VulnerabilityRow {
  kind: VulnKind;
  severity: VulnSeverity;
  cve_id: string | null;
  ghsa_id: string | null;
  source_id: string;
  package_name: string | null;
  package_version: string | null;
  fix_version: string | null;
  title: string | null;
  url: string | null;
  state: "open" | "fixed" | "dismissed";
  last_seen: string;  // ISO
}

export interface VulnSummary {
  critical: number;
  high: number;
  medium: number;
  low: number;
  last_scan: string | null;
  last_scan_error: string | null;
}

export interface VulnFilters {
  severities: VulnSeverity[];
  kinds: VulnKind[];
  search: string;
}
```

#### `src/components/SecurityTab.tsx` (NEW, ~250 linhas)

State:
- `summary: VulnSummary | null`
- `vulns: VulnerabilityRow[] | null`
- `filters: VulnFilters` (default `{ severities: ["critical", "high"], kinds: ["deps", "image", "advisory"], search: "" }`)
- `scanInProgress: boolean`
- `scanProgress: string[]` (lines streaming do SSH)

Polling: `usePolling(monitorApi.listVulnerabilities, 60_000, ready)`.

Layout:
```
[Header]
  Total · X CVE Critical · Y High · Z Medium · W Low
  Última coleta: há 2h · [🔄 Re-escanear agora]
  [✓ Critical] [✓ High] [□ Medium] [□ Low/Unknown]
  [✓ deps] [✓ image] [✓ advisory]
─────────────────────────────────────────────────────
[Lista agrupada por source_id]
  ▾ Falkzera/falcao-launcher (3 abertos)
    [Critical] CVE-2024-XXXXX  tokio  1.40.0 → 1.40.1
                 RCE in tokio runtime [link advisory] [Dismissar]
    [High]     ...
  ▾ caddy:2-alpine (5 abertos)
    [High]     CVE-...
─────────────────────────────────────────────────────
[Empty state se vulns.length === 0]
  "Nenhuma vulnerabilidade ativa 🎉"
```

#### `src/components/VulnerabilityRow.tsx` (NEW)

Props: `{ vuln: VulnerabilityRow, onDismiss: (key: string, fixAtTime: string | null) => void, onUndismiss: (key: string) => void }`.

Visual: severity chip colorido (Critical=danger, High=warning, Medium=accent-secondary, Low=text-muted) + título + chip de package + fix_version se houver + link advisory + botão dismiss.

#### `src/components/SecurityChip.tsx` (NEW, compacto)

Props: `{ count: number }`. Render `null` se count == 0. Senão chip vermelho `{count} CVE` discreto pro canto do `ProjectCard`.

#### `src/components/SecurityScanProgress.tsx` (NEW)

Overlay quando `scanInProgress === true`. Usa `<InlineLoading>` com mensagens cíclicas custom: `["Buscando Dependabot alerts...", "Trivy scan em caddy...", "Trivy scan em timescaledb...", "Quase lá..."]`.

Listener de eventos Tauri `vuln-scan-progress` adiciona linhas à `scanProgress` array.

### Modificações em arquivos existentes

#### `src/App.tsx`
- `TopView` ganha `"security"` (`type TopView = "projects" | "skills" | "vm" | "security"`)
- Botão na topbar entre Skills e VM com chip de contagem total Critical/High
- State `vulnCountByRepo: Record<string, number>` populado por `monitorApi.vulnCountByRepo()` (poll 5min)
- Renderiza `<SecurityTab>` quando `topView === "security"`

#### `src/components/ProjectCard.tsx`
- Aceita prop `vulnCount?: number`
- Render `<SecurityChip count={vulnCount ?? 0}>` no canto

#### `src/lib/monitor.ts`
6 wrappers novos:
- `listVulnerabilities(filters: VulnFilters)`
- `vulnSummary()`
- `vulnCountByRepo()`
- `triggerScan(kind: "all" | "deps" | "image")`
- `dismissCve(cveKey: string, fixVersion: string | null)`
- `undismissCve(cveKey: string)`

## Setup operacional

### Secrets / config novos

- **GitHub PAT** (criar se não tem): scopes `read:packages`, `security_events`, `public_repo`, `actions:write`. Vai pra:
  - GitHub Actions secrets como `GH_PAT_SECURITY` (workflow usa via `GH_TOKEN`)
  - `~/.config/falcao-monitor/.env` na VM como `GITHUB_PAT_SECURITY=...` (Tauri command pode dispatchar workflow)
- **Trivy** instalado na VM (uma vez, manual): `curl -sfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sudo sh`
- **Trivy DB cache** em `~/.cache/trivy/` (~60 MB primeira vez, atualiza incremental)
- **systemd user services** habilitados: `systemctl --user enable --now falcao-trivy-scanner.timer`

### Migration

`./scripts/apply-vm-migrations.sh` aplica `008_vulnerabilities.sql` (script idempotente já existe).

## Edge cases e error handling

| Cenário | Comportamento |
|---|---|
| Repo sem Dependabot habilitado | `gh api` 404 → `scan-dependabot.sh` log warn e skip |
| Repo arquivado | Mesma coisa — skip silencioso |
| PAT sem scope `security_events` | Workflow falha; UI mostra banner "verificar PAT GitHub" |
| Trivy sem rede / DB outdated | Script log warn e skip imagem; outras continuam |
| Imagem Docker nova | Próximo cron diário pega via `docker ps` |
| CVE com `fix_version: null` | UI mostra "sem fix disponível" (cinza). Conta no chip vermelho |
| Mesmo CVE em múltiplos repos | Aparece N vezes (uma por `source_id`); agrupamento separa visualmente |
| Dismiss + fix_version diferente em scan novo | UI compara — se versão mudou, chip volta a aparecer |
| Scan on-demand SSH cai | UI mostra erro inline; `last_scan_error` persiste no DB |
| Tabela vazia (1ª vez) | Empty state: "Aguardando primeira coleta — clique 'Re-escanear agora'" |
| GH Actions atinge limite mensal | 30 min/mês esperado, free tier 2000 — folga 60x |
| GHSA query retorna milhares | Limit 10 mais recentes por package que aparece nos teus repos |
| Imagem com tag `latest` | Trivy resolve digest pra dedup estável (`@sha256:...`) |
| `monitor_trigger_scan` bloqueia thread | `tokio::spawn` async + emit progress events |

## Riscos

1. **Trivy DB initial download (~60 MB).** Primeiro scan demora 2-5min. Mitigação: documentar no setup; cache em `~/.cache/trivy` mantém entre runs.
2. **GitHub API rate limit** (5000 req/h com PAT): ~50 req/scan = folga 100x.
3. **GHSA cross-cutting duplica Dependabot.** Mitigação: GHSA só guarda advisories sem dependabot alert correspondente nos teus repos. Dedup via constraint `(cve_id, source_id, kind)` única per scan.
4. **`docker ps` lista imagens com tag mutável** (`caddy:2-alpine`). Trivy aceita digest — usar `@sha256:...` pra dedup estável entre scans.
5. **Falsos positivos em deps transitivas / OS layer.** Aceito — dismiss persistente cobre.
6. **Spawn SSH bloqueante no Tauri.** Mitigação: `tokio::spawn` + emit events.
7. **Trivy install manual** — fora do código, depende de Falcão executar 1x. Documentar no spec + no skill.

## Critérios de aceite (15 itens)

A sprint só fecha se:

1. ✅ Migration `008_vulnerabilities.sql` aplicada — hypertable + indexes + compression + retention
2. ✅ Workflow `.github/workflows/security-scan.yml` rodando diário + workflow_dispatch
3. ✅ `scripts/scan-dependabot.sh` busca repos `Falkzera/*`, lista alerts + GHSA, push pro Postgres via SSH
4. ✅ `/home/falcao/.local/bin/scan-trivy.sh` na VM + systemd timer ativo
5. ✅ Após primeira coleta: rows ≥ 0 no DB (smoke validation)
6. ✅ Aba "Segurança" no topbar entre Skills e VM
7. ✅ Header com contadores por severidade + botão "Re-escanear agora"
8. ✅ Filtros funcionam: toggles severidade + kind
9. ✅ Default mostra Critical+High; toggles ligam Medium/Low
10. ✅ Botão "Dismissar" persiste em config.json com `fix_version_at_time`
11. ✅ Dismiss reaparece quando próximo scan trouxer `fix_version` diferente
12. ✅ `<SecurityChip>` aparece em `ProjectCard` quando há CVE Critical/High open & não-dismissado
13. ✅ "Re-escanear agora" dispara SSH (Trivy) + GH Actions (Dependabot) com progress streaming
14. ✅ cargo test + tsc + build release passando
15. ✅ Documentação completa: 4 agent.md + CLAUDE.md + VALIDATION.md + skill `falcao-launcher`

## Próximos passos pós-aprovação

→ Plan TDD em `docs/superpowers/plans/2026-05-08-snyk-like.md` quebrando em fases:

- **Phase A — DB + scripts** (~1 dia)
  - A1: migration `008_vulnerabilities.sql` + apply
  - A2: `scan-dependabot.sh` + workflow GH Actions + SSH push key reuse
  - A3: `scan-trivy.sh` + systemd timer + Trivy install na VM
- **Phase B — Backend Rust** (~0.5 dia, paralelizável com Phase C)
  - B1: `security.rs` (queries) + commands Tauri
  - B2: `external.rs` extended (trigger_trivy_scan_on_vm, trigger_dependabot_scan_via_gh)
  - B3: config.rs extended (dismissed_vulnerabilities)
- **Phase C — Frontend** (~1 dia, paralelizável com Phase B)
  - C1: tipos TS + monitorApi wrappers
  - C2: `SecurityTab` + `VulnerabilityRow` + `SecurityScanProgress`
  - C3: `SecurityChip` + integração em `ProjectCard` + `App.tsx` topbar
- **Phase D — Validação** (smoke manual)
- **Phase E — Docs + PR** (~0.5 dia)

**Tempo estimado:** ~3 dias sequencial; ~2 dias com paralelização B‖C.
