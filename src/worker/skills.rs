//! Seeded, host-canonical skills for a worker — how-to guides in the Agent
//! Skills format, read by the box at `$HOME/skills`
//! (docs/plans/prompt-architecture.md, docs/plans/persistence-architecture.md).
//!
//! This is the read side. The host owns a bare canonical per worker, seeds
//! it once from the embedded SKILL.md files, and materializes a read-only
//! checkout of `main` into each run. pi implements the Agent Skills format
//! natively; box/extensions/skills.ts points it at the mount and the index
//! lands in the system prompt, bodies loading on demand. Landing worker
//! edits (skill_push) is a later stage — until then the canonical changes
//! only host-side, and `git log main` is the history.

use crate::paths;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Where the box sees the checkout, read-only, in every run kind.
pub const SKILLS_MOUNT: &str = "/pihome/skills";

/// The seeded skills, embedded at build time: (directory name, SKILL.md).
/// Frontmatter `name:` must match the directory — pi's discovery keys on it.
const SEEDS: &[(&str, &str)] = &[
    (
        "meta-skill",
        include_str!("skills_seed/meta-skill/SKILL.md"),
    ),
    ("schedule", include_str!("skills_seed/schedule/SKILL.md")),
    (
        "dev-workflow",
        include_str!("skills_seed/dev-workflow/SKILL.md"),
    ),
    (
        "research-workflow",
        include_str!("skills_seed/research-workflow/SKILL.md"),
    ),
    (
        "self-improvement-workflow",
        include_str!("skills_seed/self-improvement-workflow/SKILL.md"),
    ),
];

const SEED_README: &str = "# Skills\n\nHow-to guides for this worker, one directory per skill \
                           (SKILL.md inside). The canonical repository is host-owned; the box \
                           mounts a read-only checkout and `git log main` is the history. See \
                           the meta-skill for the format and how changes are proposed.\n";

/// Ensure the canonical exists (seeding it on first call), then materialize
/// a checkout of `main` for this run and return its path. The checkout lands
/// in the run dir and mounts read-only; failures here should degrade the run
/// (no skills), not kill it — the caller decides.
pub fn provision(worker: &str, run_id: &str) -> Result<PathBuf, String> {
    let repo = ensure_repo(worker)?;
    let destination = paths::run_dir(run_id).join("skills");
    materialize(&repo, &destination)?;
    Ok(destination)
}

fn ensure_repo(worker: &str) -> Result<PathBuf, String> {
    let dir = paths::worker_skills_dir(worker);
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let repo = dir.join("repo.git");
    let _lease = acquire_lease(&lane_lock_path(&repo))?;
    if repo.join("refs/heads/main").exists() || head_of(&repo).is_ok() {
        return Ok(repo);
    }
    if repo.exists() {
        return Err(format!(
            "skills repository exists without main: {}",
            repo.display()
        ));
    }
    seed_repo(&dir, &repo)?;
    Ok(repo)
}

/// Init a bare canonical at `repo` and push the seed commit from a temp
/// clone under `parent`. Split from `ensure_repo` so tests drive it with
/// explicit paths.
fn seed_repo(parent: &Path, repo: &Path) -> Result<(), String> {
    run_git(
        Path::new("."),
        &[
            "init",
            "--bare",
            "--initial-branch=main",
            &repo.display().to_string(),
        ],
    )?;
    // Same reasoning as the knowledge canonical: concurrent box reads vs
    // auto-gc repacks don't mix.
    git_dir(repo, &["config", "gc.auto", "0"])?;
    let seed = TempTree::new(parent, "seed")?;
    let tree = seed.path.join("tree");
    run_git(
        Path::new("."),
        &[
            "clone",
            "--quiet",
            &repo.display().to_string(),
            &tree.display().to_string(),
        ],
    )?;
    fs::write(tree.join("README.md"), SEED_README).map_err(|error| error.to_string())?;
    for (name, content) in SEEDS {
        let dir = tree.join(name);
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        fs::write(dir.join("SKILL.md"), content).map_err(|error| error.to_string())?;
    }
    run_git(&tree, &["config", "user.name", "Roster Skills"])?;
    run_git(&tree, &["config", "user.email", "skills@roster.local"])?;
    run_git(&tree, &["add", "--all"])?;
    run_git(&tree, &["commit", "-q", "-m", "Seed worker skills"])?;
    run_git(&tree, &["push", "--quiet", "origin", "main"])?;
    Ok(())
}

/// A plain clone of the canonical at `main` — the run's read-only view.
/// `.git` rides along deliberately: the history is the worker's to read.
fn materialize(repo: &Path, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    run_git(
        Path::new("."),
        &[
            "clone",
            "--quiet",
            &repo.display().to_string(),
            &destination.display().to_string(),
        ],
    )
    .map(|_| ())
}

struct Lease {
    _lock: crate::statefile::FileLock,
}

/// Host-side serialization for canonical setup — same shape as the
/// knowledge repo's integration lane, keyed by the bare path.
fn lane_lock_path(bare: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(bare.display().to_string().as_bytes());
    let digest = format!("{:x}", h.finalize());
    paths::lock_file(&format!("skills-lane-{}", &digest[..16]))
}

fn acquire_lease(path: &Path) -> Result<Lease, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    // Bounded wait (~5s) on a lock the OS frees on crash.
    for _ in 0..250 {
        match crate::statefile::FileLock::try_acquire_path(path) {
            Ok(Some(lock)) => return Ok(Lease { _lock: lock }),
            Ok(None) => thread::sleep(Duration::from_millis(20)),
            Err(error) => return Err(error.to_string()),
        }
    }
    Err(format!(
        "timed out waiting for skills lane at {}",
        path.display()
    ))
}

fn head_of(repo: &Path) -> Result<String, String> {
    git_dir(repo, &["rev-parse", "refs/heads/main"])
}

fn git_dir(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut owned: Vec<String> = vec![format!("--git-dir={}", repo.display())];
    owned.extend(args.iter().map(|value| (*value).to_string()));
    run_git_owned(Path::new("."), owned)
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    run_git_owned(cwd, args.iter().map(|value| (*value).to_string()).collect())
}

fn run_git_owned(cwd: &Path, args: Vec<String>) -> Result<String, String> {
    let output = Command::new("git")
        .current_dir(cwd)
        .args(&args)
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {detail}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

struct TempTree {
    path: PathBuf,
}

impl TempTree {
    fn new(parent: &Path, label: &str) -> Result<Self, String> {
        let path = parent.join(format!(
            ".tmp-{label}-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        fs::create_dir_all(&path).map_err(|error| error.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for TempTree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_seed_has_wellformed_frontmatter() {
        for (name, content) in SEEDS {
            let mut lines = content.lines();
            assert_eq!(lines.next(), Some("---"), "{name}: missing frontmatter");
            let frontmatter: Vec<&str> = lines.by_ref().take_while(|l| *l != "---").collect();
            let name_line = frontmatter
                .iter()
                .find(|l| l.starts_with("name:"))
                .unwrap_or_else(|| panic!("{name}: no name in frontmatter"));
            assert_eq!(
                name_line.trim_start_matches("name:").trim(),
                *name,
                "{name}: frontmatter name must match directory"
            );
            let description = frontmatter
                .iter()
                .find(|l| l.starts_with("description:"))
                .unwrap_or_else(|| panic!("{name}: no description in frontmatter"));
            assert!(
                description.len() > "description: ".len() + 20,
                "{name}: description too short to route on"
            );
        }
    }

    #[test]
    fn seed_then_materialize_yields_all_skills() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo.git");
        seed_repo(dir.path(), &repo).unwrap();

        let checkout = dir.path().join("checkout");
        materialize(&repo, &checkout).unwrap();
        assert!(checkout.join("README.md").is_file());
        for (name, content) in SEEDS {
            let on_disk = fs::read_to_string(checkout.join(name).join("SKILL.md")).unwrap();
            assert_eq!(&on_disk, content, "{name}: checkout must match seed");
        }

        // Materializing again over an existing checkout replaces it cleanly.
        materialize(&repo, &checkout).unwrap();
        assert!(checkout.join("meta-skill/SKILL.md").is_file());

        // One seed commit on main.
        let count = git_dir(&repo, &["rev-list", "--count", "refs/heads/main"]).unwrap();
        assert_eq!(count, "1");
    }

    #[test]
    fn seeding_twice_is_refused_by_ensure_shape() {
        // ensure_repo's "exists without main" guard is path-machinery bound;
        // what we can check here is that seed_repo refuses a second run on
        // the same path (git init --bare over an existing repo succeeds, but
        // the clone-and-push path must not create a second root commit).
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo.git");
        seed_repo(dir.path(), &repo).unwrap();
        let error = seed_repo(dir.path(), &repo).unwrap_err();
        assert!(error.contains("failed"), "{error}");
        let count = git_dir(&repo, &["rev-list", "--count", "refs/heads/main"]).unwrap();
        assert_eq!(count, "1", "second seed must not add commits");
    }
}
