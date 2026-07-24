//! Seeded, host-canonical skills for a worker — how-to guides in the Agent
//! Skills format, read by the box at `$HOME/skills`
//! (docs/plans/prompt-architecture.md, docs/plans/persistence-architecture.md).
//!
//! The host owns a bare canonical per worker, seeds it once from the
//! embedded SKILL.md files, and gives every run a writable clone on a
//! run-named branch, mounted at `$HOME/skills`. pi implements the Agent
//! Skills format natively; box/extensions/skills.ts points it at the mount
//! and the index lands in the system prompt, bodies loading on demand.
//!
//! Writes land through `skill_push` — the GOVERNED rwf style
//! (persistence-architecture.md) with skills' own access rule: submissions
//! are accepted from EVERY run kind, because skills are the worker's own
//! truth. What the engine still guarantees: validation before apply
//! (regular text files, size caps, well-formed frontmatter — a skill that
//! would silently drop out of pi's index is refused at the door),
//! serialized fast-forward-only landings, and a journaled, attested
//! `git log main`.

use crate::paths;
use serde_json::json;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;

/// Where the box sees the run's writable clone, in every run kind.
pub const SKILLS_MOUNT: &str = "/pihome/skills";
/// The canonical, mounted read-only as the clone's `origin` — live and
/// fetchable after a stale push; a ref write from the box is a filesystem
/// error.
pub const SKILLS_ORIGIN_MOUNT: &str = "/pihome/.skills-origin.git";
/// Where the box's push tool writes the bundle: inside the clone's own
/// .git, so the worktree stays clean. The host derives this path from the
/// run id — never from box-supplied input.
const PUSH_BUNDLE: &str = "roster-push.bundle";

const MAX_REPO_BYTES: u64 = 2_000_000;
const MAX_FILE_BYTES: u64 = 64_000;
const ALLOWED_EXTENSIONS: &[&str] = &["md", "txt", "json", "yaml", "yml"];

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
                           (SKILL.md inside). The canonical repository is host-owned; each run \
                           gets a writable clone on its own branch, and edits land through \
                           skill_push. `git log main` is the history. See the meta-skill for \
                           the format and the push cycle.\n";

#[derive(Debug)]
pub struct SkillsCheckout {
    /// The canonical bare repo on the host.
    pub bare: PathBuf,
    /// The run's writable clone (mounted at SKILLS_MOUNT).
    pub path: PathBuf,
}

#[derive(Debug)]
pub struct PushOutcome {
    pub commit: String,
    pub files: usize,
    pub deletions: usize,
}

/// Ensure the canonical exists (seeding it on first call), then materialize
/// a writable clone on a run-named branch for this run. Failures here should
/// degrade the run (no skills), not kill it — the caller decides.
pub fn provision(worker: &str, run_id: &str) -> Result<SkillsCheckout, String> {
    let worker = short_worker(worker);
    safe_component(worker, "worker")?;
    safe_component(run_id, "run id")?;
    let repo = ensure_repo(worker)?;
    let destination = paths::run_dir(run_id).join("skills");
    checkout_for_run(&repo, &destination, run_id, worker)?;
    Ok(SkillsCheckout {
        bare: repo,
        path: destination,
    })
}

/// Land a run's committed skill edits on the canonical's main — validate
/// before apply, fast-forward only, journaled. Accepted from every run
/// kind: skills are the worker's own truth (mine-truth access), so there is
/// no clean-room predicate and no participant scan here — the boundary
/// those enforce protects other people's words, and a skill is the
/// worker's own procedure.
pub fn push(worker: &str, run_id: &str, head: &str) -> Result<PushOutcome, String> {
    let worker = short_worker(worker);
    safe_component(worker, "worker")?;
    safe_component(run_id, "run id")?;
    if !head.bytes().all(|b| b.is_ascii_hexdigit()) || head.len() != 40 {
        return Err("head must be a full commit sha".into());
    }
    let repo = paths::worker_skills_dir(worker).join("repo.git");
    if head_of(&repo).is_err() {
        return Err("this worker has no skills repository".into());
    }
    let bundle = paths::run_dir(run_id)
        .join("skills")
        .join(".git")
        .join(PUSH_BUNDLE);
    match push_inner(&repo, &bundle, head) {
        Ok(outcome) => {
            crate::worker::journal::append_required(
                &format!("org/{worker}"),
                run_id,
                "skills-pushed",
                json!({
                    "commit": outcome.commit,
                    "files": outcome.files,
                    "deletions": outcome.deletions,
                }),
            )?;
            Ok(outcome)
        }
        Err(error) => {
            let _ = crate::worker::journal::append_required(
                &format!("org/{worker}"),
                run_id,
                "skills-push-refused",
                json!({ "head": head, "error": error }),
            );
            Err(error)
        }
    }
}

fn push_inner(repo: &Path, bundle: &Path, head: &str) -> Result<PushOutcome, String> {
    if !bundle.exists() {
        return Err(
            "no push bundle found — the skill_push tool creates it from your committed branch"
                .into(),
        );
    }
    let bundle_bytes = fs::metadata(bundle)
        .map_err(|error| error.to_string())?
        .len();
    if bundle_bytes > MAX_REPO_BYTES {
        return Err(format!(
            "push bundle is {bundle_bytes} bytes, over the {MAX_REPO_BYTES} byte limit"
        ));
    }

    // Quarantine: a bare clone of the canonical (so thin-bundle
    // prerequisites resolve) receives the bundle and hosts every check.
    // The host never runs git against the box-written clone — a box-written
    // .git/config is an execution vector; everything arrives via the bundle.
    let parent = repo
        .parent()
        .ok_or("skills canonical has no parent dir")?
        .to_path_buf();
    let quarantine = TempTree::new(&parent, "push")?;
    let q = quarantine.path.join("quarantine.git");
    run_git(
        Path::new("."),
        &[
            "clone",
            "--quiet",
            "--bare",
            &repo.display().to_string(),
            &q.display().to_string(),
        ],
    )?;
    git_dir(
        &q,
        &["bundle", "verify", "--quiet", &bundle.display().to_string()],
    )
    .map_err(|error| format!("push bundle failed verification: {error}"))?;
    git_dir(
        &q,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            &bundle.display().to_string(),
            "HEAD:refs/q/head",
        ],
    )?;
    let fetched = git_dir(&q, &["rev-parse", "refs/q/head"])?;
    if fetched != head {
        return Err(format!(
            "the bundle's head {fetched} does not match the proposed head {head} — recreate the bundle and push again"
        ));
    }
    git_dir(&q, &["fsck", "--no-progress"])
        .map_err(|error| format!("pushed objects failed fsck: {error}"))?;

    // The whole proposed tree: regular files on acceptable paths, within
    // the size budget.
    let mut total_bytes: u64 = 0;
    for line in git_dir(&q, &["ls-tree", "-r", "--long", "refs/q/head"])?.lines() {
        let (meta, path) = line
            .split_once('\t')
            .ok_or_else(|| format!("unparseable ls-tree line: {line}"))?;
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let (mode, size) = match fields.as_slice() {
            [mode, _type, _sha, size] => (*mode, *size),
            _ => return Err(format!("unparseable ls-tree line: {line}")),
        };
        if mode != "100644" {
            return Err(format!(
                "skills may contain only regular files (mode 100644): {path} has mode {mode}"
            ));
        }
        total_bytes += size.parse::<u64>().unwrap_or(0);
        validate_relative_path(Path::new(path))?;
    }
    if total_bytes > MAX_REPO_BYTES {
        return Err(format!(
            "pushed tree is {total_bytes} bytes, over the {MAX_REPO_BYTES} byte limit"
        ));
    }

    let stale = |main: &str| {
        format!(
            "stale: main is now {main} — fetch origin, rebase your branch onto origin/main, and push again"
        )
    };
    let main = head_of(repo)?;
    if head == main {
        return Ok(PushOutcome {
            commit: head.into(),
            files: 0,
            deletions: 0,
        });
    }
    if !is_ancestor(&q, &main, head) {
        return Err(stale(&main));
    }

    // Validate what changed — the landed history was validated when it
    // landed. Every changed SKILL.md must keep the frontmatter contract, or
    // the skill silently drops out of pi's index: exactly the failure the
    // validate-before-apply rule exists to catch.
    let mut files = 0usize;
    let mut deletions = 0usize;
    for line in git_dir(&q, &["diff", "--raw", "--no-renames", &main, "refs/q/head"])?.lines() {
        let (meta, path) = line
            .split_once('\t')
            .ok_or_else(|| format!("unparseable diff line: {line}"))?;
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let [_src_mode, _dst_mode, _src_sha, dst_sha, status] = fields.as_slice() else {
            return Err(format!("unparseable diff line: {line}"));
        };
        files += 1;
        if *status == "D" {
            deletions += 1;
            continue;
        }
        let bytes = git_dir_bytes(&q, &["cat-file", "blob", dst_sha])?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(format!(
                "{path} is {} bytes, over the {MAX_FILE_BYTES} byte per-file limit",
                bytes.len()
            ));
        }
        let text = std::str::from_utf8(&bytes)
            .map_err(|_| format!("{path} is not valid UTF-8 — skills are text"))?;
        validate_skill_file(Path::new(path), text)?;
    }

    // The integration lane: land atomically, re-checking main under the lock.
    let _lane = acquire_lease(&lane_lock_path(repo))?;
    let main = head_of(repo)?;
    if head != main && !is_ancestor(&q, &main, head) {
        return Err(stale(&main));
    }
    let incoming = "refs/roster/incoming/skills";
    git_dir(
        repo,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            &q.display().to_string(),
            &format!("refs/q/head:{incoming}"),
        ],
    )?;
    // Compare-and-swap: refuses if main moved between the check and the write.
    let advance = git_dir(repo, &["update-ref", "refs/heads/main", head, &main]);
    let _ = git_dir(repo, &["update-ref", "-d", incoming]);
    advance.map_err(|_| stale(&head_of(repo).unwrap_or_default()))?;
    Ok(PushOutcome {
        commit: head.into(),
        files,
        deletions,
    })
}

/// A path inside the skills tree: plain relative components, no dotfiles,
/// an allowed text extension.
fn validate_relative_path(path: &Path) -> Result<(), String> {
    for component in path.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.starts_with('.') {
                    return Err(format!("{}: dotfiles are not skills", path.display()));
                }
            }
            _ => {
                return Err(format!(
                    "{}: path must be plain and relative",
                    path.display()
                ))
            }
        }
    }
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_EXTENSIONS.contains(&extension.as_str()) {
        return Err(format!(
            "{}: allowed extensions are {}",
            path.display(),
            ALLOWED_EXTENSIONS.join(", ")
        ));
    }
    Ok(())
}

/// The frontmatter contract for `<dir>/SKILL.md`: opens with `---`, carries
/// `name:` matching the directory and a non-empty `description:`. Everything
/// else in the tree is free-form text.
fn validate_skill_file(path: &Path, text: &str) -> Result<(), String> {
    let is_skill_md = path.file_name().is_some_and(|n| n == "SKILL.md");
    if !is_skill_md {
        return Ok(());
    }
    let dir = match path.parent().and_then(|p| p.file_name()) {
        Some(dir) => dir.to_string_lossy().into_owned(),
        // A top-level SKILL.md is not a skill root pi would index sensibly.
        None => return Err("SKILL.md must live in a skill directory".into()),
    };
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Err(format!(
            "{}: SKILL.md must open with `---` frontmatter",
            path.display()
        ));
    }
    let frontmatter: Vec<&str> = lines.by_ref().take_while(|l| *l != "---").collect();
    let name = frontmatter
        .iter()
        .find_map(|l| l.strip_prefix("name:"))
        .map(str::trim)
        .ok_or_else(|| format!("{}: frontmatter needs `name:`", path.display()))?;
    if name != dir {
        return Err(format!(
            "{}: frontmatter name \"{name}\" must match the directory \"{dir}\"",
            path.display()
        ));
    }
    let description = frontmatter
        .iter()
        .find_map(|l| l.strip_prefix("description:"))
        .map(str::trim)
        .unwrap_or("");
    if description.is_empty() {
        return Err(format!(
            "{}: frontmatter needs a non-empty `description:` — it is the index line every run sees",
            path.display()
        ));
    }
    Ok(())
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

/// The run's writable clone: run-named branch, worker-authored commits,
/// origin pointing at the box-visible read-only canonical mount.
fn checkout_for_run(
    repo: &Path,
    destination: &Path,
    run_id: &str,
    worker: &str,
) -> Result<(), String> {
    if destination.exists() {
        fs::remove_dir_all(destination).map_err(|error| error.to_string())?;
    }
    // --no-hardlinks is load-bearing: the clone is bind-mounted rw into the
    // box as the host uid, and hardlinked object files would let a box
    // corrupt canonical bytes through its own clone.
    run_git(
        Path::new("."),
        &[
            "clone",
            "--quiet",
            "--no-hardlinks",
            &repo.display().to_string(),
            &destination.display().to_string(),
        ],
    )?;
    run_git(
        destination,
        &["checkout", "--quiet", "-b", &format!("run/{run_id}")],
    )?;
    run_git(destination, &["config", "user.name", worker])?;
    run_git(
        destination,
        &[
            "config",
            "user.email",
            &format!("{worker}@workers.roster.local"),
        ],
    )?;
    run_git(
        destination,
        &["remote", "set-url", "origin", SKILLS_ORIGIN_MOUNT],
    )?;
    Ok(())
}

fn short_worker(worker: &str) -> &str {
    worker.strip_prefix("org/").unwrap_or(worker)
}

fn safe_component(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("unsafe {label} \"{value}\""));
    }
    Ok(())
}

struct Lease {
    _lock: crate::statefile::FileLock,
}

/// Host-side serialization for canonical setup and landings — same shape as
/// the knowledge repo's integration lane, keyed by the bare path.
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

fn is_ancestor(repo: &Path, ancestor: &str, descendant: &str) -> bool {
    git_dir(repo, &["merge-base", "--is-ancestor", ancestor, descendant]).is_ok()
}

fn git_dir(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut owned: Vec<String> = vec![format!("--git-dir={}", repo.display())];
    owned.extend(args.iter().map(|value| (*value).to_string()));
    run_git_owned(Path::new("."), owned)
}

fn git_dir_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg(format!("--git-dir={}", repo.display()))
        .args(args)
        .output()
        .map_err(|error| format!("could not run git: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!("git {} failed: {detail}", args.join(" ")));
    }
    Ok(output.stdout)
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

    fn commit_file(clone: &Path, rel: &str, content: &str, message: &str) -> String {
        let file = clone.join(rel);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, content).unwrap();
        run_git(clone, &["add", "--all"]).unwrap();
        run_git(clone, &["commit", "-q", "-m", message]).unwrap();
        run_git(clone, &["rev-parse", "HEAD"]).unwrap()
    }

    /// Seeded canonical + a run-style clone on a run branch.
    fn scaffold(root: &Path) -> (PathBuf, PathBuf) {
        let repo = root.join("repo.git");
        seed_repo(root, &repo).unwrap();
        let clone = root.join("clone");
        run_git(
            Path::new("."),
            &[
                "clone",
                "--quiet",
                &repo.display().to_string(),
                &clone.display().to_string(),
            ],
        )
        .unwrap();
        run_git(&clone, &["checkout", "-q", "-b", "run/test"]).unwrap();
        run_git(&clone, &["config", "user.name", "dobby"]).unwrap();
        run_git(&clone, &["config", "user.email", "d@w"]).unwrap();
        (repo, clone)
    }

    fn bundle_and_land(repo: &Path, clone: &Path, head: &str) -> Result<PushOutcome, String> {
        run_git(
            clone,
            &[
                "bundle",
                "create",
                ".git/roster-push.bundle",
                "origin/main..HEAD",
            ],
        )
        .unwrap();
        push_inner(repo, &clone.join(".git").join(PUSH_BUNDLE), head)
    }

    #[test]
    fn every_seed_has_wellformed_frontmatter() {
        for (name, content) in SEEDS {
            validate_skill_file(&Path::new(name).join("SKILL.md"), content)
                .unwrap_or_else(|e| panic!("seed {name}: {e}"));
        }
    }

    #[test]
    fn seed_then_checkout_yields_all_skills() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo.git");
        seed_repo(dir.path(), &repo).unwrap();
        let checkout = dir.path().join("checkout");
        checkout_for_run(&repo, &checkout, "2026-01-01-00-00-00-abcd1234", "dobby").unwrap();
        for (name, content) in SEEDS {
            let on_disk = fs::read_to_string(checkout.join(name).join("SKILL.md")).unwrap();
            assert_eq!(&on_disk, content, "{name}: checkout must match seed");
        }
        let branch = run_git(&checkout, &["branch", "--show-current"]).unwrap();
        assert_eq!(branch, "run/2026-01-01-00-00-00-abcd1234");
        let origin = run_git(&checkout, &["remote", "get-url", "origin"]).unwrap();
        assert_eq!(origin, SKILLS_ORIGIN_MOUNT);
        let count = git_dir(&repo, &["rev-list", "--count", "refs/heads/main"]).unwrap();
        assert_eq!(count, "1");
    }

    #[test]
    fn push_lands_valid_skill_and_refuses_stale() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, clone) = scaffold(dir.path());
        let head = commit_file(
            &clone,
            "ping/SKILL.md",
            "---\nname: ping\ndescription: A test skill that verifies the landing path works.\n---\n\n# Ping\n",
            "add ping",
        );
        let outcome = bundle_and_land(&repo, &clone, &head).unwrap();
        assert_eq!(outcome.commit, head);
        assert_eq!(head_of(&repo).unwrap(), head);

        // A clone that never rebased is stale once main moved.
        let other = dir.path().join("other");
        run_git(
            Path::new("."),
            &[
                "clone",
                "--quiet",
                &repo.display().to_string(),
                &other.display().to_string(),
            ],
        )
        .unwrap();
        run_git(&other, &["checkout", "-q", "HEAD~1"]).unwrap();
        run_git(&other, &["checkout", "-q", "-b", "run/other"]).unwrap();
        run_git(&other, &["config", "user.name", "dobby"]).unwrap();
        run_git(&other, &["config", "user.email", "d@w"]).unwrap();
        let stale_head = commit_file(
            &other,
            "pong/SKILL.md",
            "---\nname: pong\ndescription: Another test skill for the stale-push check.\n---\n",
            "add pong",
        );
        run_git(
            &other,
            &["bundle", "create", ".git/roster-push.bundle", "main..HEAD"],
        )
        .unwrap();
        let error =
            push_inner(&repo, &other.join(".git").join(PUSH_BUNDLE), &stale_head).unwrap_err();
        assert!(error.contains("stale"), "{error}");
    }

    #[test]
    fn push_refuses_what_would_break_the_index() {
        let dir = tempfile::tempdir().unwrap();
        let (repo, clone) = scaffold(dir.path());

        // Frontmatter name not matching the directory.
        let head = commit_file(
            &clone,
            "ping/SKILL.md",
            "---\nname: pong\ndescription: Name does not match its directory.\n---\n",
            "bad name",
        );
        let error = bundle_and_land(&repo, &clone, &head).unwrap_err();
        assert!(error.contains("must match the directory"), "{error}");

        // Missing description.
        run_git(&clone, &["reset", "-q", "--hard", "origin/main"]).unwrap();
        let head = commit_file(
            &clone,
            "ping/SKILL.md",
            "---\nname: ping\n---\n",
            "no description",
        );
        let error = bundle_and_land(&repo, &clone, &head).unwrap_err();
        assert!(error.contains("description"), "{error}");

        // Disallowed extension.
        run_git(&clone, &["reset", "-q", "--hard", "origin/main"]).unwrap();
        let head = commit_file(&clone, "ping/run.sh", "#!/bin/sh\n", "script");
        let error = bundle_and_land(&repo, &clone, &head).unwrap_err();
        assert!(error.contains("allowed extensions"), "{error}");

        // Nothing landed through any of it.
        let count = git_dir(&repo, &["rev-list", "--count", "refs/heads/main"]).unwrap();
        assert_eq!(count, "1");
    }
}
