# Examples

Task-oriented commands for running and using the host. Every variable is
described in [configuration.md](configuration.md). Replace example hostnames
and credentials with your own.

## Run with Docker against mainnet headers

The host needs MySQL. A throwaway database for trying it out:

```sh
docker network create overlay
docker run -d --name overlay-db --network overlay \
  -e MYSQL_ROOT_PASSWORD=change-me -e MYSQL_DATABASE=overlay mysql:9

docker run -d --name overlay-host --network overlay -p 8080:8080 \
  -e OVERLAY_TOPICS=tm_anytx \
  -e OVERLAY_KNEX_URL=mysql://root:change-me@overlay-db:3306/overlay \
  -e OVERLAY_CHAIN_TRACKER_URL=woc:main \
  -e OVERLAY_ADMIN_TOKEN=change-me-too \
  ghcr.io/lightwebinc/overlay-blueprints:0.2.3
```

`woc:main` reads block headers from the public WhatsOnChain API and checks
each one's proof of work. For testnet use `woc:test`. Behind a bridge, set
`OVERLAY_CHAIN_TRACKER_URL` to the bridge's header API instead.

If MySQL is still starting, the host exits; start it again once
`docker logs overlay-db` shows the server is ready.

## Check health

```sh
curl -s localhost:8080/healthz
curl -s localhost:8080/readyz        # 200 once storage and the chain tracker answer
curl -s localhost:8080/metrics | grep '^overlay_host_'
```

## Submit a transaction (BRC-22)

The body is a BEEF, as raw bytes; `x-topics` names the topics, either as a
JSON list or comma separated:

```sh
curl -s -X POST localhost:8080/submit \
  -H 'content-type: application/octet-stream' \
  -H 'x-topics: ["tm_anytx"]' \
  --data-binary @tx.beef
```

The answer is a STEAK: per topic, the output indexes admitted. Every merkle
path in the BEEF must verify against the configured header source, so submit
mined transactions (or resubmit later with the proof; the host upgrades a
stored unproven copy when the path verifies).

## Look up (BRC-24)

`ls_anytx` answers by outpoint, or pages through everything it holds:

```sh
curl -s -X POST localhost:8080/lookup -H 'content-type: application/json' \
  -d '{"service":"ls_anytx","query":{"outpoint":"<txid>.0"}}'

curl -s -X POST localhost:8080/lookup -H 'content-type: application/json' \
  -d '{"service":"ls_anytx","query":{"all":true,"limit":100}}'
# next page: add "after":"<last txid>.<index>"
```

## Catch up from a peer (GASP)

Name the peers per topic, then trigger a sync with the admin token:

```sh
-e OVERLAY_SYNC_PEERS='tm_anytx=https://peer.example'
curl -s -X POST localhost:8080/admin/startGASPSync \
  -H 'authorization: Bearer change-me-too'
```

With no peers configured the route answers `{"status":"no-peers"}`.

## Build an application image on this host

An application is a compiled ES module whose default export returns its topic
managers and lookup services (contract in
[configuration.md](configuration.md#modules)). Place it inside the host tree
so it shares the host's `@bsv/sdk`:

```dockerfile
FROM ghcr.io/lightwebinc/overlay-blueprints:0.2.3
COPY --chown=node dist/ /app/modules/myapp/
ENV OVERLAY_TOPICS=tm_myapp \
    OVERLAY_MODULES=/app/modules/myapp/index.js
```

## Build from source

```sh
npm ci
npm run build
npm test
docker build -t overlay-blueprints:dev .
```

`docker compose up --build` starts MySQL and the host together for local
development; it requires `OVERLAY_CHAIN_TRACKER_URL` (for example `woc:main`).
