# Submission Note

I built this as a working system-design artifact rather than only a diagram because this challenge is about proof, not opinions.

The repo demonstrates a real capper-to-fan notification path end to end:
- capper actions are created in a control room
- events are fan-targeted by follow graph
- WebSocket clients receive updates in real time
- delivery latency and delivery counts are measured live
- reconnect replay and idempotent acknowledgement reduce duplicate effects

I kept the first pass intentionally local and in-memory to preserve clarity and make it easy to inspect and run. This helps hiring managers evaluate architecture decisions quickly without setup overhead.

The intentional local limits are:
- one Node process
- in-memory fan maps and replay window
- no auth or hardened production deployment
- no durable offline push path

The project maps cleanly to production by adding Redis presence/fan indexes, gateway fanout service splitting, event bus fanout, Postgres durability, and mobile push fallback.

Next I would add:
- signed fan/session authentication
- distributed load generation and reconnect stress in CI
- durable replay cursor storage and offline queueing
- deeper observability including reconnect gaps and per-capper hot-path metrics
