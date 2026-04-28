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
  payload?: {
    event_id?: string
    [key: string]: unknown
  }
}

interface FanSocket {
  fan: FanSeed
  ws: WebSocket
  received: string[]
}

interface Metrics {
  average_latency_ms: number
  p95_latency_ms: number
  active_connections: number
  notifications_sent: number
  notifications_delivered: number
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
  try {
    const event = await publishSmokeEvent(selectedCapper.id)
    const followerFans = fanClients.filter((fan) => fan.fan.followed_cappers.includes(selectedCapper.id))
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

    const metrics = await fetchMetrics()
    if (!Number.isFinite(metrics.average_latency_ms) || !Number.isFinite(metrics.p95_latency_ms)) {
      throw new Error('Latency metrics were not numeric.')
    }

    for (const key of ['active_connections', 'notifications_sent', 'notifications_delivered'] as const) {
      if (!Number.isFinite(metrics[key])) {
        throw new Error(`Metric ${key} is not numeric.`)
      }
    }

    console.log('Smoke test passed: fan targeting and metric checks succeeded.')
    console.log(`Published event ${event.event_id} to ${followerFans.length} follower(s)`)
  } finally {
    for (const fanClient of fanClients) {
      fanClient.ws.close()
    }
    await delay(150)
  }
}

async function connectFans(fans: FanSeed[]): Promise<FanSocket[]> {
  return Promise.all(
    fans.map(async (fan) => {
      const ws = new WebSocket(WS_URL)
      const state: FanSocket = { fan, ws, received: [] }

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
            ws.send(JSON.stringify({ type: 'ack', event_id: eventId, fan_id: fan.id }))
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

async function publishSmokeEvent(capperId: string): Promise<{ event_id: string }> {
  const response = await fetch(`${API_BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'new_pick' as CapperAction,
      capper_id: capperId,
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
