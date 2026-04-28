# System Design Notes

## MVP architecture

The MVP keeps one Node process responsible for HTTP + WebSocket fanout.

Capabilities now in this iteration:

- REST endpoint `POST /api/events` publishes capper actions.
- In-memory fan follow map.
- WebSocket fan connections keyed by `fanId`, with multiple active sessions per fan.
- Pick payload metadata for fan actions such as tailing, result review, rewards, and deep links.
- Delivery acknowledgements update `event_log` and latency samples.
- Bounded in-memory event log (`MAX_EVENT_LOG`) used as a replay buffer.
- Idempotent fan delivery with `(event_id, fan_id)` de-duplication.
- Last-seen cursor on fan `register` to attempt reconnect replay.

## Production architecture (target)

At scale:

1. API service validates and persists event metadata.
2. Event bus fans out normalized payloads.
3. WebSocket gateway layer subscribes and tracks active sessions.
4. Fanout worker pool performs targeted delivery.
5. Delivery states are written to durable storage.
6. Offline path writes to push queue fallback.

## WebSocket gateway layer

Gateway responsibilities:

- authenticate fan session
- maintain heartbeat / heartbeat state
- keep presence in Redis
- support multiple devices per fan without dropping existing sessions
- route fanout from bus to local fan channels
- expose control-room observability stream

## Event bus path

1. Control room sends event via `POST /api/events`.
2. API creates event metadata and publishes `{ event_id, capper_id, payload }`.
3. Fanout workers receive from bus and fan out by follower index shard.
4. Fan sockets receive targeted events and send ack updates.
5. Metrics pipeline updates latency and delivery health.

## Fanout workers

For high-volume cappers, fan lists are partitioned:

- split by capper shard
- fan session lookup in Redis/local cache
- avoid single-node hot loops by spreading fan lists

## Redis presence store

Useful structures:

- `fan:{fan_id}:sessions` for active websocket sessions
- `capper:{capper_id}:fans` for follower index
- `gateway:{node_id}:load` for per-node fanout telemetry

## Postgres notification durability

Core tables:

- `cappers`
- `fans`
- `capper_follows`
- `notification_events`
- `notification_deliveries`

Durability goals:

- authoritative event timeline
- exactly-once/once-delivered semantics at API level
- replay cursor persistence per fan
- latency and failure attribution queries

## Offline push fallback

Current MVP does not persist off-network state.

Production fallback:

- persist pending delivery attempts for offline fans
- on reconnection, consume missing events from durable store
- for disconnected mobile clients, publish push notification and in-app inbox sync

## Reconnect and replay (MVP)

MVP behavior:

- fan sends `last_seen_event_id` during `register`
- server checks replay buffer and re-sends matching events
- events already acknowledged for that fan are deduped
- if cursor is too old, server replays best-effort window and may miss earlier data

Limitations:

- replay buffer is memory-only and bounded
- no per-device cursor persistence across restarts

## Production replay comparison

Production-ready replay would:

- persist fan cursor in Redis/Postgres
- query missing events by cursor window in durable event table
- support gap recovery and tombstone/expiry policy
- separate idempotency keys for at-least-once delivery semantics

## Hot capper fanout

For stars with very large follow lists:

- partition capper follower lists
- pre-compute fan cohort caches
- apply batching and adaptive throttling for bursty game-time periods

## Idempotency

Current MVP:

- `event_id` is generated per capper action
- fan-level dedupe map prevents duplicate counting in metrics
- duplicate ack for same fan/event is ignored

Production extension:

- unique constraint on `(event_id, fan_id)` in delivery table
- idempotency token on publish API to protect retries from clients

## Failure modes

- gateway restart or socket drop: client reconnect + `last_seen_event_id` replay path
- duplicated publish path: dedupe by `event_id` at API and consumer edge
- event bus partition: fallback to health-checked buffer + stale-path handling
- DB outage: queue write attempts and report lag for remediation

## Observability

Track:

- active sessions by gateway
- send queue length / fanout p50/p95/p99
- delivery attempts, successes, retries, failures
- replay volume and replay misses
- heartbeat drops and reconnect churn

## Scaling math

Target from challenge prompt:

`20` gateway nodes x `5,000` concurrent sockets = `100,000` concurrent connections

In production this requires:

- stable event bus throughput planning
- sharded follow index
- bounded fanout fanout latency
- per-gateway autoscaling with graceful drain

## Local-to-production mapping checklist

- [x] Targeting correctness and end-to-end observability in demo
- [x] Idempotent ack handling at fan level
- [x] Reconnect replay with bounded buffer
- [ ] Durable fan/offline persistence
- [ ] Distributed websocket gateway pool
- [ ] Auth + authorization + moderation controls
- [ ] Push fallback for mobile/offline channels
