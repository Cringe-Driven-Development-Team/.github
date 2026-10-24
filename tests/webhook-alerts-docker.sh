#!/usr/bin/env bash
# Real image contract: health, durable intake across recreation, snapshot CLI.
# Build first: docker build -t webhook-alerts:test services/webhook-alerts
set -euo pipefail
image=${1:-webhook-alerts:test}
name="webhook-alerts-test-$$"
volume="$name-data"
cleanup() {
  if [ "$?" -ne 0 ]; then docker logs "$name" >&2 || true; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker volume create "$volume" >/dev/null
start() {
  docker run -d --name "$name" --mount "type=volume,src=$volume,dst=/data" \
    -e GITHUB_WEBHOOK_SECRET=synthetic-github-secret \
    -e APIDOG_SIGNATURE_KEY=synthetic-apidog-secret \
    -e APIDOG_SIGNATURE_HEADER=X-Synthetic-Signature \
    -e WEBHOOK_ALERTS_SEND_ENABLED=false "$image" >/dev/null
  for _ in {1..50}; do
    if docker exec "$name" wget -q -O /dev/null http://127.0.0.1:8080/health; then return; fi
    sleep 0.2
  done
  echo 'image did not become healthy' >&2
  return 1
}
deliver() {
  docker exec "$name" bun -e '
    import { createHmac } from "node:crypto";
    const raw = JSON.stringify({ action: "opened" });
    const response = await fetch("http://127.0.0.1:8080/webhooks/github", {
      method: "POST", body: raw, headers: {
        "Content-Type": "application/json", "X-GitHub-Event": "issues",
        "X-GitHub-Delivery": "docker-persistence-test",
        "X-Hub-Signature-256": "sha256=" + createHmac("sha256", Bun.env.GITHUB_WEBHOOK_SECRET).update(raw).digest("hex"),
      },
    });
    if (response.status !== Number(process.argv[1])) throw new Error(`unexpected delivery response: ${response.status}`);
  ' "$1"
}
start
deliver 202
docker stop "$name" >/dev/null
docker rm "$name" >/dev/null
start
deliver 200
docker exec "$name" bun run src/cli.ts snapshot --output /data/snapshots/queue.sqlite
docker exec "$name" bun -e '
  import { Database } from "bun:sqlite";
  const db = new Database("/data/snapshots/queue.sqlite", { readonly: true });
  try {
    if (db.query("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("snapshot integrity failed");
    if (db.query("SELECT count(*) AS n FROM deliveries WHERE delivery_id = ? AND prepared = 0").get("docker-persistence-test").n !== 1) throw new Error("durable pending delivery missing");
    if (db.query("SELECT count(*) AS n FROM outbox").get().n !== 0) throw new Error("disabled worker prepared outgoing messages");
  } finally { db.close(); }
  for (const suffix of ["-wal", "-shm"]) {
    if (await Bun.file("/data/snapshots/queue.sqlite" + suffix).exists()) throw new Error("snapshot depends on sidecar");
  }
'
echo 'webhook image health, persistence and snapshot ok'
