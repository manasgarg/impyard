//! Policy-gated publication into an immutable, content-addressed local blob
//! store. Source bytes are frozen into host-only staging before a gate is
//! filed, binding approval to the exact hash that will be published.

use crate::util::{now_rfc3339, root};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::thread;
use std::time::Duration;

const SCRATCH_MOUNT: &str = "/opt/roster/scratch";
const KNOWLEDGE_MOUNT: &str = "/opt/roster/knowledge";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Publication {
    pub publication_id: String,
    pub blob_id: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub logical_name: String,
    pub version: u64,
    pub visibility: String,
    pub uri: String,
    pub worker: String,
    pub run_id: String,
    pub created_at: String,
    pub source_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub knowledge_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub note_ids: Vec<String>,
}

struct Lease(PathBuf);

impl Drop for Lease {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn freeze(worker: &str, run_id: &str, payload: &Value) -> Result<Value, String> {
    let short_worker = worker.strip_prefix("org/").unwrap_or(worker);
    let run = crate::runlog::load(run_id).ok_or("publication has no active run record")?;
    if run.worker != short_worker || run.state != "running" {
        return Err("publication run identity is stale or does not match the worker".into());
    }
    let policy = crate::storage::load(short_worker).publishing;
    let logical_name = payload
        .get("logical_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| valid_logical_name(value))
        .ok_or("publication needs a logical_name using letters, numbers, '.', '_' or '-'")?;
    let media_type = payload
        .get("media_type")
        .and_then(Value::as_str)
        .map(media_type_essence)
        .filter(|value| !value.is_empty())
        .ok_or("publication needs a media_type")?;
    if !policy
        .allowed_media_types
        .iter()
        .any(|allowed| media_type_essence(allowed) == media_type)
    {
        return Err(format!(
            "publication media type {media_type} is not allowed"
        ));
    }
    let visibility = payload
        .get("visibility")
        .and_then(Value::as_str)
        .unwrap_or(&policy.default_visibility);
    if !matches!(visibility, "private" | "public") {
        return Err("publication visibility must be private or public".into());
    }
    let source_path = payload
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("publication needs a source path")?;
    let source = resolve_source(run_id, source_path)?;
    let metadata = fs::metadata(&source).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("publication source must be a regular file".into());
    }
    if metadata.len() > policy.max_blob_bytes {
        return Err(format!(
            "publication is {} bytes, over the {} byte limit",
            metadata.len(),
            policy.max_blob_bytes
        ));
    }
    let note_ids = parse_note_ids(payload)?;
    let staging_id = format!("stage_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let publication_id = format!("pub_{}", &uuid::Uuid::new_v4().simple().to_string()[..12]);
    let staging = staging_path(&staging_id)?;
    if let Some(parent) = staging.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let frozen = match freeze_file(&source, &staging, policy.max_blob_bytes) {
        Ok(value) => value,
        Err(error) => {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }
    };
    if let Err(error) = validate_content(&staging, &media_type) {
        let _ = fs::remove_file(&staging);
        return Err(error);
    }
    let knowledge_commit = run.knowledge.as_ref().and_then(|knowledge| {
        knowledge
            .produced_commit
            .clone()
            .or_else(|| Some(knowledge.base_commit.clone()))
    });
    let frozen_payload = json!({
        "frozen": true,
        "worker": short_worker,
        "run_id": run_id,
        "staging_id": staging_id,
        "publication_id": publication_id,
        "sha256": frozen.0,
        "bytes": frozen.1,
        "source_path": source_path,
        "logical_name": logical_name,
        "media_type": media_type,
        "visibility": visibility,
        "knowledge_commit": knowledge_commit,
        "note_ids": note_ids,
    });
    if let Err(error) =
        crate::journal::append_required(worker, run_id, "publish-proposed", frozen_payload.clone())
    {
        let _ = fs::remove_file(staging);
        return Err(error);
    }
    Ok(frozen_payload)
}

pub fn trust_level(worker: &str, payload: &Value, fallback: &str) -> Result<String, String> {
    validate_frozen_payload(payload)?;
    let visibility = payload
        .get("visibility")
        .and_then(Value::as_str)
        .ok_or("frozen publication has no visibility")?;
    let policy = crate::storage::load(worker).publishing;
    if visibility == "public" && policy.public_requires_gate {
        Ok("gate".into())
    } else {
        Ok(fallback.into())
    }
}

pub fn execute(worker: &str, run_id: &str, payload: &Value) -> Result<Value, String> {
    match execute_inner(worker, run_id, payload) {
        Ok(publication) => {
            Ok(serde_json::to_value(publication).map_err(|error| error.to_string())?)
        }
        Err(error) => {
            let _ = crate::journal::append_required(
                worker,
                run_id,
                "publish-failed",
                json!({
                    "publication_id": payload.get("publication_id"),
                    "error": error,
                }),
            );
            Err(error)
        }
    }
}

fn execute_inner(worker: &str, run_id: &str, payload: &Value) -> Result<Publication, String> {
    validate_frozen_payload(payload)?;
    let short_worker = worker.strip_prefix("org/").unwrap_or(worker);
    if required(payload, "worker")? != short_worker || required(payload, "run_id")? != run_id {
        return Err("frozen publication identity does not match its gate".into());
    }
    let staging_id = required(payload, "staging_id")?;
    let publication_id = required(payload, "publication_id")?;
    let expected_hash = required(payload, "sha256")?;
    let expected_bytes = payload
        .get("bytes")
        .and_then(Value::as_u64)
        .ok_or("frozen publication has no byte count")?;
    if let Some(existing) = find_publication(publication_id) {
        if existing.worker != short_worker
            || existing.run_id != run_id
            || existing.sha256 != expected_hash
            || existing.bytes != expected_bytes
        {
            return Err("publication ID is already bound to different bytes or provenance".into());
        }
        crate::journal::append_required(
            worker,
            run_id,
            "publish-completed",
            serde_json::to_value(&existing).map_err(|error| error.to_string())?,
        )?;
        let _ = crate::runlog::record_published_blob(run_id, &existing.blob_id);
        discard_staging(payload);
        return Ok(existing);
    }
    let staging = staging_path(staging_id)?;
    let (actual_hash, actual_bytes) = hash_file(&staging)?;
    if actual_hash != expected_hash || actual_bytes != expected_bytes {
        return Err("frozen publication bytes no longer match the reviewed hash".into());
    }

    let logical_name = required(payload, "logical_name")?;
    let _lease = acquire_lease(&blobs_root().join("publish.lock"))?;
    let object = object_path(expected_hash)?;
    if let Some(parent) = object.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    match fs::hard_link(&staging, &object) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let (stored_hash, stored_bytes) = hash_file(&object)?;
            if stored_hash != expected_hash || stored_bytes != expected_bytes {
                return Err("content-addressed blob object is corrupt".into());
            }
        }
        Err(error) => return Err(format!("could not store blob object: {error}")),
    }
    let directory = publication_dir(short_worker, logical_name)?;
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let version = next_version(&directory);
    let blob_id = format!("blob_{expected_hash}");
    let publication = Publication {
        publication_id: publication_id.into(),
        blob_id: blob_id.clone(),
        sha256: expected_hash.into(),
        bytes: expected_bytes,
        media_type: required(payload, "media_type")?.into(),
        logical_name: logical_name.into(),
        version,
        visibility: required(payload, "visibility")?.into(),
        uri: format!("roster-blob://{blob_id}"),
        worker: short_worker.into(),
        run_id: run_id.into(),
        created_at: now_rfc3339(),
        source_path: required(payload, "source_path")?.into(),
        knowledge_commit: payload
            .get("knowledge_commit")
            .and_then(Value::as_str)
            .map(String::from),
        note_ids: payload
            .get("note_ids")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(String::from)
            .collect(),
    };
    let metadata_path = directory.join(format!("{version:020}-{publication_id}.json"));
    write_json_atomic(&metadata_path, &publication)?;
    crate::journal::append_required(
        worker,
        run_id,
        "publish-completed",
        serde_json::to_value(&publication).map_err(|error| error.to_string())?,
    )?;
    let _ = crate::runlog::record_published_blob(run_id, &blob_id);
    discard_staging(payload);
    Ok(publication)
}

pub fn discard_staging(payload: &Value) {
    if let Some(staging_id) = payload.get("staging_id").and_then(Value::as_str) {
        if let Ok(path) = staging_path(staging_id) {
            let _ = fs::remove_file(path);
        }
    }
}

pub fn list(worker: Option<&str>) -> Vec<Publication> {
    let mut paths = Vec::new();
    collect_json(&blobs_root().join("publications"), &mut paths);
    let mut values: Vec<Publication> = paths
        .into_iter()
        .filter_map(|path| fs::read_to_string(path).ok())
        .filter_map(|text| serde_json::from_str::<Publication>(&text).ok())
        .filter(|publication| {
            worker
                .map(|value| publication.worker == value)
                .unwrap_or(true)
        })
        .collect();
    values.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    values
}

pub fn find(value: &str) -> Vec<Publication> {
    list(None)
        .into_iter()
        .filter(|publication| publication.publication_id == value || publication.blob_id == value)
        .collect()
}

pub fn blob_path(blob_id: &str) -> Result<PathBuf, String> {
    let hash = blob_id
        .strip_prefix("blob_")
        .filter(|value| valid_hash(value))
        .ok_or("invalid blob ID")?;
    let path = object_path(hash)?;
    if !path.is_file() {
        return Err(format!("no such blob {blob_id}"));
    }
    Ok(path)
}

fn validate_frozen_payload(payload: &Value) -> Result<(), String> {
    if payload.get("frozen").and_then(Value::as_bool) != Some(true) {
        return Err("publication payload was not frozen by the trusted host".into());
    }
    let staging_id = required(payload, "staging_id")?;
    if !staging_id.starts_with("stage_") || !safe_id(staging_id) {
        return Err("invalid publication staging ID".into());
    }
    let publication_id = required(payload, "publication_id")?;
    if !publication_id.starts_with("pub_") || !safe_id(publication_id) {
        return Err("invalid publication ID".into());
    }
    let hash = required(payload, "sha256")?;
    if !valid_hash(hash) {
        return Err("invalid frozen publication hash".into());
    }
    Ok(())
}

fn resolve_source(run_id: &str, source: &str) -> Result<PathBuf, String> {
    let (mount, relative) = if let Some(value) = source.strip_prefix(&format!("{SCRATCH_MOUNT}/")) {
        ("scratch", value)
    } else if let Some(value) = source.strip_prefix(&format!("{KNOWLEDGE_MOUNT}/")) {
        ("knowledge", value)
    } else {
        return Err(format!(
            "publication source must be under {SCRATCH_MOUNT} or {KNOWLEDGE_MOUNT}"
        ));
    };
    let relative = safe_relative(relative)?;
    let base = root().join("runs").join(run_id).join(mount);
    let base = fs::canonicalize(base).map_err(|error| error.to_string())?;
    let candidate = base.join(relative);
    reject_symlink_components(&base, &candidate)?;
    let resolved = fs::canonicalize(candidate).map_err(|error| error.to_string())?;
    if !resolved.starts_with(&base) {
        return Err("publication source escapes its authorized run mount".into());
    }
    Ok(resolved)
}

fn freeze_file(source: &Path, destination: &Path, max_bytes: u64) -> Result<(String, u64), String> {
    let mut input = fs::File::open(source).map_err(|error| error.to_string())?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut scanner = SecretScanner::default();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or("publication size overflow")?;
        if total > max_bytes {
            let _ = fs::remove_file(destination);
            return Err(format!("publication exceeds the {max_bytes} byte limit"));
        }
        hasher.update(&buffer[..count]);
        if scanner.contains_secret(&buffer[..count]) {
            let _ = fs::remove_file(destination);
            return Err("publication appears to contain a secret or credential".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
    }
    output.sync_all().map_err(|error| error.to_string())?;
    Ok((format!("{:x}", hasher.finalize()), total))
}

#[derive(Default)]
struct SecretScanner {
    tail: Vec<u8>,
}

impl SecretScanner {
    fn contains_secret(&mut self, chunk: &[u8]) -> bool {
        const NEEDLES: &[&[u8]] = &[
            b"-----begin private key",
            b"authorization: bearer",
            b"password:",
            b"api_key:",
            b"api key is ",
            b"access token:",
            b"ghp_",
            b"xoxb-",
        ];
        let mut value = self.tail.clone();
        value.extend(chunk.iter().map(u8::to_ascii_lowercase));
        let found = NEEDLES
            .iter()
            .any(|needle| value.windows(needle.len()).any(|window| window == *needle));
        let keep = NEEDLES.iter().map(|needle| needle.len()).max().unwrap_or(1) - 1;
        self.tail = value[value.len().saturating_sub(keep)..].to_vec();
        found
    }
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        total += count as u64;
        hasher.update(&buffer[..count]);
    }
    Ok((format!("{:x}", hasher.finalize()), total))
}

fn validate_content(path: &Path, media_type: &str) -> Result<(), String> {
    match media_type {
        "text/markdown" | "text/html" => {
            let bytes = fs::read(path).map_err(|error| error.to_string())?;
            std::str::from_utf8(&bytes)
                .map_err(|_| format!("{media_type} publication must contain UTF-8 text"))?;
        }
        "application/pdf" => {
            let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
            let mut magic = [0u8; 5];
            file.read_exact(&mut magic)
                .map_err(|_| "PDF publication is too short")?;
            if &magic != b"%PDF-" {
                return Err("application/pdf publication does not have a PDF header".into());
            }
        }
        _ => {}
    }
    Ok(())
}

fn parse_note_ids(payload: &Value) -> Result<Vec<String>, String> {
    let values = payload
        .get("note_ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if values.len() > 100 {
        return Err("publication may cite at most 100 note IDs".into());
    }
    values
        .into_iter()
        .map(|value| {
            value
                .as_str()
                .filter(|value| safe_id(value))
                .map(String::from)
                .ok_or_else(|| "publication note IDs must be safe strings".to_string())
        })
        .collect()
}

fn required<'a>(payload: &'a Value, field: &str) -> Result<&'a str, String> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("frozen publication has no {field}"))
}

fn staging_path(staging_id: &str) -> Result<PathBuf, String> {
    if !staging_id.starts_with("stage_") || !safe_id(staging_id) {
        return Err("invalid publication staging ID".into());
    }
    Ok(blobs_root()
        .join("staging")
        .join(format!("{staging_id}.bin")))
}

fn object_path(hash: &str) -> Result<PathBuf, String> {
    if !valid_hash(hash) {
        return Err("invalid blob hash".into());
    }
    Ok(blobs_root().join("objects").join(&hash[..2]).join(hash))
}

fn publication_dir(worker: &str, logical_name: &str) -> Result<PathBuf, String> {
    if !safe_id(worker) || !valid_logical_name(logical_name) {
        return Err("invalid publication worker or logical name".into());
    }
    Ok(blobs_root()
        .join("publications")
        .join(worker)
        .join(logical_name))
}

fn blobs_root() -> PathBuf {
    root().join("blobs")
}

fn next_version(directory: &Path) -> u64 {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .split('-')
                .next()
                .and_then(|value| value.parse::<u64>().ok())
        })
        .max()
        .unwrap_or(0)
        + 1
}

fn find_publication(id: &str) -> Option<Publication> {
    find(id)
        .into_iter()
        .find(|publication| publication.publication_id == id)
}

fn collect_json(directory: &Path, output: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_json(&path, output);
        } else if path.extension().and_then(|value| value.to_str()) == Some("json") {
            output.push(path);
        }
    }
}

fn write_json_atomic(path: &Path, publication: &Publication) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let text = format!(
            "{}\n",
            serde_json::to_string_pretty(publication).map_err(|error| error.to_string())?
        );
        file.write_all(text.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        fs::hard_link(&temporary, path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                "publication metadata already exists; refusing to overwrite it".to_string()
            } else {
                error.to_string()
            }
        })?;
        Ok(())
    })();
    let _ = fs::remove_file(temporary);
    result
}

fn acquire_lease(path: &Path) -> Result<Lease, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    for _ in 0..250 {
        match fs::create_dir(path) {
            Ok(()) => return Ok(Lease(path.into())),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("timed out waiting for publication lane".into())
}

fn safe_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.is_absolute() || path.components().count() == 0 {
        return Err("publication path must be relative inside its mount".into());
    }
    for component in path.components() {
        let Component::Normal(name) = component else {
            return Err("publication path cannot contain . or ..".into());
        };
        let name = name.to_str().ok_or("publication path must be UTF-8")?;
        if name.is_empty() || name.starts_with('.') {
            return Err("publication path cannot contain hidden components".into());
        }
    }
    Ok(path.into())
}

fn reject_symlink_components(base: &Path, candidate: &Path) -> Result<(), String> {
    let relative = candidate
        .strip_prefix(base)
        .map_err(|_| "publication path escapes its mount")?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err("unsafe publication path".into());
        };
        current.push(name);
        let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("publication source cannot traverse a symlink".into());
        }
    }
    Ok(())
}

fn media_type_essence(value: &str) -> String {
    value
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn valid_logical_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_types_and_paths_are_normalized() {
        assert_eq!(
            media_type_essence("Text/Markdown; charset=utf-8"),
            "text/markdown"
        );
        assert!(valid_logical_name("vendor-sso-report.v2"));
        assert!(!valid_logical_name("../report"));
        assert!(safe_relative("reports/final.pdf").is_ok());
        assert!(safe_relative("../final.pdf").is_err());
    }

    #[test]
    fn secret_scanner_finds_values_split_across_chunks() {
        let mut scanner = SecretScanner::default();
        assert!(!scanner.contains_secret(b"Authorization: Bea"));
        assert!(scanner.contains_secret(b"rer secret"));
    }

    #[test]
    fn content_hash_is_stable() {
        let dir = std::env::temp_dir().join(format!("roster-publish-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source");
        let frozen = dir.join("frozen");
        fs::write(&source, b"abc").unwrap();
        let result = freeze_file(&source, &frozen, 3).unwrap();
        assert_eq!(result.1, 3);
        assert_eq!(
            result.0,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(fs::read(frozen).unwrap(), b"abc");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn declared_pdf_requires_pdf_bytes() {
        let dir = std::env::temp_dir().join(format!("roster-pdf-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("document");
        fs::write(&path, b"not a pdf").unwrap();
        assert!(validate_content(&path, "application/pdf").is_err());
        fs::write(&path, b"%PDF-1.7\n").unwrap();
        assert!(validate_content(&path, "application/pdf").is_ok());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn publication_metadata_cannot_be_overwritten() {
        let dir = std::env::temp_dir().join(format!("roster-metadata-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("publication.json");
        let publication = Publication {
            publication_id: "pub_test".into(),
            blob_id: format!("blob_{}", "a".repeat(64)),
            sha256: "a".repeat(64),
            bytes: 3,
            media_type: "text/markdown".into(),
            logical_name: "test".into(),
            version: 1,
            visibility: "private".into(),
            uri: format!("roster-blob://blob_{}", "a".repeat(64)),
            worker: "yuko".into(),
            run_id: "run_test".into(),
            created_at: "2026-07-11T12:30:00Z".into(),
            source_path: "/opt/roster/scratch/test.md".into(),
            knowledge_commit: None,
            note_ids: Vec::new(),
        };
        write_json_atomic(&path, &publication).unwrap();
        let mut replacement = publication.clone();
        replacement.version = 2;
        assert!(write_json_atomic(&path, &replacement).is_err());
        let stored: Publication = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored.version, 1);
        let _ = fs::remove_dir_all(dir);
    }
}
