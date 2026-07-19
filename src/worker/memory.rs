//! Run provenance. Every run records WHO was in the room (provider, channel,
//! user, role) — the input to the person-space boundary: tainted runs get
//! gated repos read-only, and the participant scan (worker/boundary.rs) keys
//! off these identifiers. Interaction memory itself lives in the worker's
//! store (`store/memory/`, docs/store.md), owned and organized by the worker;
//! the host's only machinery is recall — a bounded, advisory window into
//! that file compiled into each run's input ([memory] in org.toml).

use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

/// Recall bounds for the memory block ([memory] in org.toml, worker
/// overlays allowed). Recall is a convenience window, not an access
/// control: every run mounts the whole store anyway. Unknown keys in the
/// table are ignored.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MemoryPolicy {
    pub enabled: bool,
    pub recall_max_notes: usize,
    pub recall_char_budget: usize,
}

impl Default for MemoryPolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            recall_max_notes: 20,
            recall_char_budget: 6_000,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompiledMemoryPolicy {
    #[serde(default)]
    pub default: MemoryPolicy,
    #[serde(default)]
    pub workers: HashMap<String, MemoryPolicy>,
}

pub fn load_policy(worker: &str) -> MemoryPolicy {
    let compiled = crate::config::snapshot()
        .map(|c| c.memory.clone())
        .unwrap_or_default();
    compiled
        .workers
        .get(worker.strip_prefix("org/").unwrap_or(worker))
        .cloned()
        .unwrap_or(compiled.default)
}

/// The worker's active memory notes, rank order: pinned first, then newest.
/// Reads `store/memory/memory.jsonl` fresh on every call — a note written
/// mid-session is eligible next turn. The file is the worker's own (its runs
/// append and edit it directly); the host only reads.
pub fn recall_notes(worker: &str) -> Vec<Value> {
    let path = paths::worker_store_dir(paths::short_worker(worker))
        .join("memory")
        .join("memory.jsonl");
    let text = std::fs::read_to_string(path).unwrap_or_default();
    active_notes(&text)
}

/// Parse + filter + rank a memory.jsonl. A later record with the same id
/// supersedes an earlier one (the worker's own update convention); retired
/// notes (`forgotten`/`disabled` flags, or a `forget` op) drop out.
fn active_notes(text: &str) -> Vec<Value> {
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut notes: Vec<Option<Value>> = Vec::new();
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        match v.get("id").and_then(Value::as_str).map(String::from) {
            Some(id) => match by_id.get(&id) {
                Some(&slot) => notes[slot] = Some(v),
                None => {
                    by_id.insert(id, notes.len());
                    notes.push(Some(v));
                }
            },
            None => notes.push(Some(v)),
        }
    }
    let mut out: Vec<Value> = notes
        .into_iter()
        .flatten()
        .filter(|v| {
            v.get("op").and_then(Value::as_str) != Some("forget")
                && v.get("forgotten").and_then(Value::as_bool) != Some(true)
                && v.get("disabled").and_then(Value::as_bool) != Some(true)
                && v.get("note").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        })
        .collect();
    out.sort_by(|a, b| {
        let pinned = |v: &Value| v.get("pinned").and_then(Value::as_bool) == Some(true);
        let ts = |v: &Value| v.get("ts").and_then(Value::as_str).unwrap_or("").to_string();
        pinned(b).cmp(&pinned(a)).then(ts(b).cmp(&ts(a)))
    });
    out
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunContext {
    pub provider: String,
    pub channel_id: Option<String>,
    pub user_id: Option<String>,
    pub message_id: Option<String>,
    /// Slack thread the inbound message belongs to (its own ts, or the parent's).
    /// Carried so a reply lands back in the thread, not the channel top level.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_ts: Option<String>,
    pub role: String,
    pub is_dm: bool,
    /// The run's prompt embeds inbound third-party content (a relay task) —
    /// person-tainted even without channel/user identifiers.
    pub inbound: bool,
}

impl RunContext {
    /// Did interaction content or context enter this run? Tainted runs get
    /// gated repos read-only (docs/repos.md). One predicate, shared by
    /// provisioning and the push gate.
    pub fn tainted(&self) -> bool {
        self.channel_id.is_some() || self.user_id.is_some() || self.inbound
    }

    /// A deliberately-tainted context for when a run's real context can't be
    /// read. The participant scan then runs (fail closed) instead of being
    /// silently skipped, so an unreadable context file cannot disable the
    /// person-space boundary. `inbound` is the only field `tainted()` reads.
    pub fn tainted_unknown() -> Self {
        RunContext {
            inbound: true,
            ..Default::default()
        }
    }
}

fn run_context_path(run_id: &str) -> PathBuf {
    paths::run_dir(run_id).join("run-context.json")
}

/// The context file's pre-store name. Read-only fallback so runs recorded
/// before the rename keep their provenance.
fn legacy_run_context_path(run_id: &str) -> PathBuf {
    paths::run_dir(run_id).join("memory-context.json")
}

pub fn save_run_context(run_id: &str, context: &RunContext) -> Result<(), String> {
    if run_id.is_empty() {
        return Ok(());
    }
    let path = run_context_path(run_id);
    let dir = path.parent().ok_or("bad run context path")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        format!(
            "{}\n",
            serde_json::to_string_pretty(context).map_err(|e| e.to_string())?
        ),
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(tmp, path).map_err(|e| e.to_string())
}

pub fn load_run_context(run_id: &str) -> RunContext {
    if run_id.is_empty() {
        // No run identity to key a context on (host-op / CLI paths). This is a
        // legitimate absence, not a failure, and carries no interaction content.
        return RunContext::default();
    }
    let path = if run_context_path(run_id).exists() {
        run_context_path(run_id)
    } else {
        legacy_run_context_path(run_id)
    };
    match crate::statefile::read_if_present(&path) {
        Ok(Some(s)) => serde_json::from_str(&s).unwrap_or_else(|e| {
            eprintln!("run context for {run_id} is corrupt ({e}); treating run as tainted");
            RunContext::tainted_unknown()
        }),
        // A dispatched run always writes its context; a missing or unreadable
        // one means that write was lost. Fail closed so the participant scan
        // still runs, rather than silently disabling the boundary.
        Ok(None) => {
            eprintln!("no run context for {run_id}; treating run as tainted");
            RunContext::tainted_unknown()
        }
        Err(e) => {
            eprintln!("could not read run context for {run_id} ({e}); treating run as tainted");
            RunContext::tainted_unknown()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_context_roundtrips_and_fails_tainted() {
        let _guard = crate::statefile::TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("ROSTER_ROOT", dir.path());

        let ctx = RunContext {
            provider: "discord".into(),
            channel_id: Some("c1".into()),
            user_id: Some("u1".into()),
            role: "trusted".into(),
            ..Default::default()
        };
        save_run_context("r1", &ctx).unwrap();
        let loaded = load_run_context("r1");
        assert!(loaded.tainted());
        assert_eq!(loaded.channel_id.as_deref(), Some("c1"));

        // Missing context fails closed: tainted, not clean.
        assert!(load_run_context("r-missing").tainted());
        // The CLI/host-op path (no run id) is legitimately clean.
        assert!(!load_run_context("").tainted());
    }
}
