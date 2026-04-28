# Dub Club Realtime Notifications (MVP)

[![CI](https://github.com/developwithJB/dubclub-realtime-notifications/actions/workflows/ci.yml/badge.svg)](https://github.com/developwithJB/dubclub-realtime-notifications/actions/workflows/ci.yml)

This repo is an open-source **system-design demo project** for a real-time notification platform used by a sports creator community.

Cappers publish content in real time. Fans receive only the notifications for cappers they follow.

## Product framing

- Expert cappers post:
  - new picks
  - odds movement alerts
  - game-start reminders
  - result updates
  - rewards and notes
- Fans should only receive what they follow.
- Dashboard should expose fan activity, delivery health, and latency signals.

This project is deliberately MVP-first: minimal infrastructure, clear local behavior, and strong interview-ready explanation.

## What this project contains

- Node + TypeScript WebSocket backend (`server/`)
- Vite + React + TypeScript dashboard (`client/`)
- Two seeded cappers and six seeded fan identities
- Live fanout with per-event acknowledgements
- Reconnect replay using an in-memory event buffer
- Event idempotency for ack handling
- Load-test and smoke-test scripts for repeatable validation
- CI pipeline that builds, typechecks, and runs smoke checks

## Why this exists

The goal is to show a practical path from a local demo to a scalable production architecture with clear tradeoffs:

- local architecture you can run and inspect in minutes
- explicit notes on what changes at 100k concurrent connection scale
- evidence of latency and fan targeting behavior through scripts + dashboard

## Quick start

### 1) Install

```bash
npm install
```

### 2) Run local dev

```bash
npm run dev
```

This starts:

- backend server at `http://localhost:4000`
- frontend dashboard at `http://localhost:5173`

Open the dashboard in your browser.

## Core demo sections

### Capper Control Room

- select either seeded capper:
  - SharpSide Sam
  - Courtside Kelly
- send one of:
  - Post New Pick
  - Odds Moved
  - Game Starting Soon
  - Result Posted
  - Reward Unlocked
  - Live Capper Note

### Simulated Fan Clients

- six seeded fan cards
- each shows:
  - connection state
  - followed cappers
  - inbox notifications
  - latest observed latency
  - highlight animation on newly received events

### Live event stream and metrics

- active connections
- sent notifications
- delivered notifications
- average latency
- p95 latency
- latest event type
- rolling event log

### Follow targeting proof

A fan receives events only if the fan currently follows that capper.

## Seeded fan data

- 2 cappers are seeded:
  - SharpSide Sam
  - Courtside Kelly
- 6 fans are seeded with follow combinations:
  - some follow Sam
  - some follow Kelly
  - one follows both
  - one follows neither

## Local architecture

```text
Control Room UI --> POST /api/events
                        |
                        v
         Node + ws Backend (WebSocket + HTTP)
         | fan connections + follow map in memory |
         +--> fan sockets receive capper events
         +--> control socket receives live metrics + event log
```

## Replay and idempotency

The backend keeps a bounded in-memory event log (replay buffer). On fan reconnect:

- fan can send `last_seen_event_id` in `register`
- server replays events after that event id for followed cappers
- duplicates are deduped with `event_id`+`fan_id`

If `last_seen_event_id` is too old, server replays best-effort from buffer and notes that early events may be missing.

This is local-first behavior and is documented as a bridge to durable replay in production.

## Scripts

From repository root:

- `npm run dev`
  - runs backend and frontend together
- `npm run build`
- `npm run typecheck`
- `npm run load:test`
  - uses env-configurable simulation settings (defaults: 100 clients, 10 events)
- `npm run load:test:small`
- `npm run load:test:medium`
- `npm run test:smoke`
  - validates targeted fan delivery and numeric metrics

## Load testing notes

See [docs/LOAD_TESTING.md](docs/LOAD_TESTING.md) for:

- command examples
- metrics collected
- what the test proves
- why local load tests do not prove 100k by themselves

## CI

Workflow: [ci.yml](.github/workflows/ci.yml)

- npm install
- npm run typecheck
- npm run build
- starts server and runs smoke test

## Local to production mapping

This demo intentionally uses in-memory state and one process. For production-like behavior:

- WebSocket gateway layer handles auth, heartbeats, and session state
- Redis holds connection presence and fan follow index
- API/service publishes events to a message bus
- fanout workers subscribe and push to local gateway shards
- Postgres stores events + delivery attempts for durability
- offline fallback queue / push provider for disconnected users

See [docs/SYSTEM_DESIGN.md](docs/SYSTEM_DESIGN.md) for full details and scaling math.

## Latency budget (local target)

For each message:

- event created timestamp is set when action is posted
- fan computes receive delay from `created_at`
- server tracks ack delay for latency metrics

Local traffic is small and should stay low-latency under normal conditions.

## Production scaling math shown in notes

- `20` gateway nodes x `5,000` concurrent sockets = `100,000` connections
- this architecture assumes sharding and Redis pub/sub + durable storage

## Known limits in MVP

- event storage, fan mappings, and ack state are in-memory
- one process for both API and fanout in this stage
- no auth, no message queue, no durable replay or push fallback
- local load tests validate method, not full capacity

## Acceptance notes for reviewers

- can run locally with `npm install`, `npm run dev`, `npm run build`, `npm run typecheck`
- `npm run test:smoke` validates target filtering and metric shape
- replay/idempotency behavior is intentionally simple and clearly documented
