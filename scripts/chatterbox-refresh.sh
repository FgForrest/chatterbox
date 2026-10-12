#!/usr/bin/env bash
# Refresh the local Chatterbox deployment.
#
# Pulls the images configured in /opt/riffado (the app, and the mail
# receiver when the `mail` profile is on), builds the agent bridge from the
# source checkout, and refreshes those containers through the deployment
# Compose project. Postgres and data volumes are left alone.
#
# Run from anywhere as `chatterbox-refresh` (symlinked into ~/.local/bin).

set -euo pipefail

COMPOSE_DIR="/opt/riffado"
CONTAINER="riffado-app"
BRIDGE_CONTAINER="riffado-agent-bridge"
BRIDGE_IMAGE="${AGENT_BRIDGE_IMAGE:-riffado-agent-bridge:local}"
MAIL_CONTAINER="riffado-mail-receiver"
HEALTH_TIMEOUT_SECONDS=90
MAIL_TIMEOUT_SECONDS=60

cd "$COMPOSE_DIR"

image_id() {
    local id
    id="$(docker inspect --format '{{.Image}}' "$1" 2>/dev/null)" || id="none"
    echo "$id"
}

has_service() {
    [[ " ${2//$'\n'/ } " == *" $1 "* ]]
}

report_image() {
    local after
    after="$(image_id "$1")"
    echo "==> $1 runs $(docker inspect --format '{{.Config.Image}}' "$1")"
    if [ "$2" = "$after" ]; then
        echo "    unchanged: ${after#sha256:}"
    else
        echo "    before: ${2#sha256:}"
        echo "    after:  ${after#sha256:}"
    fi
}

mail_receiver=false
if has_service mail-receiver "$(docker compose config --services)"; then
    mail_receiver=true
fi

before="$(image_id "$CONTAINER")"
mail_before="$(image_id "$MAIL_CONTAINER")"

echo "==> Pulling app image"
docker compose pull app

if [ "$mail_receiver" = true ]; then
    echo "==> Pulling mail receiver image"
    if ! docker compose pull mail-receiver; then
        echo "==> Could not pull the mail receiver image. The deployment override names" >&2
        echo "    the published one (see mail-receiver/README.md). No container was changed." >&2
        exit 1
    fi
fi

echo "==> Building agent bridge"
(
    cd /www/oss/riffado
    ./scripts/build-agent-bridge.sh
)

if ! has_service agent-bridge "$(docker compose --profile agent-bridge config --services)"; then
    echo "==> The deployment Compose project has no agent-bridge service" >&2
    exit 1
fi

compose_files=(-f "$COMPOSE_DIR/docker-compose.yml")
if [[ -f "$COMPOSE_DIR/docker-compose.override.yml" ]]; then
    compose_files+=(-f "$COMPOSE_DIR/docker-compose.override.yml")
fi
bridge_override="$(mktemp --suffix=.yml)"
trap 'rm -- "$bridge_override"' EXIT
printf 'services:\n  agent-bridge:\n    image: %s\n' "$BRIDGE_IMAGE" > "$bridge_override"

echo "==> Refreshing agent bridge"
docker compose "${compose_files[@]}" -f "$bridge_override" up -d --no-deps --no-build --pull never --force-recreate agent-bridge

bridge_built="$(docker image inspect "$BRIDGE_IMAGE" --format '{{.Id}}')"
bridge_running="$(docker inspect "$BRIDGE_CONTAINER" --format '{{.Image}}')"
if [ "$bridge_built" != "$bridge_running" ]; then
    echo "==> $BRIDGE_CONTAINER is not running the image just built" >&2
    echo "    built:   ${bridge_built#sha256:}" >&2
    echo "    running: ${bridge_running#sha256:}" >&2
    exit 1
fi

echo "==> Applying"
docker compose up -d app

report_image "$CONTAINER" "$before"

echo "==> Waiting for health (up to ${HEALTH_TIMEOUT_SECONDS}s)"
status="unknown"
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")"
    [ "$status" = "healthy" ] && break
    sleep 2
done

docker compose ps

if [ "$status" != "healthy" ]; then
    echo "==> $CONTAINER is '$status', not healthy. Recent logs:" >&2
    docker compose logs --tail 30 app >&2
    exit 1
fi

if [ "$mail_receiver" = true ]; then
    echo "==> Refreshing mail receiver"
    docker compose up -d --no-deps --no-build mail-receiver
    report_image "$MAIL_CONTAINER" "$mail_before"

    echo "==> Waiting for the mail receiver to listen (up to ${MAIL_TIMEOUT_SECONDS}s)"
    state="unknown"
    listening=false
    deadline=$((SECONDS + MAIL_TIMEOUT_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
        state="$(docker inspect --format '{{.State.Status}}' "$MAIL_CONTAINER" 2>/dev/null || echo "unknown")"
        [ "$state" = "running" ] || break
        started="$(docker inspect --format '{{.State.StartedAt}}' "$MAIL_CONTAINER")"
        logs="$(docker logs --since "$started" "$MAIL_CONTAINER" 2>&1)"
        if [[ "$logs" == *"listening on"* ]]; then
            listening=true
            break
        fi
        sleep 2
    done

    if [ "$listening" != true ]; then
        echo "==> $MAIL_CONTAINER is '$state' and not listening. Recent logs:" >&2
        docker compose logs --tail 30 mail-receiver >&2
        exit 1
    fi
    echo "==> $MAIL_CONTAINER is listening"
fi

echo "==> Chatterbox is healthy on $(grep -E '^APP_URL=' .env | cut -d= -f2- || echo 'the configured APP_URL')"
