# System Design Notes

## MVP architecture

This MVP keeps one process handling API + WebSocket fanout for local demonstration.

- REST endpoint `POST /api/events` publishes capper actions.
- WS connections are maintained in-memory.
- Fan-to-capper follows are in-memory maps.
- Delivery ack updates are recorded for latency metrics.

The goal is clarity and a working demo, not full production durability.

## Production architecture

Scale version introduces:

1. WebSocket gateway layer for fan sessions.
2. Message bus for fanout fan signals.
3. Durable store for relationship data and event history.
4. Dedicated worker plane for fanout and delivery tracking.

## WebSocket gateway layer

Gateway responsibilities:

- authenticate fan session
- maintain heartbeat and reconnection metadata
- persist session registration in Redis
- push fan-targeted events from bus subscriptions

## Event bus path

Capper action path:

1. Control room posts event
2. API service persists event metadata
3. Event bus publishes message `{event_id, capper_id, payload}`
4. Gateways pull/consume and deliver to subscribed fan sessions
5. Delivery acks stream back for observability

## Fanout workers

A fanout worker can split by hash shard:

- events for `capper_id` route to shard worker
- worker reads active fan list for capper
- worker sends to local fan sessions first, then remote partitions

## Redis presence store

Track socket location and follow index:

- `fan:{fan_id}:sessions` -> active gateway + socket ids
- `capper:{capper_id}:fans` -> fan index for targeted fanout

## Postgres notification durability

Postgres tables:

- `cappers`
- `fans`
- `capper_follows`
- `notification_events`
- `notification_delivery_attempts`

Persist every event and attempt so you can recompute exactly-once/at-most-once semantics and recovery behavior.

## Offline push fallback

When fan is offline:

- store pending events with TTL
- when fan reconnects, fanout worker replays last events by cursor
- if mobile app is not connected, route to push provider

## Reconnect and replay

- heartbeat and socket timeout per fan
- resume token per fan after reconnect
- replay window based on last acknowledged `event_id`

## Hot capper fanout

For high-volume cappers:

- capper-to-fans index is partitioned and cached
- avoid fan-by-fan fanout from one node only
- pre-warm follower lists from write-through cache

## Idempotency

Fan clients and servers use `event_id` for dedupe.

## Failure modes

- Gateway failure: new connection through another node using Redis presence.
- Redis event bus partition: fallback to stale follow map only if within replay window.
- Database outage: buffer writes locally and mark backlog depth.
- Client drop: heartbeat marks stale sessions, reconnect flow updates session map.

## Observability

Track:

- queueing delay
- socket send delay
- ack delay
- fanout retry count
- active sessions by gateway

## Scaling math

Target from prompt: 100k concurrent connections.

A practical first horizontal shape:

- 20 gateway nodes x 5,000 concurrent sockets = 100,000 sessions
- each gateway with local memory for active sessions
- Redis + bus shared across gateways
- separate worker/service pools for API, persistence, and fanout
