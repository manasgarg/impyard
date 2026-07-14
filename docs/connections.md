# Service connections (2026-07-13)

**Status: implemented** — catalog in the provider registry, loader compilation
in `src/config.rs`, wizard + inventory in `src/cli/connections.rs`.

A **connection** is one intent — "this imp may act on that service" — that
previously smeared across four places: a provider template (providers.toml), a
secret (vault), a grant with injection (org.toml, with an ordering footgun),
and an `[[expose]]`. It is now one first-class object:

```toml
# ~/.config/impyard/connections/github.toml
provider = "github"          # registry entry: login flow + inject template
imps = ["yuko"]           # or: scope = "org" (the explicit escalation)
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
  `server start`, and `connection ls` — instead of failing the whole config
  closed. (Hand-written `[[expose]]` keeps strict fail-closed semantics.)

## One command

```
impyard connection catalog
impyard connection add                   # also shows the catalog
impyard connection add github --imp yuko # login → vault → scaffold → validate
impyard connection add github --org         # org-wide, spelled out
impyard connection add github --name github-kdemo --imp kdemo
```

The wizard runs the provider's login flow, stores the secret, scaffolds the
connection file (once — re-running only **rotates the secret**, never touches
the admin's edits), and prints the compiled result. Without `--imp`/`--org`
it asks; per-imp is the default posture because a connection is a
capability granted to an identity, not to the fleet. `--name` names the
connection/credential differently from the service — the idiom for per-imp
service identities (separate PATs ⇒ the service's own audit log distinguishes
imps too).

Inventory: `impyard connection ls [--json]` — provider, scope, hosts, env,
active/DISABLED.

## Scope rules

- **Services are box-consumed capabilities** → per-imp by default.
- **Channels (discord, slack, smtp) are host-consumed infrastructure.**
  `credential add discord` stores the credential; bind it in the imp.toml
  `[channels]` table. The credential never enters a box.
- Model providers (anthropic, openai-codex) are wired via grants as before.

## The catalog

Ships in the binary's provider registry: github, gitlab, slack-api, notion,
linear — each with auth kind, inject template, canonical hosts, and the
conventional env var. (`slack` is the *channel* provider — see
docs/slack-channel.md.) These are presets, not a restriction.

Add any token-authenticated service by naming its host. Impyard prompts for the
token without echoing it and defaults to `Authorization: Bearer {token}`, GET,
and an environment variable derived from the connection name:

```sh
impyard connection add acme --host api.acme.com --imp yuko
```

Override those defaults for APIs with different conventions:

```sh
impyard connection add gitlab-internal \
  --host gitlab.example.com \
  --header 'Private-Token: {token}' \
  --env GITLAB_TOKEN \
  --method GET --method POST \
  --imp yuko
```

For a reusable preset with a custom login flow, declare it in `providers.toml`:

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
