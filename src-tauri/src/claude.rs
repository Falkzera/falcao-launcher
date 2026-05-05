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
