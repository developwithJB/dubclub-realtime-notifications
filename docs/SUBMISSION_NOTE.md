# Submission Note

I built this as a working system-design artifact rather than only a diagram because this challenge is about proof, not opinions.

The repo demonstrates a real capper-to-fan notification path end to end:
- capper actions are created in a control room
- events are fan-targeted by follow graph
- WebSocket clients receive updates in real time
- fans can tail a pick, review odds/confidence/result context, and open a pick deep link
- delivery latency and delivery counts are measured live
- reconnect replay and idempotent acknowledgement reduce duplicate effects
- the optional Expo prototype shows the same fan inbox loop in React Native

I kept the first pass intentionally local and in-memory to preserve clarity and make it easy to inspect and run. This helps hiring managers evaluate architecture decisions quickly without setup overhead.

## Stack alignment

DubClub's production stack includes Django/Go, PostgreSQL, TypeScript/Svelte, React Native, Docker, GitHub Actions, and Terraform. I used Node + TypeScript here to make the demo fast to run and easy to inspect, not because the boundary must be Node in production. The same service boundary maps cleanly to a Go gateway/fanout service or Django API backed by Postgres delivery records.

The repository includes:
- GitHub Actions for install/typecheck/build/smoke validation
- a Dockerfile for backend packaging
- an optional `mobile/` Expo slice for the React Native fan experience

The intentional local limits are:
- one Node process
- in-memory fan maps and replay window
- no auth or hardened production deployment
- no durable offline push path

The project maps cleanly to production by adding Redis presence/fan indexes, gateway fanout service splitting, event bus fanout, Postgres durability, and mobile push fallback.

## AI-first engineering workflow

I treated the submission as an agent-assisted engineering loop:
- used agents to pressure-test the role description against the app surface
- generated and refined the smoke/load test coverage around follower-only delivery
- reviewed the architecture docs for explicit MVP boundaries and production migration paths
- manually verified typecheck, production build, smoke routing, and local load behavior

Next I would add:
- signed fan/session authentication
- distributed load generation and reconnect stress in CI
- durable replay cursor storage and offline queueing
- deeper observability including reconnect gaps and per-capper hot-path metrics
