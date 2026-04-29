# DubClub Realtime Notifications - 90-Second Loom Script

## 0:00 - What this is

Hi, this is a demo system for a sports creator platform. It shows how capper notifications are delivered to fans in real time over WebSocket with end-to-end observability.

## 0:10 - Why this is specific to a sports capper platform

This is not a generic chat app. It models a capper-driven content flow:
- sharp sports picks
- odds movement alerts
- game start reminders
- results
- reward unlocks
Fans only receive what they actually follow, which is core to creator loyalty and noise control.

## 0:25 - Show Capper Control Room

I open the dashboard and point to the Capper Control Room.
- Two seeded cappers are available: SharpSide Sam and Courtside Kelly.
- The control room has action buttons for all event types used in the challenge.

## 0:40 - Trigger "Post New Pick"

I select SharpSide Sam and click **Post New Pick**.
- This sends a typed event through the backend API.
- Backend writes an event with a unique id and timestamp, then fans out to live sockets.

## 0:50 - Show only matching fans receive it

I show two fan cards:
- a Sam follower, who gets the card immediately
- a Kelly-only follower, who does not

I point out the highlights on fan inbox cards and the delivery log so it is clear the routing is targeted, not broadcast.

## 0:58 - Show the fan product action

On the fan card, I click **Tail Pick** and show that the pick moves from passive alert to fan intent. The payload includes the market, line, odds, confidence, status, and a deep link into the pick surface, which is the daily-use product loop behind the infrastructure.

## 1:00 - Show latency metrics and event log

I show the metrics panel:
- active connections
- notifications sent
- delivered
- average latency and p95

Then I show the event log proving per-event id tracking and delivery status.

## 1:10 - Mention load test, replay, idempotency, and CI

This also includes lightweight automation:
- `npm run test:smoke` checks follower-only delivery and metrics shape.
- `npm run load:test:small` simulates many live fan sockets and reports latency percentiles.
- The load test fails if expected follower-session deliveries are missed or non-followers receive messages.
- Reconnect replay and event id dedupe protect delivery state when clients reconnect.
- CI runs install, typecheck, build, then server smoke checks for each PR.

## 1:20 - Explain path to 100k concurrent connections

The local project is intentionally in-memory for clarity. The production path shown in docs shifts to Redis for presence and fan indices, an event bus for fanout fan partitions, and Postgres for durable event and delivery records.

## 1:30 - Close with tradeoff

Tradeoff is explicit: this MVP is production-ready in behavior, not in scale.
- Local build: simple, readable, and fast to evaluate.
- Production path: gateway sharding, Redis-backed presence, durable replay, and push fallback for disconnected fans.

This keeps the demo credible for architecture discussion while still being demo-ready in minutes.
