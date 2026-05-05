// src-tauri/src/claude.rs
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct AggregatedUsage {
    pub input_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub output_tokens: u64,
}

impl AggregatedUsage {
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
            + self.output_tokens
    }

    pub fn add(&mut self, other: &AggregatedUsage) {
        self.input_tokens += other.input_tokens;
        self.cache_creation_input_tokens += other.cache_creation_input_tokens;
        self.cache_read_input_tokens += other.cache_read_input_tokens;
        self.output_tokens += other.output_tokens;
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct ClaudeSession {
    pub session_id: String,
    pub project_path: String,
    pub git_branch: Option<String>,
    pub title: Option<String>,
    pub model: Option<String>,
    pub started_at: i64,        // unix ms
    pub last_activity: i64,     // unix ms
    pub message_count: u32,
    pub duration_ms: u64,
    pub usage: AggregatedUsage,
}

#[derive(Serialize, Clone, Debug)]
pub struct ClaudeProjectState {
    pub project_path: String,
    pub sessions: Vec<ClaudeSession>,
    pub active_session_id: Option<String>,
    pub total_usage: AggregatedUsage,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Granularity {
    Day,
    Month,
    Year,
}

#[derive(Serialize, Clone, Debug)]
pub struct TokenBucket {
    pub bucket_start: i64, // unix ms
    pub usage: AggregatedUsage,
}

const ACTIVE_WINDOW_MS: i64 = 5 * 60 * 1000;

pub fn is_active(last_activity: i64, now_ms: i64) -> bool {
    now_ms - last_activity <= ACTIVE_WINDOW_MS
}

#[derive(Clone, Copy)]
pub struct ModelPricing {
    pub input_per_1m: f64,
    pub cache_create_per_1m: f64,
    pub cache_read_per_1m: f64,
    pub output_per_1m: f64,
}

pub const PRICING_AS_OF_2026_05: &[(&str, ModelPricing)] = &[
    ("claude-opus-4-7", ModelPricing {
        input_per_1m: 15.00,
        cache_create_per_1m: 18.75,
        cache_read_per_1m: 1.50,
        output_per_1m: 75.00,
    }),
    ("claude-sonnet-4-6", ModelPricing {
        input_per_1m: 3.00,
        cache_create_per_1m: 3.75,
        cache_read_per_1m: 0.30,
        output_per_1m: 15.00,
    }),
    ("claude-haiku-4-5", ModelPricing {
        input_per_1m: 0.80,
        cache_create_per_1m: 1.00,
        cache_read_per_1m: 0.08,
        output_per_1m: 4.00,
    }),
];

const FALLBACK_PRICING: ModelPricing = ModelPricing {
    input_per_1m: 3.00,
    cache_create_per_1m: 3.75,
    cache_read_per_1m: 0.30,
    output_per_1m: 15.00,
};

/// Resolve pricing por prefixo de model id. Ex: "claude-opus-4-7-1m" casa "claude-opus-4-7".
pub fn pricing_for(model: &str) -> &'static ModelPricing {
    for (key, pricing) in PRICING_AS_OF_2026_05 {
        if model.starts_with(key) {
            return pricing;
        }
    }
    &FALLBACK_PRICING
}

pub fn cost_usd(usage: &AggregatedUsage, p: &ModelPricing) -> f64 {
    (usage.input_tokens as f64 * p.input_per_1m
        + usage.cache_creation_input_tokens as f64 * p.cache_create_per_1m
        + usage.cache_read_input_tokens as f64 * p.cache_read_per_1m
        + usage.output_tokens as f64 * p.output_per_1m)
        / 1_000_000.0
}

use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc};
use std::collections::HashSet;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

fn parse_iso_to_unix_ms(s: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

/// Parseia um arquivo JSONL inteiro de sessão e retorna o agregado.
/// Linhas malformadas são puladas com warn.
pub fn parse_session_file(path: &Path) -> Result<ClaudeSession, String> {
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("invalid session filename: {:?}", path))?
        .to_string();

    let file = File::open(path).map_err(|e| format!("open {}: {}", path.display(), e))?;
    let reader = BufReader::new(file);

    let mut session = ClaudeSession {
        session_id,
        project_path: String::new(),
        git_branch: None,
        title: None,
        model: None,
        started_at: i64::MAX,
        last_activity: 0,
        message_count: 0,
        duration_ms: 0,
        usage: AggregatedUsage::default(),
    };

    let mut seen_message_ids: HashSet<String> = HashSet::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value): Result<serde_json::Value, _> = serde_json::from_str(&line) else {
            continue;
        };

        let event_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

        // Timestamps
        if let Some(ts_str) = value.get("timestamp").and_then(|t| t.as_str()) {
            if let Some(ts_ms) = parse_iso_to_unix_ms(ts_str) {
                if ts_ms < session.started_at {
                    session.started_at = ts_ms;
                }
                if ts_ms > session.last_activity {
                    session.last_activity = ts_ms;
                }
            }
        }

        // cwd
        if session.project_path.is_empty() {
            if let Some(cwd) = value.get("cwd").and_then(|c| c.as_str()) {
                session.project_path = cwd.to_string();
            }
        }

        // gitBranch
        if session.git_branch.is_none() {
            if let Some(b) = value.get("gitBranch").and_then(|b| b.as_str()) {
                session.git_branch = Some(b.to_string());
            }
        }

        // duração — soma só durationMs em assistant events
        if event_type == "assistant" {
            if let Some(d) = value.get("durationMs").and_then(|d| d.as_u64()) {
                session.duration_ms += d;
            }
            // model
            if let Some(m) = value
                .get("message")
                .and_then(|m| m.get("model"))
                .and_then(|m| m.as_str())
            {
                session.model = Some(m.to_string());
            }
            // usage — dedup por messageId
            let msg_id = value
                .get("message")
                .and_then(|m| m.get("id"))
                .and_then(|m| m.as_str());
            let dedup_key = msg_id
                .map(|s| s.to_string())
                .or_else(|| {
                    value
                        .get("uuid")
                        .and_then(|u| u.as_str())
                        .map(|s| s.to_string())
                });
            let already_counted = dedup_key
                .as_ref()
                .map(|k| !seen_message_ids.insert(k.clone()))
                .unwrap_or(false);
            if !already_counted {
                if let Some(usage) = value.get("message").and_then(|m| m.get("usage")) {
                    session.usage.input_tokens +=
                        usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                    session.usage.cache_creation_input_tokens += usage
                        .get("cache_creation_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    session.usage.cache_read_input_tokens += usage
                        .get("cache_read_input_tokens")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(0);
                    session.usage.output_tokens +=
                        usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                }
            }
        }

        // contagem de msgs
        if event_type == "user" || event_type == "assistant" {
            session.message_count += 1;
        }

        // título
        if event_type == "ai-title" {
            if let Some(t) = value.get("aiTitle").and_then(|t| t.as_str()) {
                session.title = Some(t.to_string());
            }
        }
    }

    if session.started_at == i64::MAX {
        session.started_at = 0;
    }

    Ok(session)
}

use std::fs;

pub fn claude_projects_root() -> std::path::PathBuf {
    dirs::home_dir()
        .map(|h| h.join(".claude").join("projects"))
        .unwrap_or_else(|| std::path::PathBuf::from("./.claude/projects"))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Scan completo: lê todas as pastas de projeto em ~/.claude/projects/, todos os JSONL,
/// agrega por project_path canônico (vindo do `cwd`).
pub fn snapshot() -> Vec<ClaudeProjectState> {
    let root = claude_projects_root();
    let Ok(project_dirs) = fs::read_dir(&root) else {
        return vec![];
    };

    use std::collections::HashMap;
    let mut by_path: HashMap<String, ClaudeProjectState> = HashMap::new();

    for entry in project_dirs.filter_map(|e| e.ok()) {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        let Ok(files) = fs::read_dir(&dir) else { continue };
        for file_entry in files.filter_map(|e| e.ok()) {
            let path = file_entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(session) = parse_session_file(&path) else { continue };
            if session.project_path.is_empty() {
                continue;  // sessão órfã sem cwd, ignora
            }
            let state = by_path
                .entry(session.project_path.clone())
                .or_insert_with(|| ClaudeProjectState {
                    project_path: session.project_path.clone(),
                    sessions: Vec::new(),
                    active_session_id: None,
                    total_usage: AggregatedUsage::default(),
                });
            state.total_usage.add(&session.usage);
            state.sessions.push(session);
        }
    }

    let now = now_ms();
    let mut out: Vec<ClaudeProjectState> = by_path.into_values().collect();
    for state in &mut out {
        state.sessions.sort_by(|a, b| b.last_activity.cmp(&a.last_activity));
        state.active_session_id = state
            .sessions
            .iter()
            .find(|s| is_active(s.last_activity, now))
            .map(|s| s.session_id.clone());
    }
    out.sort_by(|a, b| a.project_path.cmp(&b.project_path));
    out
}

fn truncate_to_bucket(ts_ms: i64, granularity: Granularity) -> i64 {
    let dt = Utc.timestamp_millis_opt(ts_ms).single().unwrap_or(Utc.timestamp_opt(0, 0).unwrap());
    let truncated = match granularity {
        Granularity::Day => dt
            .with_hour(0).unwrap()
            .with_minute(0).unwrap()
            .with_second(0).unwrap()
            .with_nanosecond(0).unwrap(),
        Granularity::Month => dt
            .with_day(1).unwrap()
            .with_hour(0).unwrap()
            .with_minute(0).unwrap()
            .with_second(0).unwrap()
            .with_nanosecond(0).unwrap(),
        Granularity::Year => dt
            .with_month(1).unwrap()
            .with_day(1).unwrap()
            .with_hour(0).unwrap()
            .with_minute(0).unwrap()
            .with_second(0).unwrap()
            .with_nanosecond(0).unwrap(),
    };
    truncated.timestamp_millis()
}

pub fn aggregate_buckets(sessions: &[ClaudeSession], granularity: Granularity) -> Vec<TokenBucket> {
    use std::collections::BTreeMap;
    let mut by_bucket: BTreeMap<i64, AggregatedUsage> = BTreeMap::new();
    for s in sessions {
        let bucket = truncate_to_bucket(s.last_activity, granularity);
        by_bucket
            .entry(bucket)
            .or_default()
            .add(&s.usage);
    }
    by_bucket
        .into_iter()
        .map(|(bucket_start, usage)| TokenBucket { bucket_start, usage })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aggregated_usage_total_tokens() {
        let u = AggregatedUsage {
            input_tokens: 10,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
            output_tokens: 1,
        };
        assert_eq!(u.total_tokens(), 1111);
    }

    #[test]
    fn aggregated_usage_add() {
        let mut a = AggregatedUsage {
            input_tokens: 10,
            ..Default::default()
        };
        let b = AggregatedUsage {
            input_tokens: 5,
            output_tokens: 3,
            ..Default::default()
        };
        a.add(&b);
        assert_eq!(a.input_tokens, 15);
        assert_eq!(a.output_tokens, 3);
    }

    #[test]
    fn is_active_within_window() {
        let now = 1_700_000_000_000;
        assert!(is_active(now - 4 * 60 * 1000, now));
    }

    #[test]
    fn is_active_outside_window() {
        let now = 1_700_000_000_000;
        assert!(!is_active(now - 6 * 60 * 1000, now));
    }

    #[test]
    fn cost_opus_pure_input() {
        let usage = AggregatedUsage {
            input_tokens: 1_000_000,
            ..Default::default()
        };
        let cost = cost_usd(&usage, pricing_for("claude-opus-4-7"));
        assert!((cost - 15.00).abs() < 0.0001, "got {}", cost);
    }

    #[test]
    fn cost_opus_mixed() {
        // 100k input, 200k cache_create, 500k cache_read, 50k output
        // = 0.1 * 15 + 0.2 * 18.75 + 0.5 * 1.50 + 0.05 * 75
        // = 1.5 + 3.75 + 0.75 + 3.75 = 9.75
        let usage = AggregatedUsage {
            input_tokens: 100_000,
            cache_creation_input_tokens: 200_000,
            cache_read_input_tokens: 500_000,
            output_tokens: 50_000,
        };
        let cost = cost_usd(&usage, pricing_for("claude-opus-4-7"));
        assert!((cost - 9.75).abs() < 0.0001, "got {}", cost);
    }

    use std::path::Path;

    fn fixture_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/sample_session.jsonl")
    }

    #[test]
    fn parse_real_session_has_basic_fields() {
        let path = fixture_path();
        let session = parse_session_file(&path).expect("parser must succeed");
        assert!(!session.session_id.is_empty(), "session_id deve ser parseado do nome do arquivo");
        assert!(session.message_count > 0);
        assert!(session.usage.total_tokens() > 0, "fixture deve ter pelo menos 1 evento assistant com usage");
        assert!(session.last_activity > session.started_at);
        assert!(!session.project_path.is_empty(), "cwd deve estar populado");
    }

    fn make_session(last_activity_iso: &str, input: u64) -> ClaudeSession {
        let ts = parse_iso_to_unix_ms(last_activity_iso).unwrap();
        ClaudeSession {
            session_id: "x".into(),
            project_path: "/p".into(),
            git_branch: None,
            title: None,
            model: None,
            started_at: ts,
            last_activity: ts,
            message_count: 1,
            duration_ms: 0,
            usage: AggregatedUsage {
                input_tokens: input,
                ..Default::default()
            },
        }
    }

    #[test]
    fn aggregate_day_buckets_by_calendar_day() {
        let sessions = vec![
            make_session("2026-05-01T10:00:00Z", 100),
            make_session("2026-05-01T22:00:00Z", 200),
            make_session("2026-05-02T05:00:00Z", 50),
        ];
        let buckets = aggregate_buckets(&sessions, Granularity::Day);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].usage.input_tokens, 300);  // 01/05
        assert_eq!(buckets[1].usage.input_tokens, 50);   // 02/05
    }

    #[test]
    fn aggregate_month_buckets() {
        let sessions = vec![
            make_session("2026-04-15T10:00:00Z", 100),
            make_session("2026-05-01T10:00:00Z", 200),
            make_session("2026-05-30T10:00:00Z", 300),
        ];
        let buckets = aggregate_buckets(&sessions, Granularity::Month);
        assert_eq!(buckets.len(), 2);
        assert_eq!(buckets[0].usage.input_tokens, 100);  // abril
        assert_eq!(buckets[1].usage.input_tokens, 500);  // maio
    }

    #[test]
    fn aggregate_year_buckets() {
        let sessions = vec![
            make_session("2025-12-31T10:00:00Z", 100),
            make_session("2026-01-01T10:00:00Z", 200),
        ];
        let buckets = aggregate_buckets(&sessions, Granularity::Year);
        assert_eq!(buckets.len(), 2);
    }

    #[test]
    fn aggregate_empty_returns_empty() {
        let buckets = aggregate_buckets(&[], Granularity::Day);
        assert!(buckets.is_empty());
    }

    #[test]
    #[ignore]  // só roda manualmente — depende de ~/.claude/projects/ existir
    fn snapshot_real_dir_returns_data() {
        let states = snapshot();
        assert!(!states.is_empty(), "esperava ao menos 1 projeto com sessões");
        for state in &states {
            assert!(!state.project_path.is_empty());
            for session in &state.sessions {
                assert!(!session.session_id.is_empty());
            }
        }
    }

    #[test]
    fn parse_real_session_extracts_title() {
        let session = parse_session_file(&fixture_path()).unwrap();
        // Sessão real tem ai-title — pode ser None só se a sessão for muito curta
        // Se for None, é falha do fixture, não do parser
        assert!(session.title.is_some(), "fixture deve conter pelo menos um evento ai-title");
    }

    #[test]
    fn cost_unknown_model_falls_back_to_sonnet() {
        let usage = AggregatedUsage {
            input_tokens: 1_000_000,
            ..Default::default()
        };
        let cost = cost_usd(&usage, pricing_for("claude-future-99"));
        // Sonnet input = 3.00
        assert!((cost - 3.00).abs() < 0.0001, "got {}", cost);
    }
}
