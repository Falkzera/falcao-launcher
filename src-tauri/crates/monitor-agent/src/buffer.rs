//! Buffer in-memory pra resiliência quando DB cai.

use monitor_shared::MetricRow;
use std::collections::VecDeque;

const MAX_BUFFER: usize = 50_000; // ~1h de samples a 15s × 30 métricas

pub struct Buffer {
    rows: VecDeque<MetricRow>,
    dropped: u64,
}

impl Default for Buffer {
    fn default() -> Self {
        Self {
            rows: VecDeque::with_capacity(MAX_BUFFER),
            dropped: 0,
        }
    }
}

impl Buffer {
    pub fn push_batch(&mut self, batch: Vec<MetricRow>) {
        for row in batch {
            if self.rows.len() >= MAX_BUFFER {
                self.rows.pop_front();
                self.dropped += 1;
            }
            self.rows.push_back(row);
        }
    }

    pub fn drain_all(&mut self) -> Vec<MetricRow> {
        self.rows.drain(..).collect()
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn dropped_count(&self) -> u64 {
        self.dropped
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use monitor_shared::MetricSource;

    fn sample() -> MetricRow {
        MetricRow {
            ts: Utc::now(),
            host: "h".into(),
            source: MetricSource::Vm,
            resource: None,
            metric: "x".into(),
            value: Some(1.0),
            labels: None,
        }
    }

    #[test]
    fn buffer_holds_and_drains() {
        let mut b = Buffer::default();
        b.push_batch(vec![sample(), sample(), sample()]);
        assert_eq!(b.len(), 3);
        let drained = b.drain_all();
        assert_eq!(drained.len(), 3);
        assert_eq!(b.len(), 0);
    }

    #[test]
    fn buffer_drops_oldest_on_overflow() {
        let mut b = Buffer::default();
        for _ in 0..MAX_BUFFER + 100 {
            b.push_batch(vec![sample()]);
        }
        assert_eq!(b.len(), MAX_BUFFER);
        assert_eq!(b.dropped_count(), 100);
    }
}
