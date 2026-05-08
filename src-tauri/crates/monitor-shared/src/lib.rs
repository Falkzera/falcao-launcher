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
    Vercel,
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

/// Snapshot de um deployment Vercel — heterogêneo demais pra `MetricRow` (texto + timestamps + estado),
/// vai pra tabela dedicada `vercel_deployments`.
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

pub const HOST_NAME: &str = "falcao-main";
pub const POLL_INTERVAL_SECS: u64 = 15;

/// Endpoints monitorados pelo health check externo (Sprint 2).
pub const HEALTH_ENDPOINTS: [&str; 3] = [
    "https://falcao-financas.duckdns.org/api/health",
    "https://falcao-financas.vercel.app",
    "https://162.55.217.189",
];
