# Service connections (2026-07-13)

**Status: implemented** — catalog in the provider registry, loader compilation
in `src/config.rs`, wizard + inventory in `src/cli/connections.rs`.

A **connection** is one intent — "this worker may act on that service" — that
previously smeared across four places: a provider template (providers.toml), a
secret (vault), a grant with injection (org.toml, with an ordering footgun),
and an `[[expose]]`. It is now one first-class object:

```toml
# ~/.config/roster/connections/github.toml
provider = "github"          # registry entry: login flow + inject template
workers = ["yuko"]           # or: scope = "org" (the explicit escalation)
hosts = ["api.github.com"]
methods = ["GET"]            # writes are a deliberate manual edit
env = "GH_TOKEN"             # what the box sees (a sentinel, never the secret)
```

The loader compiles each connection live into: an egress grant with credential
injection, and an env exposure. The file name is the vault credential name.

Two structural fixes over hand-authoring:

- **No ordering footgun.** Connection grants are spliced before ALL
  hand-written grants (first-match-wins), so a broad rule like `web-fetch`
  (GET on `*`) can never shadow a connection's injection.
- **No sequencing trap.** A connection whose secret is missing from the vault
  is *disabled* — grant and exposure omitted, loud warning in `validate`,
  `server start`, and `connections` — instead of failing the whole config
  closed. (Hand-written `[[expose]]` keeps strict fail-closed semantics.)

## One command

```
roster server connect                      # the catalog
roster server connect github --worker yuko # login → vault → scaffold → validate
roster server connect github --org         # org-wide, spelled out
roster server connect github --as github-kdemo --worker kdemo
```

The wizard runs the provider's login flow, stores the secret, scaffolds the
connection file (once — re-running only **rotates the secret**, never touches
the admin's edits), and prints the compiled result. Without `--worker`/`--org`
it asks; per-worker is the default posture because a connection is a
capability granted to an identity, not to the fleet. `--as` names the
connection/credential differently from the service — the idiom for per-worker
service identities (separate PATs ⇒ the service's own audit log distinguishes
workers too).

Inventory: `roster server connections [--json]` — provider, scope, hosts, env,
active/DISABLED.

## Scope rules

- **Services are box-consumed capabilities** → per-worker by default.
- **Channels (discord, smtp) are host-consumed infrastructure** → they are
  NOT connections. `server connect discord` does the vault step and points at
  the worker.toml `[channels]` binding; the credential never enters a box.
- Model providers (anthropic, openai-codex) are wired via grants as before.

## The catalog

Ships in the binary's provider registry: github, gitlab, slack, notion,
linear — each with auth kind, inject template, canonical hosts, and the
conventional env var. Custom services need three lines in providers.toml, then
`connect` treats them like catalog entries:

```toml
[acme]
auth = "api_key"
inject = [{ header = "authorization", value = "Bearer {key}" }]
connection = { hosts = ["api.acme.com"], env = "ACME_TOKEN" }
```

## Cache note

Connection enabled-ness depends on the vault, so the config fingerprint
includes the vault *directory* mtime (changes on credential create/delete,
not on token-refresh rewrites) alongside all connection files.
