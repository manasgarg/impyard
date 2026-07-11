//! Owner inspection of immutable publication blobs and their version metadata.

type BErr = Box<dyn std::error::Error>;

pub fn run(args: &[String]) -> Result<(), BErr> {
    match args.first().map(String::as_str).unwrap_or("ls") {
        "ls" | "list" => list(&args[1..]),
        "show" => show(
            args.get(1)
                .ok_or("usage: roster blobs show <blob-or-publication-id>")?,
        ),
        "path" => path(args.get(1).ok_or("usage: roster blobs path <blob-id>")?),
        other => Err(format!("unknown blobs subcommand \"{other}\" (try: ls, show, path)").into()),
    }
}

fn list(args: &[String]) -> Result<(), BErr> {
    let worker = match args {
        [] => None,
        [flag, worker] if flag == "--worker" => Some(worker.as_str()),
        _ => return Err("usage: roster blobs ls [--worker <worker>]".into()),
    };
    let publications = crate::publish::list(worker);
    if publications.is_empty() {
        println!("no published blobs");
        return Ok(());
    }
    println!(
        "{:<17}  {:<10}  {:<24}  {:>7}  {:<8}  {:>10}  BLOB",
        "PUBLICATION", "WORKER", "LOGICAL NAME", "VERSION", "VISIBLE", "BYTES"
    );
    for publication in publications {
        println!(
            "{:<17}  {:<10}  {:<24}  {:>7}  {:<8}  {:>10}  {}",
            publication.publication_id,
            publication.worker,
            truncate(&publication.logical_name, 24),
            publication.version,
            publication.visibility,
            publication.bytes,
            truncate(&publication.blob_id, 24),
        );
    }
    Ok(())
}

fn show(id: &str) -> Result<(), BErr> {
    let publications = crate::publish::find(id);
    if publications.is_empty() {
        return Err(format!("no such blob or publication {id}").into());
    }
    println!("{}", serde_json::to_string_pretty(&publications)?);
    Ok(())
}

fn path(id: &str) -> Result<(), BErr> {
    println!("{}", crate::publish::blob_path(id)?.display());
    Ok(())
}

fn truncate(value: &str, width: usize) -> String {
    if value.chars().count() <= width {
        value.into()
    } else {
        value
            .chars()
            .take(width.saturating_sub(1))
            .collect::<String>()
            + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncation_is_unicode_safe() {
        assert_eq!(truncate("éééé", 3), "éé…");
    }
}
