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
}
