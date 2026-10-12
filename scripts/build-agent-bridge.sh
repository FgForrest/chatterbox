#!/usr/bin/env bash

set -euo pipefail

source_dir="${AGENT_BRIDGE_SOURCE_DIR:-/www/oss/riffado/agent-bridge}"
image="${AGENT_BRIDGE_IMAGE:-riffado-agent-bridge:local}"
claude_version="${CLAUDE_CODE_VERSION:-2.1.281}"
codex_version="${CODEX_VERSION:-0.155.1}"

if [[ ! -f "$source_dir/Dockerfile" ]]; then
    echo "Agent bridge source is missing: $source_dir" >&2
    exit 1
fi

docker build \
    --build-arg "CLAUDE_CODE_VERSION=$claude_version" \
    --build-arg "CODEX_VERSION=$codex_version" \
    -t "$image" \
    "$source_dir"
