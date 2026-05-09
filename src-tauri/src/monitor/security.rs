//! Queries SELECT pra tabela `vulnerabilities` (Sprint B1 — Snyk-like).
//!
//! Tabela única heterogênea com kind discriminator (deps|image|advisory).
//! Filtragem por severidade + kind no SQL (mais barato que client-side).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use deadpool_postgres::Pool;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize)]
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

#[derive(Debug, Serialize)]
pub struct VulnSummary {
    pub critical: i64,
    pub high: i64,
    pub medium: i64,
    pub low: i64,
    pub last_scan: Option<DateTime<Utc>>,
}

/// Lista vulnerabilidades open com filtros.
/// Retorna apenas a observação MAIS RECENTE de cada (kind, source_id, cve_id) —
/// evita duplicados quando scans repetidos persistem o mesmo CVE.
pub async fn list_vulnerabilities(
    pool: &Pool,
    severities: &[String],
    kinds: &[String],
) -> Result<Vec<VulnerabilityRow>> {
    let client = pool.get().await?;

    let valid_severities = ["critical", "high", "medium", "low", "unknown"];
    let valid_kinds = ["deps", "image", "advisory"];

    let sev_filter: Vec<String> = severities
        .iter()
        .filter(|s| valid_severities.contains(&s.as_str()))
        .cloned()
        .collect();
    let kind_filter: Vec<String> = kinds
        .iter()
        .filter(|k| valid_kinds.contains(&k.as_str()))
        .cloned()
        .collect();

    if sev_filter.is_empty() || kind_filter.is_empty() {
        return Ok(Vec::new());
    }

    // CVEs que sumiram em scans novos: o registro antigo continua state=open
    // por até 7 dias. Filtro só CVEs do scan mais recente por (kind, source_id)
    // — janela de 10 minutos cobre scans paralelos (trivy + dependabot) sem
    // misturar com runs antigos.
    let rows = client
        .query(
            r#"
            WITH latest_scan AS (
              SELECT kind, source_id, MAX(ts) AS scan_ts
              FROM vulnerabilities
              WHERE state = 'open' AND ts > now() - interval '7 days'
              GROUP BY kind, source_id
            )
            SELECT DISTINCT ON (v.kind, v.source_id, COALESCE(v.cve_id, v.ghsa_id, v.package_name))
              v.kind, v.severity, v.cve_id, v.ghsa_id, v.source_id, v.package_name,
              v.package_version, v.fix_version, v.title, v.url, v.state, v.ts
            FROM vulnerabilities v
            JOIN latest_scan l
              ON v.kind = l.kind AND v.source_id = l.source_id
            WHERE v.state = 'open'
              AND v.ts >= l.scan_ts - interval '10 minutes'
              AND v.severity = ANY($1)
              AND v.kind = ANY($2)
            ORDER BY v.kind, v.source_id, COALESCE(v.cve_id, v.ghsa_id, v.package_name), v.ts DESC
            "#,
            &[&sev_filter, &kind_filter],
        )
        .await
        .context("list vulnerabilities")?;

    Ok(rows
        .into_iter()
        .map(|r| VulnerabilityRow {
            kind: r.get(0),
            severity: r.get(1),
            cve_id: r.get(2),
            ghsa_id: r.get(3),
            source_id: r.get(4),
            package_name: r.get(5),
            package_version: r.get(6),
            fix_version: r.get(7),
            title: r.get(8),
            url: r.get(9),
            state: r.get(10),
            last_seen: r.get(11),
        })
        .collect())
}

pub async fn vuln_summary(pool: &Pool) -> Result<VulnSummary> {
    let client = pool.get().await?;

    // Mesma lógica do list_vulnerabilities: só conta CVEs do scan mais recente
    // por source — evita inflar contadores com CVEs já corrigidas.
    let row = client
        .query_one(
            r#"
            WITH latest_scan AS (
              SELECT kind, source_id, MAX(ts) AS scan_ts
              FROM vulnerabilities
              WHERE state = 'open' AND ts > now() - interval '7 days'
              GROUP BY kind, source_id
            ),
            latest AS (
              SELECT DISTINCT ON (v.kind, v.source_id, COALESCE(v.cve_id, v.ghsa_id, v.package_name))
                v.severity, v.ts
              FROM vulnerabilities v
              JOIN latest_scan l ON v.kind = l.kind AND v.source_id = l.source_id
              WHERE v.state = 'open' AND v.ts >= l.scan_ts - interval '10 minutes'
              ORDER BY v.kind, v.source_id, COALESCE(v.cve_id, v.ghsa_id, v.package_name), v.ts DESC
            )
            SELECT
              COUNT(*) FILTER (WHERE severity = 'critical') AS critical,
              COUNT(*) FILTER (WHERE severity = 'high')     AS high,
              COUNT(*) FILTER (WHERE severity = 'medium')   AS medium,
              COUNT(*) FILTER (WHERE severity = 'low')      AS low,
              MAX(ts) AS last_scan
            FROM latest
            "#,
            &[],
        )
        .await
        .context("vuln summary")?;

    Ok(VulnSummary {
        critical: row.get(0),
        high: row.get(1),
        medium: row.get(2),
        low: row.get(3),
        last_scan: row.get(4),
    })
}

/// Retorna a lista de "tokens" trackeados pelo monitor (Sprint B1.5).
///
/// Tokens vêm de 3 fontes na VM/produção:
///   - Vercel project names (frontend trackeado)
///   - Container resources rodando nos últimos 7 dias
///   - Stack labels de containers (`monitor.stack=...`)
///
/// O frontend usa esses tokens em substring match (case-insensitive)
/// contra `vuln.source_id` pra esconder repos antigos não-trackeados.
/// Imagens Docker (`kind=image`) são automaticamente trackeadas
/// (Trivy só escaneia imagens em uso na VM).
pub async fn list_tracked_tokens(pool: &Pool) -> Result<Vec<String>> {
    let client = pool.get().await?;

    let rows = client
        .query(
            r#"
            SELECT DISTINCT project_name FROM vercel_deployments
              WHERE project_name IS NOT NULL AND project_name <> ''
            UNION
            SELECT DISTINCT resource FROM metrics
              WHERE source = 'container'
                AND ts > now() - interval '7 days'
                AND resource IS NOT NULL
            UNION
            SELECT DISTINCT (labels->>'stack') FROM metrics
              WHERE source = 'container'
                AND ts > now() - interval '7 days'
                AND labels ? 'stack'
                AND (labels->>'stack') <> ''
            "#,
            &[],
        )
        .await
        .context("list tracked tokens")?;

    Ok(rows.into_iter().map(|r| r.get::<_, String>(0)).collect())
}

pub async fn vuln_count_by_repo(pool: &Pool) -> Result<HashMap<String, i64>> {
    let client = pool.get().await?;

    // Mesma lógica de "scan mais recente" das outras queries.
    let rows = client
        .query(
            r#"
            WITH latest_scan AS (
              SELECT kind, source_id, MAX(ts) AS scan_ts
              FROM vulnerabilities
              WHERE state = 'open' AND ts > now() - interval '7 days'
              GROUP BY kind, source_id
            ),
            latest AS (
              SELECT DISTINCT ON (v.kind, v.source_id, COALESCE(v.cve_id, v.ghsa_id, v.package_name))
                v.kind, v.source_id, v.severity
              FROM vulnerabilities v
              JOIN latest_scan l ON v.kind = l.kind AND v.source_id = l.source_id
              WHERE v.state = 'open' AND v.ts >= l.scan_ts - interval '10 minutes'
              ORDER BY v.kind, v.source_id, COALESCE(v.cve_id, v.ghsa_id, v.package_name), v.ts DESC
            )
            SELECT source_id, COUNT(*)
            FROM latest
            WHERE kind = 'deps' AND severity IN ('critical', 'high')
            GROUP BY source_id
            "#,
            &[],
        )
        .await
        .context("vuln count by repo")?;

    let mut out = HashMap::with_capacity(rows.len());
    for r in rows {
        out.insert(r.get::<_, String>(0), r.get::<_, i64>(1));
    }
    Ok(out)
}
