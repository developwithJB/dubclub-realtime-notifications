import { randomUUID } from 'node:crypto'
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

interface CapperEventPayload {
  event_id: string
  type: CapperAction
  created_at: string
}

interface SeedState {
  cappers: Capper[]
  fans: FanSeed[]
}

interface ServerMessage {
  type: string
  payload?: {
    event_id?: string
    created_at?: string
    [key: string]: unknown
  }
}

interface SimulatedClient {
  fanId: string
  ws: WebSocket
  receivedMessages: number
  latenciesMs: number[]
  isConnected: boolean
}

const LOAD_TEST_CLIENTS = getNumericEnv('LOAD_TEST_CLIENTS', 100)
const LOAD_TEST_CAPPER_ID = process.env.LOAD_TEST_CAPPER_ID ?? 'capper_sam'
const LOAD_TEST_EVENT_COUNT = getNumericEnv('LOAD_TEST_EVENT_COUNT', 10)
const LOAD_TEST_WS_URL = process.env.LOAD_TEST_WS_URL ?? 'ws://localhost:4000'

if (!Number.isInteger(LOAD_TEST_CLIENTS) || LOAD_TEST_CLIENTS <= 0) {
  throw new Error('LOAD_TEST_CLIENTS must be a positive integer.')
}

if (!Number.isInteger(LOAD_TEST_EVENT_COUNT) || LOAD_TEST_EVENT_COUNT <= 0) {
  throw new Error('LOAD_TEST_EVENT_COUNT must be a positive integer.')
}

const wsUrl = new URL(LOAD_TEST_WS_URL)
const API_BASE = process.env.LOAD_TEST_API_BASE
  ? process.env.LOAD_TEST_API_BASE
  : `${wsUrl.protocol === 'wss:' ? 'https' : 'http'}://${wsUrl.host}`

const AVAILABLE_ACTIONS: CapperAction[] = [
  'new_pick',
  'odds_moved',
  'game_starting_soon',
  'result_posted',
  'reward_unlocked',
  'live_capper_note'
]

async function main() {
  const startedAt = Date.now()

  const state = await fetchSeedState()
  const capperId = resolveCapperId(LOAD_TEST_CAPPER_ID, state.cappers)

  if (!capperId) {
    throw new Error(`Unknown capper id: ${LOAD_TEST_CAPPER_ID}`)
  }

  console.log('\nLoad test config:')
  console.log(`- clients: ${LOAD_TEST_CLIENTS}`)
  console.log(`- event_count: ${LOAD_TEST_EVENT_COUNT}`)
  console.log(`- capper_id: ${capperId}`)
  console.log(`- ws_url: ${LOAD_TEST_WS_URL}`)

  let attemptedConnections = 0
  let successfulConnections = 0
  let failedConnections = 0
  let eventsSent = 0
  const clients: SimulatedClient[] = []

  for (let index = 0; index < LOAD_TEST_CLIENTS; index++) {
    const fanId = state.fans[index % state.fans.length]?.id ?? 'fan-unknown'
    attemptedConnections += 1
    const client = await createClient(fanId)

    if (client.isConnected) {
      successfulConnections += 1
    } else {
      failedConnections += 1
    }

    clients.push(client)
  }

  const followerFanIds = state.fans
    .filter((fan) => fan.followed_cappers.includes(capperId))
    .map((fan) => fan.id)

  const followerClients = clients.filter((client) => followerFanIds.includes(client.fanId) && client.isConnected)
  const expectedMessages = followerClients.length * LOAD_TEST_EVENT_COUNT

  for (let index = 0; index < LOAD_TEST_EVENT_COUNT; index++) {
    const action = AVAILABLE_ACTIONS[index % AVAILABLE_ACTIONS.length]
    const body = `Load test event ${index + 1} · ${randomUUID()}`
    const response = await fetch(`${API_BASE}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: action,
        capper_id: capperId,
        payload: {
          title: `${action.replace(/_/g, ' ')} #${index + 1}`,
          body
        }
      })
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Failed sending event #${index + 1}: ${response.status} ${text}`)
    }

    eventsSent += 1
    await delay(25)
  }

  const deadline = Date.now() + Math.max(5000, expectedMessages * 20)
  while (Date.now() < deadline) {
    const totalReceived = clients.reduce((sum, client) => sum + client.receivedMessages, 0)
    if (totalReceived >= expectedMessages) {
      break
    }
    await delay(50)
  }

  const allLatencies = clients.flatMap((client) => client.latenciesMs).sort((a, b) => a - b)

  const totalMessages = clients.reduce((sum, client) => sum + client.receivedMessages, 0)
  const nonFollowerMessages = clients
    .filter((client) => !followerFanIds.includes(client.fanId))
    .reduce((sum, client) => sum + client.receivedMessages, 0)

  if (totalMessages < expectedMessages) {
    throw new Error(`Load test missed deliveries: expected ${expectedMessages}, received ${totalMessages}`)
  }

  if (nonFollowerMessages > 0) {
    throw new Error(`Load test routed ${nonFollowerMessages} message(s) to non-followers.`)
  }

  const avgLatency = allLatencies.length === 0 ? 0 : Math.round(average(allLatencies))
  const p95Latency = allLatencies.length === 0 ? 0 : percentile(allLatencies, 0.95)
  const p99Latency = allLatencies.length === 0 ? 0 : percentile(allLatencies, 0.99)
  const totalDuration = Date.now() - startedAt

  console.log('\nLoad test report:')
  console.log(`attempted connections: ${attemptedConnections}`)
  console.log(`successful connections: ${successfulConnections}`)
  console.log(`failed connections: ${failedConnections}`)
  console.log(`events sent: ${eventsSent}`)
  console.log(`messages received: ${totalMessages}`)
  console.log(`messages expected: ${expectedMessages}`)
  console.log(`avg latency: ${avgLatency}ms`)
  console.log(`p95 latency: ${p95Latency}ms`)
  console.log(`p99 latency: ${p99Latency}ms`)
  console.log(`total duration: ${totalDuration}ms`)

  for (const client of clients) {
    if (client.isConnected) {
      client.ws.close()
    }
  }

  console.log('\nNote: this validates methodology and replay window behavior, not 100k concurrent capacity.')
}

async function createClient(fanId: string): Promise<SimulatedClient> {
  const ws = new WebSocket(LOAD_TEST_WS_URL)

  const client: SimulatedClient = {
    fanId,
    ws,
    receivedMessages: 0,
    latenciesMs: [],
    isConnected: false
  }

  await new Promise<void>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => {
      reject(new Error(`Timeout registering fan ${fanId}`))
    }, 2000)

    ws.once('open', () => {
      ws.send(JSON.stringify({ type: 'register', role: 'fan', fan_id: fanId }))
      client.isConnected = true
      clearTimeout(timeoutId)
      resolve()
    })

    ws.once('error', (error) => {
      clearTimeout(timeoutId)
      client.isConnected = false
      reject(error)
    })

    ws.once('close', () => {
      if (!client.isConnected) {
        clearTimeout(timeoutId)
        resolve()
      }
    })
  })
  
  ws.on('message', (raw) => {
    const msg = safeParse(raw.toString()) as ServerMessage | null
    if (!msg || msg.type !== 'capper_event') return

    const payload = msg.payload as CapperEventPayload | undefined
    if (!payload?.created_at || !payload?.event_id) return

    const latencyMs = Math.max(0, Date.now() - Date.parse(payload.created_at))
    client.receivedMessages += 1
    client.latenciesMs.push(latencyMs)
    ws.send(
      JSON.stringify({
        type: 'ack',
        event_id: payload.event_id,
        fan_id: fanId
      })
    )
  })

  return client
}

async function fetchSeedState(): Promise<SeedState> {
  const response = await fetch(`${API_BASE}/api/state`)
  if (!response.ok) {
    throw new Error(`Failed reading /api/state (${response.status})`)
  }
  return response.json() as Promise<SeedState>
}

function resolveCapperId(requested: string, cappers: Capper[]): string | null {
  const exact = cappers.find((capper) => capper.id === requested)
  if (exact) {
    return exact.id
  }

  const normalized = cappers.find((capper) => capper.id === requested.replace('_', '-'))
  if (normalized) {
    return normalized.id
  }

  const alias = cappers.find((capper) => capper.id === 'capper_sam')
  if (!alias && requested === 'capper_sam') {
    const sam = cappers.find((capper) => capper.name.toLowerCase().includes('sam'))
    return sam ? sam.id : null
  }

  if (alias) {
    return alias.id
  }

  return null
}

function getNumericEnv(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function percentile(sortedValues: number[], ratio: number): number {
  const index = Math.max(0, Math.min(Math.floor((sortedValues.length - 1) * ratio), sortedValues.length - 1))
  return sortedValues[index] ?? 0
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
