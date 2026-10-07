#!/usr/bin/env bash
# Fill the user guide's demo stack with its demo data, replacing everything in
# that stack's database. See docs/user-guide/demo/README.md.
set -euo pipefail

repo="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$repo"

project="${USER_GUIDE_PROJECT:-riffado-user-guide}"
db_host="${USER_GUIDE_DB_HOST:-localhost}"
db_port="${USER_GUIDE_DB_PORT:-5435}"

compose() {
    docker compose -p "$project" -f docker-compose.e2e.yml \
        -f docs/user-guide/demo/docker-compose.demo.yml "$@"
}

export DATABASE_URL="postgresql://riffado_e2e:riffado-e2e-db-password@${db_host}:${db_port}/riffado_e2e"
export BETTER_AUTH_SECRET="riffado-e2e-auth-secret-for-local-testing-only"
export ENCRYPTION_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
export APP_URL="${USER_GUIDE_APP_URL:-http://localhost:3312}"
export ORG_ACCOUNT_EMAIL="org@example.com"
export ORG_ACCOUNT_PASSWORD="demo-organization-pass"
export ORG_ACCOUNT_NAME="Northwind Studio"
export DEFAULT_STORAGE_TYPE="local"

result="$(mktemp)"
trap 'rm -f "$result"' EXIT

USER_GUIDE_SEED=wipe-this-database USER_GUIDE_SEED_OUT="$result" \
    npx vitest run --config docs/user-guide/demo/vitest.config.ts

# The accounts are new, so is their audio. Speech-like noise as long as
# each recording, so the player has something to play.
compose exec -T app sh -c 'rm -rf /app/audio/* /app/storage/exports' </dev/null
node -e '
const { audio } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const file of audio) console.log(`${file.durationSeconds} ${file.storagePath}`);
' "$result" | while read -r seconds path; do
    compose exec -T app sh -c '
        set -e
        mkdir -p "$(dirname "/app/audio/$2")" /app/storage/exports
        ffmpeg -nostdin -loglevel error -y \
            -f lavfi -i "anoisesrc=color=pink:amplitude=0.3:sample_rate=16000:duration=$1" \
            -af "volume='"'"'0.1+0.9*abs(sin(2*PI*t/2.7)*sin(2*PI*t/0.9))'"'"':eval=frame,lowpass=f=2800" \
            -ac 1 -c:a libopus -b:a 12k "/app/audio/$2"
    ' sh "$seconds" "$path" </dev/null
done

# Drop the app's in-memory knowledge of the accounts the seed replaced.
compose restart app
echo "Demo data seeded. Sign in as alex@example.com / demo-password-123."
