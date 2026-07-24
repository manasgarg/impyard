//! `roster worker add <name>` — scaffold a minimal worker spec.

use crate::paths;
use std::fs;

pub fn run(name: &str) -> Result<(), Box<dyn std::error::Error>> {
    let ok = !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && name.as_bytes()[0] != b'-';
    if !ok {
        return Err(
            format!("worker name must be lowercase letters/numbers/hyphens: \"{name}\"").into(),
        );
    }
    if name == "org" {
        return Err(
            "\"org\" is reserved — it names the org scope and the fleet-wide grant edge".into(),
        );
    }

    let dir = paths::worker_dir(name);
    let path = dir.join("worker.toml");
    let identity = dir.join("identity.md");
    let knowledge_ready = crate::worker::knowledge::repo_path(name).is_ok();
    // Refuse only a *fully* initialized worker; a half-finished init (files
    // written but knowledge init crashed, or vice versa) must be re-runnable to
    // completion instead of being permanently blocked by "already exists".
    if path.exists() && identity.exists() && knowledge_ready {
        return Err(format!(
            "worker \"{name}\" already exists and is fully set up at {} — edit its files directly",
            dir.display()
        )
        .into());
    }
    fs::create_dir_all(&dir)?;

    // Create-if-missing throughout, so a re-run never clobbers an admin's edits.
    if !path.exists() {
        fs::write(
            &path,
            format!("# Worker spec — ADMIN-ONLY. Overlays org.toml at scope \"org/{name}\".\nname = \"{name}\"\n"),
        )?;
        println!("created {}", path.display());
    } else {
        println!("kept    {}", path.display());
    }

    // A deliberately minimal identity: a name, and the fact of being a digital
    // worker. Everything else is shaped later — by the admin editing this file,
    // or by the worker proposing changes (gated, D10). Operating principles
    // live in the runtime policy, not here.
    if !identity.exists() {
        fs::write(
            &identity,
            format!(
                "# {name}\n\n\
                 Your name is {name}. You're a worker — a colleague made of software,\n\
                 not a human. That's all that's fixed about you. The rest of who you are\n\
                 takes shape through the work you do and the people you do it with.\n"
            ),
        )?;
        println!("created {}", identity.display());
    } else {
        println!("kept    {}", identity.display());
    }

    // The worker's own standing notes, seeded once into the store — the one
    // pre-first-run write the host makes there; from then on the file is the
    // worker's (docs/plans/prompt-architecture.md). Compiled into every run
    // as the advisory WORKER NOTES block.
    let prompt = crate::paths::worker_store_dir(name).join("prompt.md");
    if !prompt.exists() {
        fs::create_dir_all(prompt.parent().expect("store dir has a parent"))?;
        fs::write(
            &prompt,
            "These are my own notes to myself. They are advisory, not rules, and I\n\
             can rewrite this file whenever I learn something better.\n\
             \n\
             - When someone messages me, I reply right away, even if only to say\n\
             \x20 what I'm about to do. Work that takes real time happens in a task.\n\
             - I report honestly. Leaving work unfinished with a note about where I\n\
             \x20 stopped is fine; calling it done when it isn't is not.\n\
             - What someone tells me in one conversation stays in that conversation.\n\
             - Before starting a piece of work, I check my skills index and read\n\
             \x20 the matching skill.\n\
             - My store explains itself: every directory that matters has a README,\n\
             \x20 and I keep them true.\n",
        )?;
        println!("created {}", prompt.display());
    } else {
        println!("kept    {}", prompt.display());
    }

    if knowledge_ready {
        println!("kept    knowledge repository");
    } else {
        let knowledge_commit = crate::worker::knowledge::initialize(name).map_err(|error| {
            format!(
                "worker files are in place, but its knowledge repository could not be initialized \
                 (re-run `roster worker add {name}` after fixing): {error}"
            )
        })?;
        println!("initialized knowledge at {knowledge_commit}");
    }
    println!("edit them anytime — config loads live (roster server validate checks it)");
    println!(
        "\nnext: roster talk {name}   (or file work: roster worker task add {name} \"<prompt>\")"
    );
    if !crate::run::boxed::model_credentials_available() {
        println!(
            "note: no model credential yet — {name} can't think until one is connected: \
             roster connection add anthropic  (or openai-codex)"
        );
    }
    Ok(())
}
