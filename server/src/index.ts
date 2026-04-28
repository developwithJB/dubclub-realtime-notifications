import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'

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
  role: string
}

interface FanSeed {
  id: string
  name: string
  avatar: string
  followed_cappers: string[]
}

interface FanNotificationPayload {
  title: string
  body: string
}

interface CapperEvent {
  event_id: string
  type: CapperAction
  capper_id: string
  capper_name: string
  payload: FanNotificationPayload
  created_at: string
  sent_at: string
  delivered_at: string | null
  latency_ms: number | null
}

interface EventLogEntry extends CapperEvent {
  recipient_count: number
  delivered_count: number
}

interface ClientMetrics {
  active_connections: number
  notifications_sent: number
  notifications_delivered: number
  average_latency_ms: number
  p95_latency_ms: number
  last_event_type: string
  last_updated_at: string
}

interface ClientConnection {
  role: 'fan' | 'control' | 'unknown'
  fan_id?: string
  fan_name?: string
  is_alive: boolean
  last_pong_at: number
}

interface ClientMessage {
  type: string
  [key: string]: unknown
}

const PORT = Number(process.env.PORT ?? 4000)
const HEARTBEAT_INTERVAL_MS = 10_000
const MAX_EVENT_LOG = 150
const MAX_LATENCY_SAMPLES = 400

const CAPPERS: Capper[] = [
  { id: 'capper-sharpside-sam', name: 'SharpSide Sam', role: 'MLB / NBA Cappers' },
  { id: 'capper-courtside-kelly', name: 'Courtside Kelly', role: 'Live NBA + CFB Cappers' }
]

const CAPPERS_BY_ID = new Map(CAPPERS.map((capper) => [capper.id, capper]))

const FANS: FanSeed[] = [
  { id: 'fan-ava', name: 'Ava A.', avatar: 'AA', followed_cappers: ['capper-sharpside-sam'] },
  { id: 'fan-ben', name: 'Ben B.', avatar: 'BB', followed_cappers: ['capper-courtside-kelly'] },
  { id: 'fan-cara', name: 'Cara C.', avatar: 'CC', followed_cappers: ['capper-sharpside-sam', 'capper-courtside-kelly'] },
  { id: 'fan-drew', name: 'Drew D.', avatar: 'DD', followed_cappers: ['capper-sharpside-sam'] },
  { id: 'fan-emma', name: 'Emma E.', avatar: 'EE', followed_cappers: [] },
  { id: 'fan-finn', name: 'Finn F.', avatar: 'FF', followed_cappers: ['capper-courtside-kelly'] }
]

const FAN_FOLLOWS = new Map<string, Set<string>>(
  FANS.map((fan) => [fan.id, new Set(fan.followed_cappers)])
)

const fanConnections = new Map<string, WebSocket>()
const controlConnections = new Set<WebSocket>()
const connectionState = new Map<WebSocket, ClientConnection>()
const pendingAcks = new Map<string, Map<string, number>>()

const eventLog: EventLogEntry[] = []
const latencySamples: number[] = []

let notificationsSent = 0
let notificationsDelivered = 0

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  const origin = request.headers.origin
  response.setHeader('Access-Control-Allow-Origin', origin ?? '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  const url = new URL(request.url ?? '/', `http://localhost:${PORT}`)

  if (url.pathname === '/api/state' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        cappers: CAPPERS,
        fans: FANS,
        metrics: getMetricsSnapshot(),
        event_log: eventLog.slice().reverse()
      })
    )
    return
  }

  if (url.pathname === '/api/metrics' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(getMetricsSnapshot()))
    return
  }

  if (url.pathname === '/api/events' && request.method === 'POST') {
    let body: Record<string, unknown>
    try {
      body = await readRequestBody(request)
    } catch {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Invalid JSON payload.' }))
      return
    }
    const { type, capper_id, payload } = body as {
      type: CapperAction
      capper_id: string
      payload: FanNotificationPayload
    }

    if (!isValidAction(type) || !capper_id || !payload?.title || !payload?.body) {
      response.writeHead(400, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Invalid event payload.' }))
      return
    }

    const capper = CAPPERS_BY_ID.get(capper_id)
    if (!capper) {
      response.writeHead(404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'Capper not found.' }))
      return
    }

    const event = createAndBroadcastEvent(capper, payload, type)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, event }))
    return
  }

  if (url.pathname === '/healthz' && request.method === 'GET') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }

  response.writeHead(404, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify({ error: 'Not found.' }))
})

const wss = new WebSocketServer({ server })

wss.on('connection', (socket: WebSocket) => {
  connectionState.set(socket, {
    role: 'unknown',
    is_alive: true,
    last_pong_at: Date.now()
  })
  broadcastMetrics()

  socket.on('message', (chunk: string | Buffer | ArrayBuffer) => {
    let message: ClientMessage
    try {
      message = JSON.parse(chunk.toString()) as ClientMessage
    } catch {
      return
    }

    const context = connectionState.get(socket)
    if (!context) return

    switch (message.type) {
      case 'register': {
        if (message.role === 'control') {
          context.role = 'control'
          controlConnections.add(socket)
          send(socket, {
            type: 'registered',
            payload: {
              kind: 'control',
              metrics: getMetricsSnapshot(),
              event_log: eventLog.slice().reverse()
            }
          })
          return
        }

        if (message.role === 'fan') {
          const fanId = String(message.fan_id ?? '')
          const fan = FANS.find((entry) => entry.id === fanId)
          if (!fan) {
            send(socket, { type: 'error', message: 'Unknown fan id.' })
            socket.close(4001, 'Invalid fan id')
            return
          }

          context.role = 'fan'
          context.fan_id = fan.id
          context.fan_name = fan.name
          fanConnections.get(fan.id)?.close(4002, 'Replacing previous connection')
          fanConnections.set(fan.id, socket)

          send(socket, {
            type: 'registered',
            payload: {
              kind: 'fan',
              fan_id: fan.id,
              followed_cappers: Array.from(FAN_FOLLOWS.get(fan.id) ?? []),
              cappers: CAPPERS
            }
          })
          broadcastMetrics()
          return
        }
        return
      }
      case 'follow_update': {
        if (context.role !== 'fan' || !context.fan_id) return
        const next = message.followed_cappers
        if (Array.isArray(next)) {
          FAN_FOLLOWS.set(context.fan_id, new Set(next.map((value) => String(value))))
          send(socket, {
            type: 'follow_updated',
            fan_id: context.fan_id,
            followed_cappers: Array.from(FAN_FOLLOWS.get(context.fan_id) ?? [])
          })
          broadcastControlStream()
        }
        return
      }
      case 'ack': {
        if (!context.fan_id || !message.event_id) return
        const fanId = context.fan_id
        const eventId = String(message.event_id)
        const perEvent = pendingAcks.get(eventId)
        if (!perEvent) return

        const sentAt = perEvent.get(fanId)
        if (!sentAt) return

        const now = Date.now()
        const latency = now - sentAt
        perEvent.delete(fanId)
        if (perEvent.size === 0) {
          pendingAcks.delete(eventId)
        }

        const logIndex = eventLog.findIndex((entry) => entry.event_id === eventId)
        if (logIndex >= 0) {
          eventLog[logIndex].delivered_count += 1
          if (!eventLog[logIndex].delivered_at) {
            eventLog[logIndex].delivered_at = new Date(now).toISOString()
          }
          eventLog[logIndex].latency_ms = latency
        }

        latencySamples.push(latency)
        if (latencySamples.length > MAX_LATENCY_SAMPLES) {
          latencySamples.shift()
        }

        notificationsDelivered += 1

        broadcastDeliveryUpdate({
          type: 'delivery_update',
          event_id: eventId,
          fan_id: fanId,
          latency_ms: latency,
          delivered_at: new Date(now).toISOString(),
          delivered_count: eventLog[logIndex] ? eventLog[logIndex].delivered_count : 0
        })
        broadcastMetrics()
        return
      }
      case 'pong': {
        context.last_pong_at = Date.now()
        context.is_alive = true
        return
      }
      default:
        return
    }
  })

  socket.on('close', () => {
    const context = connectionState.get(socket)
    if (context?.role === 'fan' && context.fan_id) {
      fanConnections.delete(context.fan_id)
    }
    if (context?.role === 'control') {
      controlConnections.delete(socket)
    }
    connectionState.delete(socket)
    broadcastMetrics()
  })
})

setInterval(() => {
  const now = Date.now()
  for (const entry of connectionState.entries()) {
    const [socket, context] = entry as [WebSocket, ClientConnection]
    send(socket, { type: 'ping', at: now })
    if (!context.is_alive || now - context.last_pong_at > HEARTBEAT_INTERVAL_MS * 2.5) {
      socket.terminate()
      continue
    }
    context.is_alive = false
  }
}, HEARTBEAT_INTERVAL_MS)

function createAndBroadcastEvent(
  capper: Capper,
  payload: FanNotificationPayload,
  type: CapperAction
): EventLogEntry {
  const now = new Date().toISOString()
  const event: CapperEvent = {
    event_id: randomUUID(),
    type,
    capper_id: capper.id,
    capper_name: capper.name,
    payload,
    created_at: now,
    sent_at: now,
    delivered_at: null,
    latency_ms: null
  }

  const followers = FANS.filter((fan) => (FAN_FOLLOWS.get(fan.id) ?? new Set()).has(capper.id)).map(
    (fan) => fan.id
  )
  const recipients = followers.filter((fanId) => fanConnections.has(fanId))

  let sentCount = 0
  const pendingForEvent = new Map<string, number>()

  for (const fanId of recipients) {
    const socket = fanConnections.get(fanId)
    if (!socket) continue

    send(socket, {
      type: 'capper_event',
      payload: event
    })
    pendingForEvent.set(fanId, Date.now())
    sentCount += 1
  }

  notificationsSent += sentCount

  const logEntry: EventLogEntry = {
    ...event,
    recipient_count: followers.length,
    delivered_count: 0
  }

  if (pendingForEvent.size > 0) {
    pendingAcks.set(logEntry.event_id, pendingForEvent)
  }

  eventLog.unshift(logEntry)
  if (eventLog.length > MAX_EVENT_LOG) {
    eventLog.pop()
  }

  broadcastControlStream()
  return logEntry
}

function broadcastControlStream() {
  const snapshot = {
    type: 'control_stream',
    event_log: eventLog.slice(0, 50),
    metrics: getMetricsSnapshot()
  }
  for (const socket of controlConnections) {
    send(socket, snapshot)
  }
}

function broadcastDeliveryUpdate(payload: Record<string, unknown>) {
  for (const socket of controlConnections) {
    send(socket, payload)
  }
}

function broadcastMetrics() {
  broadcastControlStream()
}

function getMetricsSnapshot(): ClientMetrics {
  const cleanLatencies = latencySamples.length > 0 ? [...latencySamples].sort((a, b) => a - b) : []
  const averageLatency =
    latencySamples.length === 0
      ? 0
      : Math.round(latencySamples.reduce((total, value) => total + value, 0) / latencySamples.length)

  const p95Index = Math.floor((cleanLatencies.length - 1) * 0.95)
  const p95 = cleanLatencies.length === 0 ? 0 : cleanLatencies[Math.max(p95Index, 0)]
  const hasEvent = eventLog[0]

  return {
    active_connections: fanConnections.size + controlConnections.size,
    notifications_sent: notificationsSent,
    notifications_delivered: notificationsDelivered,
    average_latency_ms: averageLatency,
    p95_latency_ms: p95,
    last_event_type: hasEvent ? hasEvent.type : 'none',
    last_updated_at: new Date().toISOString()
  }
}

function send(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload))
  }
}

function isValidAction(value: string): value is CapperAction {
  return [
    'new_pick',
    'odds_moved',
    'game_starting_soon',
    'result_posted',
    'reward_unlocked',
    'live_capper_note'
  ].includes(value)
}

function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
    })
    req.on('end', () => {
      if (!data) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('invalid-json'))
      }
    })
    req.on('error', reject)
  })
}

server.listen(PORT, () => {
  const resolvedCappers = CAPPERS.map((capper) => capper.id).join(', ')
  const resolvedFans = FANS.map((fan) => `${fan.name} (${fan.id})`).join(', ')
  console.log(`DubClub WebSocket server running on http://localhost:${PORT}`)
  console.log(`Cappers: ${resolvedCappers}`)
  console.log(`Seeded Fans: ${resolvedFans}`)
})

export {}
