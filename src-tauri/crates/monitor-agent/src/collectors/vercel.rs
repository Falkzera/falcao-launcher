//! Coletor Vercel via REST API (https://api.vercel.com).
//!
//! Lista todos os projetos da conta + último deploy de cada um.
//! Roda fora do loop de 15s — task separada com tick de 5min (rate limit Vercel ~100 req/h).

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::VercelDeployment;
use reqwest::Client;
use serde_json::Value;
use tracing::warn;

const API_BASE: &str = "https://api.vercel.com";

/// Coleta os últimos deployments de todos os projetos Vercel da conta.
///
/// Auth via `token` (Bearer). Falhas individuais por projeto não derrubam a
/// coleta — são logadas e seguimos. Retorna `Vec` vazio se a conta não tem
/// projetos ainda.
pub async fn collect(
    ts: DateTime<Utc>,
    client: &Client,
    token: &str,
) -> Result<Vec<VercelDeployment>> {
    let projects = fetch_projects(client, token).await?;
    let mut out = Vec::with_capacity(projects.len());

    for (id, name) in projects {
        match fetch_latest_deployment(client, token, &id).await {
            Ok(Some(deployment_json)) => {
                if let Some(row) = parse_deployment(ts, &id, &name, &deployment_json) {
                    out.push(row);
                }
            }
            Ok(None) => {
                // Projeto sem deploys ainda — sem warn, é estado válido.
            }
            Err(e) => warn!("vercel: fetch deployments {name} ({id}) failed: {e:#}"),
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
    let body: Value = resp
        .error_for_status()
        .context("GET /v9/projects status")?
        .json()
        .await
        .context("parse /v9/projects body")?;
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
    let body: Value = resp
        .error_for_status()
        .context("GET /v6/deployments status")?
        .json()
        .await
        .context("parse /v6/deployments body")?;
    Ok(body
        .get("deployments")
        .and_then(Value::as_array)
        .and_then(|arr| arr.first().cloned()))
}

/// Loga warn se o rate limit Vercel está abaixo de 10 chamadas restantes.
/// Sprint 2: log apenas. Retry exponencial fica pra futuro se virar problema.
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

/// Extrai (id, name) da resposta de `/v9/projects`.
///
/// Separado de `fetch_projects` pra ser testável sem rede.
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

/// Mapeia 1 entry de `/v6/deployments` → `VercelDeployment`.
///
/// Defensive: missing `uid` ou `state` → `None` (deploy malformado, ignora).
/// Outros campos opcionais → `None` no struct (vão pra coluna NULL).
/// Separado de `fetch_latest_deployment` pra testes sem rede.
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_projects_response_with_two_projects() {
        let body = json!({
            "projects": [
                {"id": "prj_abc", "name": "falcao-financas"},
                {"id": "prj_def", "name": "outro"}
            ]
        });
        let parsed = parse_projects_response(&body);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].0, "prj_abc");
        assert_eq!(parsed[0].1, "falcao-financas");
        assert_eq!(parsed[1].1, "outro");
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
        assert_eq!(r.deployment_id, "dpl_xyz");
        assert_eq!(r.state, "READY");
        assert_eq!(r.url.as_deref(), Some("falcao-financas-abc.vercel.app"));
        assert_eq!(r.prod_url.as_deref(), Some("falcao-financas.vercel.app"));
        assert_eq!(r.branch.as_deref(), Some("main"));
        assert_eq!(r.commit_sha.as_deref(), Some("abcd1234"));
        assert_eq!(r.commit_msg.as_deref(), Some("fix: ajuste"));
        assert_eq!(r.author.as_deref(), Some("Falkzera"));
        assert_eq!(r.build_ms, Some(60_000));
        assert!(r.created_at.is_some());
        assert!(r.ready_at.is_some());
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
        assert!(r.created_at.is_some());
        assert_eq!(r.ready_at, None);
        assert_eq!(r.build_ms, None);
        assert_eq!(r.branch, None);
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
