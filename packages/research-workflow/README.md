# research-workflow

`research-workflow` is an append-only shared-filesystem research journal. Its
CLI is `rwf`.

```bash
rwf init
echo "Research content" | rwf note add --title "Example"
rwf artifact add results.csv --title "Experiment results"
rwf refresh
rwf search "Research content"
```

Notes and artifacts are immutable first-class entries. They share
reconciliation, topic, collection, provenance, validation, and manifest
semantics. Notes may reference artifacts but artifacts do not require
synthetic notes.

The package is currently developed as part of the Roster npm workspace. See
`docs/plans/research-workflow.md` in the repository root for the design.
