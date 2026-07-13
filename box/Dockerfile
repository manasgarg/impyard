# The box: a CAPABLE machine behind a governed door (docs/capable-box.md).
# Tools are baked in deliberately — on the NAT-less network more binaries add
# no egress power, and a missing tool is an illegible "no" that belongs to the
# gateway instead. pi itself is NOT baked in yet — it comes from the read-only
# engine bind-mount, so the box always runs the exact pinned version on disk
# and cannot tamper with its own tools.
FROM node:24-bookworm-slim

# Tier 1 — always installed. Base image already carries node/npm/npx.
# build-essential is the big line (~250 MB): native pip/npm builds are the
# most common illegible failure when it is absent.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates curl git jq python3 ripgrep \
    build-essential pkg-config \
    fd-find file git-lfs less moreutils openssl poppler-utils procps \
    python3-pip python3-venv rsync sqlite3 tree tzdata unzip wget \
    xz-utils zip zstd \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s "$(command -v fdfind)" /usr/local/bin/fd \
  && git lfs install --system

# gh — the official apt repo (refreshed on every image rebuild).
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# yq (mikefarah, static) and uv (fast Python package manager, static).
RUN curl -fsSL "https://github.com/mikefarah/yq/releases/latest/download/yq_linux_$(dpkg --print-architecture)" \
       -o /usr/local/bin/yq \
  && chmod +x /usr/local/bin/yq
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# pnpm/yarn shims via corepack (ships with node).
RUN corepack enable

# Tier 2 — org choice, heavy: document/media tooling.
#   docker build --build-arg TIER2=1 -t roster-box box/
ARG TIER2=0
RUN if [ "$TIER2" = "1" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends pandoc imagemagick ffmpeg \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /workspace
