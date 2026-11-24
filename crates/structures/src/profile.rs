//! Opt-in calling-thread wall-time attribution for experiments. Normal builds erase spans.
use std::collections::BTreeMap;

#[derive(Default, serde::Serialize)]
pub struct Timing {
    pub calls: u64,
    pub inclusive_ms: f64,
    pub exclusive_ms: f64,
}
pub type Report = BTreeMap<&'static str, Timing>;
pub const ENABLED: bool = cfg!(feature = "profile");

#[cfg(feature = "profile")]
mod enabled {
    use super::*;
    use std::{cell::RefCell, time::Instant};
    #[derive(Default)]
    struct Recorder {
        stack: Vec<Frame>,
        report: Report,
    }
    struct Frame {
        name: &'static str,
        start: Instant,
        children_ms: f64,
    }
    thread_local! {
        static RECORDER: RefCell<Option<Recorder>> = const { RefCell::new(None) };
    }
    pub fn start() {
        RECORDER.with(|r| *r.borrow_mut() = Some(Recorder::default()));
    }
    pub fn finish() -> Report {
        RECORDER.with(|r| {
            let recorder = r.borrow_mut().take().unwrap_or_default();
            assert!(recorder.stack.is_empty(), "unfinished profiling span");
            recorder.report
        })
    }
    pub struct Span(bool);
    pub fn span(name: &'static str) -> Span {
        Span(RECORDER.with(|r| {
            let mut r = r.borrow_mut();
            let Some(r) = r.as_mut() else { return false };
            r.stack.push(Frame {
                name,
                start: Instant::now(),
                children_ms: 0.,
            });
            true
        }))
    }
    impl Drop for Span {
        fn drop(&mut self) {
            if !self.0 {
                return;
            }
            RECORDER.with(|r| {
                let mut r = r.borrow_mut();
                let r = r
                    .as_mut()
                    .expect("profiling recorder removed inside a span");
                let frame = r.stack.pop().unwrap();
                let elapsed = frame.start.elapsed().as_secs_f64() * 1000.;
                if let Some(parent) = r.stack.last_mut() {
                    parent.children_ms += elapsed;
                }
                let t = r.report.entry(frame.name).or_default();
                t.calls += 1;
                t.inclusive_ms += elapsed;
                t.exclusive_ms += (elapsed - frame.children_ms).max(0.);
            });
        }
    }
}
#[cfg(feature = "profile")]
pub use enabled::{Span, finish, span, start};
#[cfg(not(feature = "profile"))]
pub struct Span;
#[cfg(not(feature = "profile"))]
#[inline(always)]
pub fn span(_: &'static str) -> Span {
    Span
}
#[cfg(not(feature = "profile"))]
pub fn start() {}
#[cfg(not(feature = "profile"))]
pub fn finish() -> Report {
    Report::new()
}

#[cfg(all(test, feature = "profile"))]
mod tests {
    use super::*;
    #[test]
    fn exclusive_times_partition_the_outer_span_even_with_repeated_names() {
        start();
        {
            let _outer = span("outer");
            for _ in 0..3 {
                let _child = span("child");
                let _nested = span("child");
                std::hint::black_box(vec![7u8; 1024]);
            }
        }
        let report = finish();
        assert_eq!(report["outer"].calls, 1);
        assert_eq!(report["child"].calls, 6);
        let sum = report.values().map(|r| r.exclusive_ms).sum::<f64>();
        assert!((sum - report["outer"].inclusive_ms).abs() < 0.000001);
        assert!(finish().is_empty());
    }
}
