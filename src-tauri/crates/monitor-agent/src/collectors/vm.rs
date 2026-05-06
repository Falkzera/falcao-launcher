//! Coletor de métricas VM-level: /proc, df, uptime.

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use monitor_shared::{MetricRow, MetricSource, HOST_NAME};
use std::fs;
use std::time::Duration;
use tokio::process::Command;

pub async fn collect(ts: DateTime<Utc>) -> Result<Vec<MetricRow>> {
    let mut out = Vec::with_capacity(16);

    // mem + swap
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
    if let Some(v) = parse_swap_used_kib(&mem) {
        out.push(metric(ts, "swap_used_bytes", v as f64 * 1024.0));
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

    // cpu_pct (delta entre duas leituras do /proc/stat)
    if let Some(v) = read_cpu_pct().await {
        out.push(metric(ts, "cpu_pct", v));
    }

    // disk (df / -k)
    if let Some((used, avail)) = read_disk_root().await {
        out.push(metric(ts, "disk_used_bytes", used));
        out.push(metric(ts, "disk_avail_bytes", avail));
    }

    // net_rx/tx (cumulativos, soma todas interfaces exceto lo)
    if let Ok(net) = fs::read_to_string("/proc/net/dev") {
        if let Some((rx, tx)) = parse_net_dev_totals(&net) {
            out.push(metric(ts, "net_rx_bytes", rx as f64));
            out.push(metric(ts, "net_tx_bytes", tx as f64));
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

/// SwapTotal - SwapFree (em KiB). None se não der pra ler ambos.
fn parse_swap_used_kib(meminfo: &str) -> Option<u64> {
    let total = parse_meminfo_kib(meminfo, "SwapTotal")?;
    let free = parse_meminfo_kib(meminfo, "SwapFree")?;
    Some(total.saturating_sub(free))
}

#[derive(Debug, Clone, Copy)]
struct CpuStat {
    idle: u64,
    total: u64,
}

/// Lê primeira linha de /proc/stat ("cpu  user nice system idle iowait irq softirq steal ...").
/// Retorna (idle = idle+iowait, total = soma de todos os campos).
fn parse_proc_stat(s: &str) -> Option<CpuStat> {
    let line = s.lines().next()?;
    if !line.starts_with("cpu ") && !line.starts_with("cpu\t") {
        return None;
    }
    let fields: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|f| f.parse::<u64>().ok())
        .collect();
    if fields.len() < 4 {
        return None;
    }
    let idle = fields[3] + fields.get(4).copied().unwrap_or(0); // idle + iowait
    let total: u64 = fields.iter().sum();
    Some(CpuStat { idle, total })
}

fn cpu_pct_from(prev: CpuStat, cur: CpuStat) -> Option<f64> {
    let total_d = cur.total.checked_sub(prev.total)?;
    let idle_d = cur.idle.checked_sub(prev.idle)?;
    if total_d == 0 {
        return None;
    }
    Some(100.0 * (1.0 - idle_d as f64 / total_d as f64))
}

async fn read_cpu_pct() -> Option<f64> {
    let s1 = fs::read_to_string("/proc/stat").ok()?;
    let snap1 = parse_proc_stat(&s1)?;
    tokio::time::sleep(Duration::from_millis(100)).await;
    let s2 = fs::read_to_string("/proc/stat").ok()?;
    let snap2 = parse_proc_stat(&s2)?;
    cpu_pct_from(snap1, snap2)
}

/// `df / -k` → última linha → cols 3 (used) e 4 (avail) em KiB → bytes.
async fn read_disk_root() -> Option<(f64, f64)> {
    let output = Command::new("df").args(["/", "-k"]).output().await.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_df_kib(&stdout)
}

/// Parser do output de `df / -k`. Retorna (used_bytes, avail_bytes).
fn parse_df_kib(s: &str) -> Option<(f64, f64)> {
    // Formato típico:
    // Filesystem     1K-blocks    Used Available Use% Mounted on
    // /dev/sda1       40000000  10000000  28000000  27% /
    // (mas em alguns sistemas o filesystem-name quebra em 2 linhas)
    let mut last_data_line: Option<String> = None;
    for line in s.lines().skip(1) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        last_data_line = Some(trimmed.to_string());
    }
    let line = last_data_line?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    // Última linha pode ter 6 campos (normal) ou 5 (se "Mounted on" é "/" e filesystem está sozinho).
    // Sempre olhamos pelos campos numéricos: Used = -4, Available = -3 (contando do fim, com Use% e Mounted on).
    if fields.len() < 5 {
        return None;
    }
    // Se temos "Mounted on" como último (e.g. "/"), Use% em -2, Avail em -3, Used em -4.
    let n = fields.len();
    let used_kib: f64 = fields[n - 4].parse().ok()?;
    let avail_kib: f64 = fields[n - 3].parse().ok()?;
    Some((used_kib * 1024.0, avail_kib * 1024.0))
}

/// Soma rx_bytes (col 1) e tx_bytes (col 9, 0-indexado dos números após `iface:`)
/// para todas as interfaces exceto `lo`. Retorna (rx, tx) em bytes.
fn parse_net_dev_totals(s: &str) -> Option<(u64, u64)> {
    let mut rx_sum: u64 = 0;
    let mut tx_sum: u64 = 0;
    let mut found = false;
    for line in s.lines() {
        // Cabeçalho tem dois "|", linhas de dados têm ":"
        let Some(colon_pos) = line.find(':') else {
            continue;
        };
        let iface = line[..colon_pos].trim();
        if iface == "lo" || iface.is_empty() {
            continue;
        }
        let rest = &line[colon_pos + 1..];
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // /proc/net/dev: rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame rx_compressed rx_multicast
        //                tx_bytes tx_packets tx_errs tx_drop tx_fifo tx_colls tx_carrier tx_compressed
        if fields.len() < 16 {
            continue;
        }
        let rx: u64 = fields[0].parse().ok()?;
        let tx: u64 = fields[8].parse().ok()?;
        rx_sum = rx_sum.saturating_add(rx);
        tx_sum = tx_sum.saturating_add(tx);
        found = true;
    }
    if found {
        Some((rx_sum, tx_sum))
    } else {
        None
    }
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

    #[test]
    fn parses_swap_used() {
        let sample = "SwapTotal:       2097148 kB\nSwapFree:        1097148 kB\n";
        assert_eq!(parse_swap_used_kib(sample), Some(1_000_000));

        let no_swap = "SwapTotal:             0 kB\nSwapFree:              0 kB\n";
        assert_eq!(parse_swap_used_kib(no_swap), Some(0));

        let missing = "MemTotal: 4 kB\n";
        assert_eq!(parse_swap_used_kib(missing), None);
    }

    #[test]
    fn parses_proc_stat_first_line() {
        let sample = "cpu  100 200 300 400 50 0 10 0 0 0\ncpu0 ...\n";
        let s = parse_proc_stat(sample).unwrap();
        // idle = 400 + 50 = 450
        // total = 100+200+300+400+50+0+10 = 1060
        assert_eq!(s.idle, 450);
        assert_eq!(s.total, 1060);
    }

    #[test]
    fn computes_cpu_pct_delta() {
        // Entre snapshots: total_d=200, idle_d=50 → 100*(1 - 50/200) = 75%
        let prev = CpuStat { idle: 100, total: 1000 };
        let cur = CpuStat { idle: 150, total: 1200 };
        let v = cpu_pct_from(prev, cur).unwrap();
        assert!((v - 75.0).abs() < 1e-9);
    }

    #[test]
    fn cpu_pct_returns_none_when_total_unchanged() {
        let prev = CpuStat { idle: 100, total: 1000 };
        let cur = CpuStat { idle: 100, total: 1000 };
        assert!(cpu_pct_from(prev, cur).is_none());
    }

    #[test]
    fn parses_df_output() {
        let sample = "Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/sda1       40000000  10000000  28000000  27% /\n";
        let (used, avail) = parse_df_kib(sample).unwrap();
        assert!((used - 10_000_000.0 * 1024.0).abs() < 1.0);
        assert!((avail - 28_000_000.0 * 1024.0).abs() < 1.0);
    }

    #[test]
    fn parses_df_output_with_long_filesystem_name() {
        // Caso em que fs name quebra linha (df comporta sozinho normalmente, mas testamos campo-count)
        let sample = "Filesystem     1K-blocks    Used Available Use% Mounted on\n/dev/mapper/very-long-name 1000000 200000 800000 20% /\n";
        let (used, avail) = parse_df_kib(sample).unwrap();
        assert!((used - 200_000.0 * 1024.0).abs() < 1.0);
        assert!((avail - 800_000.0 * 1024.0).abs() < 1.0);
    }

    #[test]
    fn parses_net_dev_summing_non_lo() {
        // Cabeçalho de 2 linhas + lo + eth0. Cols depois do `:`:
        //  rx_bytes rx_packets rx_errs rx_drop rx_fifo rx_frame rx_compressed rx_multicast
        //  tx_bytes tx_packets tx_errs tx_drop tx_fifo tx_colls tx_carrier tx_compressed
        let sample = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
  eth1: 200 2 0 0 0 0 0 0 300 3 0 0 0 0 0 0
";
        let (rx, tx) = parse_net_dev_totals(sample).unwrap();
        assert_eq!(rx, 5200);
        assert_eq!(tx, 7300);
    }

    #[test]
    fn parses_net_dev_skips_lo_only_returns_none() {
        let sample = "\
Inter-| Receive | Transmit
 face |bytes ...|bytes ...
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
";
        assert!(parse_net_dev_totals(sample).is_none());
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
