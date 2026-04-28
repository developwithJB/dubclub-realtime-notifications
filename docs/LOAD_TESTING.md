# Load Testing and Validation

## What these scripts measure

### `npm run load:test`

- attempts and succeeds fan socket connections
- sends a configurable number of events
- records message receive counts
- measures end-to-end receive latency from `created_at`
- reports average, p95, and p99 latency
- reports total wall-clock duration

### `npm run test:smoke`

- validates at least one capper event dispatch
- verifies only follower sockets receive the event
- verifies non-followers receive nothing for that event
- verifies metrics endpoint returns numeric latency counters

## Quick command line

```bash
# quick smoke
npm run test:smoke

# local load run
npm run load:test

# faster local loops
npm run load:test:small
npm run load:test:medium
```

## Environment variables

### Load test

- `LOAD_TEST_CLIENTS` (default `100`)
- `LOAD_TEST_CAPPER_ID` (default `capper_sam`)
- `LOAD_TEST_EVENT_COUNT` (default `10`)
- `LOAD_TEST_WS_URL` (default `ws://localhost:4000`)
- `LOAD_TEST_API_BASE` (optional; derived from WS URL if omitted)

### Smoke test

- `SMOKE_API_BASE` (default `http://localhost:4000`)
- `SMOKE_WS_URL` (default `ws://localhost:4000`)
- `SMOKE_CAPPER_ID` (optional, defaults to first seed capper)

## Why this does not prove 100k locally

Local scripts are useful for method validation, regression confidence, and latency visibility.

They do **not** prove 100k fan capacity because:

- a single machine has limited socket and network headroom
- one-process in-memory state does not model gateway distribution
- no distributed fan source for full fanout amplification

## Distributed test path for 100k validation

A production-grade validation would run load generators from multiple hosts:

1. stand up a target deployment (20 gateway nodes in challenge sizing)
2. run thousands of fan simulators across multiple containers/VMs
3. route through realistic load balancer + DNS + reconnect patterns
4. capture p95/p99 and percent of failed/successful reconnects
5. verify replay gap handling and dedupe under repeated disconnects

## Interpretation notes

- p95/p99 here should be interpreted as local latency estimates.
- if averages look suspiciously low with large client counts, likely due to client reuse or short retry windows in the local setup.
- this project intentionally stays in-memory first; the docs call out what to change for production durability.
