# Submission Note

I built this as a working system-design artifact rather than only a diagram because this challenge is about proof, not opinions.

The repo demonstrates a real capper-to-fan notification path end to end:
- capper actions are created in a capper operating system
- events carry audience segment, delivery channels, business goal, idempotency, and trust context
- events are fan-targeted by follow graph
- WebSocket clients receive updates in real time
- fans can tail a pick, review odds/confidence/result context, see capper record and ledger hints, and open a pick deep link
- delivery health separates followers, online fan targets, sessions, delivered fans, offline pending, replay sends, duplicate acks, and latency
- reconnect replay, publish idempotency, request-size caps, and idempotent acknowledgement reduce duplicate effects
- the optional Expo prototype shows the same trust inbox loop in React Native

I kept the first pass intentionally local and in-memory to preserve clarity and make it easy to inspect and run. This helps hiring managers evaluate architecture decisions quickly without setup overhead.

## Product readout

DubClub's opportunity is not only faster notifications. It is a better operating system for cappers and a higher-trust everyday experience for fans. This demo leans into that problem space:

- cappers publish urgent and lifecycle-aware moments, not generic broadcasts
- fans get actionable context without leaving the product loop
- DubClub can observe whether the business audience, live delivery path, and replay path are healthy
- responsible-play language is treated as product trust, while real compliance remains a production concern

## Stack alignment

DubClub's production stack includes Django/Go, PostgreSQL, TypeScript/Svelte, React Native, Docker, GitHub Actions, and Terraform. I used Node + TypeScript here to make the demo fast to run and easy to inspect, not because the boundary must be Node in production. The same service boundary maps cleanly to a Go gateway/fanout service or Django API backed by Postgres delivery records.

The repository includes:
- GitHub Actions for install/typecheck/build/smoke validation
- a Dockerfile for backend packaging
- an optional `mobile/` Expo slice for the React Native fan experience

The intentional local limits are:
- one Node process
- in-memory fan maps and replay window
- seeded auth/follow/subscription state
- no auth or hardened production deployment
- no real payment, moderation, or compliance workflows
- no durable offline push path

The project maps cleanly to production by adding Redis presence/fan indexes, gateway fanout service splitting, event bus fanout, Postgres durability, scoped publish idempotency, subscription entitlements, and mobile push fallback.

## AI-first engineering workflow

I treated the submission as an agent-assisted engineering loop:
- used agents to pressure-test the role description against the app surface
- generated and refined the smoke/load test coverage around follower-only delivery
- tightened load tests so replay-buffer events from prior runs do not inflate current-run delivery counts
- added checks for invalid cappers, invalid follow updates, duplicate acks, and reconnect replay
- reviewed the architecture docs for explicit MVP boundaries and production migration paths
- manually verified typecheck, production build, smoke routing, and local load behavior

Next I would add:
- signed fan/session authentication
- distributed load generation and reconnect stress in CI
- durable replay cursor storage and offline queueing
- deeper observability including reconnect gaps and per-capper hot-path metrics
