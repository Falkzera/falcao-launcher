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
