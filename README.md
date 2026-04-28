# Dub Club Realtime Notifications (MVP)

This repo is an open-source **system-design demo project** for a real-time notification platform.

You are looking at a local demo for a sports creator platform where expert cappers send updates to fans in real time:

- New picks
- Odds movement alerts
- Game-start reminders
- Results
- Rewards and notes

The MVP proves the core mechanics behind a Staff-level full-stack design challenge:

1. low-latency fanout
2. targeted delivery by follow graph
3. reliable delivery acknowledgements
4. observability signals for latency and delivery health

---

## What this project is

`dubclub-realtime-notifications` is a TypeScript demo with:

- A `ws`-based Node WebSocket backend
- A React + Vite frontend dashboard
- Seeded demo entities (2 cappers, 6 fans)
- A control room for capper actions
- Simulated fan clients inside the UI
- Live metrics + event log

The result is intentionally demo-first: small, readable, and easy to explain in an interview.

## Why this exists

The challenge is to show how you would design a system that supports many simultaneous fan connections and near-instant fanout while keeping the architecture understandable.

In this first pass we:

- Keep everything local and fast to run
- Optimize for a polished, working demonstration
- Then document the exact production path for 100k+ concurrent sockets

## Quick start

### 1) Install

```bash
npm install
```

### 2) Run

```bash
npm run dev
```

This starts:

- backend server at `http://localhost:4000`
- frontend app at `http://localhost:5173`

Open the browser at `http://localhost:5173`.

## What the demo shows

### Capper Control Room

- Seeded cappers:
  - SharpSide Sam
  - Courtside Kelly
- Action buttons for:
  - Post New Pick
  - Odds Moved
  - Game Starting Soon
  - Result Posted
  - Reward Unlocked
  - Live Capper Note

### Simulated Fan Clients

- 6 seeded fans with real-time WebSocket connections
- Each fan has:
  - status indicator (online / reconnecting / disconnected)
  - followed capper list
  - inbox of notifications
  - latest observed latency
  - highlight when a push arrives

### Fan targeting behavior

A notification is only sent to fan connections that follow that capper.
Fans that do not follow the capper do not receive the notification.

### Live metrics

- active connections
- notifications sent
- notifications delivered
- average latency
- p95 latency
- last event type

### Event log

Every action is captured in a rolling event log with event id, capper, recipients, and delivery progress.

## Local architecture

```text
Control Room UI  --->  HTTP API (/api/events)
                         |
                         v
                 WebSocket server (Node + ws)
                  | fan socket map in memory |
                  +-> fan sockets receive capper events
                  +-> control-room websocket gets live metrics + event log updates
```

- Fan follow relationships are held in-memory
- Delivery acknowledgements flow back from fan sockets
- Server computes latency based on ack round-trip

## From MVP to production

This MVP is intentionally minimal. For production at scale, we introduce:

- Redis for connection presence + pub/sub fanout
- Postgres for durable notification and delivery metadata
- Horizontal websocket gateway nodes
- Replay buffers + reconnect handling for missed messages
- Monitoring + alerting stack

See `docs/SYSTEM_DESIGN.md` for the full migration path.

## Latency budget (local target)

For this demo, we measure end-to-end latency with ack timestamps.

- `created_at`: time capper action created
- fan computes receive delay from created timestamp
- server measures delivered-to-ack delay as delivery latency

Our local target is sub-100ms in happy path for short payloads and small fan counts.

## Scripts

From repository root:

- `npm run dev`
- `npm run build`
- `npm run typecheck`

## Next steps

- Add persistence and authentication
- Add replay + offline queue
- Add synthetic load generator for 100k fan connections
- Add gateway sharding and load-balancer aware session handling
- Add failure simulation (socket churn, slow consumers, partial outages)

