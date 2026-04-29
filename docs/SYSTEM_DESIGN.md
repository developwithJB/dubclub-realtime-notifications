# System Design Notes

## MVP architecture

The MVP keeps one Node process responsible for HTTP + WebSocket fanout.

Capabilities now in this iteration:

- REST endpoint `POST /api/events` publishes capper actions.
- Publish payload accepts product metadata: `audience_segment`, `delivery_channels`, `business_goal`, and optional `idempotency_key`.
- In-memory fan follow map.
- WebSocket fan connections keyed by `fanId`, with multiple active sessions per fan.
- Pick payload metadata for fan actions such as tailing, result review, rewards, trust context, responsible-play copy, and deep links.
- Delivery acknowledgements update `event_log` and latency samples.
- Bounded in-memory event log (`MAX_EVENT_LOG`) used as a replay buffer.
- Idempotent fan delivery with `(event_id, fan_id)` de-duplication.
- Last-seen cursor on fan `register` to attempt reconnect replay.
- Request-size guard and known capper/follow validation keep the demo API explicit without adding a full auth layer.

## Production architecture (target)

At scale:

1. API service validates and persists event metadata.
2. Event bus fans out normalized payloads.
3. WebSocket gateway layer subscribes and tracks active sessions.
4. Fanout worker pool performs targeted delivery.
5. Delivery states are written to durable storage.
6. Offline path writes to push queue fallback.

## Product context

This system is designed around DubClub's two-sided workflow:

- cappers need an operating system for urgent picks, result transparency, rewards, and subscriber retention
- fans need a low-friction way to trust, tail, review, and re-open capper content
- DubClub needs observability that separates business audience size from realtime delivery health

The MVP therefore tracks both product metadata and transport metadata. A notification is not just "sent"; it has an audience segment, delivery channel intent, business goal, trust context, and delivery breakdown.

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
- `notification_idempotency_keys`
- `fan_delivery_cursors`

Durability goals:

- authoritative event timeline
- exactly-once/once-delivered semantics at API level
- replay cursor persistence per fan
- latency and failure attribution queries
- trustworthy result/reward ledger for fan-facing history

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
- optional publish `idempotency_key` returns the prior event instead of broadcasting again

Production extension:

- unique constraint on `(event_id, fan_id)` in delivery table
- idempotency token on publish API to protect retries from clients
- scoped unique constraint on `(capper_id, idempotency_key)` for retry-safe capper publishes

## Failure modes

- gateway restart or socket drop: client reconnect + `last_seen_event_id` replay path
- duplicated publish path: dedupe by `event_id` at API and consumer edge
- event bus partition: fallback to health-checked buffer + stale-path handling
- DB outage: queue write attempts and report lag for remediation

## Observability

Track:

- active sessions by gateway
- follower targets versus online fan targets
- online sessions targeted
- send queue length / fanout p50/p95/p99
- delivery attempts, successes, retries, failures, replay sends, duplicate acks ignored
- offline pending fan count
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
- [x] Publish idempotency and basic API hardening
- [x] Product metadata for audience, channels, business goal, and trust context
- [ ] Durable fan/offline persistence
- [ ] Distributed websocket gateway pool
- [ ] Auth + authorization + moderation controls
- [ ] Push fallback for mobile/offline channels

## Intentional MVP stubs

- Auth and authorization: local demo trusts seeded fan/capper IDs; production signs fan sessions and scopes capper publish rights.
- Payments/subscriptions: follow state is seeded; production gates audience segments through subscription entitlements.
- Compliance/moderation: responsible-play copy is present, but real deployment needs jurisdiction-aware policy, support flows, and spend controls.
- Durable storage: event log, replay, idempotency, and cursors are in memory for review speed; production moves them to Redis/Postgres.
