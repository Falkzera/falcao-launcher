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
