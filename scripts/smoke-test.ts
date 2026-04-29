import process from 'node:process'
import { WebSocket } from 'ws'
import { setTimeout as delay } from 'node:timers/promises'

type CapperAction =
  | 'new_pick'
  | 'odds_moved'
  | 'game_starting_soon'
  | 'result_posted'
  | 'reward_unlocked'
  | 'live_capper_note'

interface Capper {
  id: string
  name: string
}

interface FanSeed {
  id: string
  name: string
  avatar: string
  followed_cappers: string[]
}

interface SeedState {
  cappers: Capper[]
  fans: FanSeed[]
}

interface ServerMessage {
  type: string
  message?: string
  replayed?: boolean
  payload?: {
    event_id?: string
    [key: string]: unknown
  }
}

interface FanSocket {
  fan: FanSeed
  ws: WebSocket
  received: string[]
  replayed: string[]
  errors: string[]
}

interface Metrics {
  average_latency_ms: number
  p95_latency_ms: number
  active_connections: number
  notifications_sent: number
  notifications_delivered: number
  replayed_deliveries: number
  duplicate_acks_ignored: number
  offline_pending: number
}

const API_BASE = process.env.SMOKE_API_BASE ?? 'http://localhost:4000'
const WS_URL = process.env.SMOKE_WS_URL ?? 'ws://localhost:4000'
const CAPPER_ID = process.env.SMOKE_CAPPER_ID

async function main() {
  const state = await fetchSeedState()
  const selectedCapper = resolveCapper(CAPPER_ID, state.cappers)

  if (!selectedCapper) {
    throw new Error('No capper available to publish smoke event.')
  }

  const fanClients = await connectFans(state.fans)
  let event: { event_id: string } | null = null
  let followerFans: FanSocket[] = []

  try {
    event = await publishSmokeEvent(selectedCapper.id)
    followerFans = fanClients.filter((fan) => fan.fan.followed_cappers.includes(selectedCapper.id))
    const nonFollowerFans = fanClients.filter((fan) => !fan.fan.followed_cappers.includes(selectedCapper.id))

    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const allFollowersReceived = followerFans.every((fan) => fan.received.includes(event.event_id))
      const allNonFollowersMissed = nonFollowerFans.every((fan) => !fan.received.includes(event.event_id))
      if (allFollowersReceived && allNonFollowersMissed) {
        break
      }
      await delay(25)
    }

    const missingFollowers = followerFans
      .filter((fan) => !fan.received.includes(event.event_id))
      .map((fan) => fan.fan.id)

    if (missingFollowers.length > 0) {
      throw new Error(`Follower fans did not receive event: ${missingFollowers.join(', ')}`)
    }

    const unexpectedFans = nonFollowerFans
      .filter((fan) => fan.received.includes(event.event_id))
      .map((fan) => fan.fan.id)

    if (unexpectedFans.length > 0) {
      throw new Error(`Non-follower fans incorrectly received event: ${unexpectedFans.join(', ')}`)
    }

    const duplicateMetricStart = (await fetchMetrics()).duplicate_acks_ignored
    followerFans[0]?.ws.send(JSON.stringify({ type: 'ack', event_id: event.event_id, fan_id: followerFans[0].fan.id }))
    await waitForMetricAtLeast('duplicate_acks_ignored', duplicateMetricStart + 1)

    const metrics = await fetchMetrics()
    if (!Number.isFinite(metrics.average_latency_ms) || !Number.isFinite(metrics.p95_latency_ms)) {
      throw new Error('Latency metrics were not numeric.')
    }

    for (const key of [
      'active_connections',
      'notifications_sent',
      'notifications_delivered',
      'replayed_deliveries',
      'duplicate_acks_ignored',
      'offline_pending'
    ] as const) {
      if (!Number.isFinite(metrics[key])) {
        throw new Error(`Metric ${key} is not numeric.`)
      }
    }
  } finally {
    for (const fanClient of fanClients) {
      fanClient.ws.close()
    }
    await delay(150)
  }

  if (!event || followerFans.length === 0) {
    throw new Error('Smoke setup failed before edge-case checks.')
  }

  await assertInvalidCapperRejected()
  await assertPublishIdempotency(selectedCapper.id)
  await assertUnknownFollowUpdateRejected(followerFans[0].fan)
  await assertReplayIsolation(selectedCapper.id, followerFans[0].fan, event.event_id)

  console.log('Smoke test passed: targeting, metrics, publish/ack idempotency, validation, and replay checks succeeded.')
  console.log(`Published event ${event.event_id} to ${followerFans.length} follower(s)`)
}

async function connectFans(fans: FanSeed[]): Promise<FanSocket[]> {
  return Promise.all(
    fans.map(async (fan) => {
      const ws = new WebSocket(WS_URL)
      const state: FanSocket = { fan, ws, received: [], replayed: [], errors: [] }

      await new Promise<void>((resolve, reject) => {
        let closed = false

        const timeoutId = globalThis.setTimeout(() => {
          if (!closed) {
            closed = true
            reject(new Error(`Fan ${fan.id} failed to register`))
          }
        }, 2500)

        ws.once('open', () => {
          ws.send(JSON.stringify({ type: 'register', role: 'fan', fan_id: fan.id }))
        })

        ws.on('message', (raw) => {
          const msg = safeParse(raw.toString()) as ServerMessage | null
          if (!msg) return

          if (msg.type === 'registered') {
            if (!closed) {
              closed = true
              clearTimeout(timeoutId)
              resolve()
            }
            return
          }

          const eventId = msg.payload?.event_id
          if (msg.type === 'capper_event' && typeof eventId === 'string') {
            state.received.push(eventId)
            if (msg.replayed) {
              state.replayed.push(eventId)
            }
            ws.send(JSON.stringify({ type: 'ack', event_id: eventId, fan_id: fan.id }))
            return
          }

          if (msg.type === 'error' && typeof msg.message === 'string') {
            state.errors.push(msg.message)
          }
        })

        ws.once('error', (error) => {
          if (!closed) {
            closed = true
            clearTimeout(timeoutId)
            reject(error)
          }
        })

        ws.once('close', () => {
          if (!closed) {
            closed = true
            clearTimeout(timeoutId)
            reject(new Error(`Fan ${fan.id} closed before registration`))
          }
        })
      })

      return state
    })
  )
}

async function connectFan(fan: FanSeed, lastSeenEventId?: string): Promise<FanSocket> {
  const [socket] = await connectFansWithCursor([{ fan, lastSeenEventId }])
  return socket
}

async function connectFansWithCursor(
  entries: Array<{ fan: FanSeed; lastSeenEventId?: string }>
): Promise<FanSocket[]> {
  return Promise.all(
    entries.map(async ({ fan, lastSeenEventId }) => {
      const ws = new WebSocket(WS_URL)
      const state: FanSocket = { fan, ws, received: [], replayed: [], errors: [] }

      await new Promise<void>((resolve, reject) => {
        let closed = false
        const timeoutId = globalThis.setTimeout(() => {
          if (!closed) {
            closed = true
            reject(new Error(`Fan ${fan.id} failed to register`))
          }
        }, 2500)

        ws.once('open', () => {
          ws.send(
            JSON.stringify({
              type: 'register',
              role: 'fan',
              fan_id: fan.id,
              last_seen_event_id: lastSeenEventId
            })
          )
        })

        ws.on('message', (raw) => {
          const msg = safeParse(raw.toString()) as ServerMessage | null
          if (!msg) return

          if (msg.type === 'registered') {
            if (!closed) {
              closed = true
              clearTimeout(timeoutId)
              resolve()
            }
            return
          }

          const eventId = msg.payload?.event_id
          if (msg.type === 'capper_event' && typeof eventId === 'string') {
            state.received.push(eventId)
            if (msg.replayed) {
              state.replayed.push(eventId)
            }
            ws.send(JSON.stringify({ type: 'ack', event_id: eventId, fan_id: fan.id }))
            return
          }

          if (msg.type === 'error' && typeof msg.message === 'string') {
            state.errors.push(msg.message)
          }
        })

        ws.once('error', (error) => {
          if (!closed) {
            closed = true
            clearTimeout(timeoutId)
            reject(error)
          }
        })
      })

      return state
    })
  )
}

async function publishSmokeEvent(capperId: string, idempotencyKey?: string): Promise<{ event_id: string }> {
  const response = await fetch(`${API_BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new_pick' as CapperAction,
      capper_id: capperId,
      idempotency_key: idempotencyKey,
      payload: {
        title: 'Smoke test event',
        body: 'Smoke test payload sent by automated script.'
      }
    })
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(`Publish failed: ${response.status} ${message}`)
  }

  const body = (await response.json()) as { event: { event_id: string } }
  return body.event
}

async function assertInvalidCapperRejected(): Promise<void> {
  const response = await fetch(`${API_BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new_pick' as CapperAction,
      capper_id: 'capper-does-not-exist',
      payload: {
        title: 'Invalid capper smoke event',
        body: 'This should be rejected.'
      }
    })
  })

  if (response.status !== 404) {
    throw new Error(`Invalid capper should return 404, received ${response.status}`)
  }
}

async function assertPublishIdempotency(capperId: string): Promise<void> {
  const key = `smoke-idempotency-${Date.now()}`
  const first = await publishSmokeEvent(capperId, key)
  const second = await publishSmokeEvent(capperId, key)

  if (first.event_id !== second.event_id) {
    throw new Error('Publish idempotency key did not return the existing event.')
  }
}

async function assertUnknownFollowUpdateRejected(fan: FanSeed): Promise<void> {
  const client = await connectFan(fan)
  try {
    client.ws.send(JSON.stringify({ type: 'follow_update', followed_cappers: ['capper-does-not-exist'] }))
    const deadline = Date.now() + 1500
    while (Date.now() < deadline) {
      if (client.errors.some((error) => error.includes('Unknown capper id'))) {
        return
      }
      await delay(25)
    }
    throw new Error('Unknown follow update was not rejected.')
  } finally {
    client.ws.close()
    await delay(100)
  }
}

async function assertReplayIsolation(capperId: string, fan: FanSeed, lastSeenEventId: string): Promise<void> {
  const missedEvent = await publishSmokeEvent(capperId)
  const replayClient = await connectFan(fan, lastSeenEventId)
  try {
    const deadline = Date.now() + 2500
    while (Date.now() < deadline) {
      if (replayClient.replayed.includes(missedEvent.event_id)) {
        return
      }
      await delay(25)
    }
    throw new Error(`Reconnect replay did not deliver missed event ${missedEvent.event_id}.`)
  } finally {
    replayClient.ws.close()
    await delay(100)
  }
}

async function waitForMetricAtLeast(key: keyof Metrics, target: number): Promise<void> {
  const deadline = Date.now() + 1500
  while (Date.now() < deadline) {
    const latest = await fetchMetrics()
    if (latest[key] >= target) {
      return
    }
    await delay(25)
  }
  throw new Error(`Metric ${key} did not reach ${target}.`)
}

async function fetchSeedState(): Promise<SeedState> {
  const response = await fetch(`${API_BASE}/api/state`)
  if (!response.ok) {
    throw new Error(`State fetch failed: ${response.status}`)
  }

  return response.json() as Promise<SeedState>
}

async function fetchMetrics(): Promise<Metrics> {
  const response = await fetch(`${API_BASE}/api/metrics`)
  if (!response.ok) {
    throw new Error(`Metrics fetch failed: ${response.status}`)
  }

  return response.json() as Promise<Metrics>
}

function resolveCapper(requested: string | undefined, cappers: Capper[]): Capper | null {
  if (requested) {
    const byId = cappers.find((capper) => capper.id === requested)
    if (byId) return byId

    const normalized = requested.replace('_', '-')
    return cappers.find((capper) => capper.id === normalized) ?? null
  }

  return cappers[0] ?? null
}

function safeParse(raw: string) {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
