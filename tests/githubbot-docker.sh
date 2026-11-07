#!/usr/bin/env bash
# Offline image contract; build from repo root before running this script.
set -euo pipefail
cd "$(dirname "$0")/.."
image=${1:-githubbot:test}
[ "$(docker image inspect "$image" --format '{{.Config.User}}')" = bun ]
[ "$(docker image inspect "$image" --format '{{.Config.WorkingDir}}')" = /app/services/githubbot ]
[ "$(docker image inspect "$image" --format '{{ index .Config.Labels "org.opencontainers.image.source" }}')" = https://github.com/Cringe-Driven-Development-Team/.github ]
[ "$(docker image inspect "$image" --format '{{json .Config.ExposedPorts}}')" = null ]
volume="githubbot-test-$$-data"
trap 'docker volume rm "$volume" >/dev/null' EXIT
docker volume create "$volume" >/dev/null
run() { docker run --rm --network none --mount "type=volume,src=$volume,dst=/data" "$@"; }
config=$(cat services/githubbot/config.example.json)
run -e TELEGRAM_BOT_TOKEN=synthetic-telegram -e GITHUB_TOKEN=synthetic-github \
  -e "GITHUBBOT_CONFIG_JSON=$config" "$image" bun run src/main.ts --check-config
if run -e TELEGRAM_BOT_TOKEN=synthetic-telegram -e GITHUB_TOKEN=synthetic-github \
  -e GITHUBBOT_CONFIG_JSON='{}' "$image" bun run src/main.ts --check-config; then
  echo 'invalid configuration was accepted' >&2; exit 1
fi
if run "$image" bun run src/main.ts --health; then echo 'missing heartbeat was accepted' >&2; exit 1; fi
run "$image" bun -e '
  import { Database } from "bun:sqlite";
  import { existsSync } from "node:fs";
  const db = new Database("/data/githubbot.sqlite");
  db.exec("CREATE TABLE smoke (value TEXT NOT NULL)");
  db.query("INSERT INTO smoke VALUES (?)").run("durable");
  db.close();
  await Bun.write("/data/health.json", JSON.stringify({lastSuccess: Date.now()}));
  await Bun.write("/data/custom/health.json", JSON.stringify({lastSuccess: Date.now()}));
  for (const path of ["/app/services/githubbot/.env", "/app/services/githubbot/tests", "/app/services/webhook-alerts/src/main.ts"])
    if (existsSync(path)) throw new Error("unexpected image content: " + path);
'
run "$image" bun run src/main.ts --health
run -e DATABASE_PATH=/data/custom/githubbot.sqlite "$image" bun run src/main.ts --health
run "$image" bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database("/data/githubbot.sqlite", {readonly: true});
  if (db.query("SELECT value FROM smoke").get().value !== "durable") throw new Error("volume persistence failed");
  if (db.query("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("SQLite integrity failed");
  db.close();
  await Bun.write("/data/health.json", JSON.stringify({lastSuccess: Date.now() - 121000}));
'
if run "$image" bun run src/main.ts --health; then echo 'stale heartbeat was accepted' >&2; exit 1; fi
echo 'githubbot image config, health, non-root SQLite persistence ok (offline)'
