set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Install the Node workspace and Rust dependencies.
setup:
    npm ci
    cargo fetch --locked

# Build the Rust application and the rwf CLI.
build:
    cargo build --locked
    npm run build:rwf

# Check formatting, types, lints, and tests.
check:
    cargo fmt --check
    cargo clippy --locked --all-targets -- -D warnings
    npm run check:rwf
    cargo test --locked
    npm test --workspace @manasgarg/research-workflow

# Run every test suite.
test:
    cargo test --locked
    npm test --workspace @manasgarg/research-workflow

# Rebuild rwf while its TypeScript sources change.
rwf-watch:
    npm run dev --workspace @manasgarg/research-workflow

# Build the local agent box.
box:
    docker build -t roster-box -f box/Dockerfile .
