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

type AudienceSegment = 'all_followers' | 'premium_subscribers' | 'high_intent_fans' | 'at_risk_fans'
type DeliveryChannel = 'in_app' | 'push' | 'email' | 'discord'
type BusinessGoal = 'time_sensitive_pick' | 'retention' | 'conversion' | 'trust' | 'reward'

interface Capper {
  id: string
  name: string
  role: string
  record: string
  specialty: string
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
  pick_id?: string
  market?: string
  line?: string
  odds?: string
  confidence?: number
  status?: 'open' | 'moved' | 'graded' | 'reward'
  result?: string
  reward?: string
  deep_link?: string
  trust_context?: {
    capper_record?: string
    pick_lifecycle?: string
    result_ledger?: string
    responsible_note?: string
  }
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
  audience_segment: AudienceSegment
  delivery_channels: DeliveryChannel[]
  business_goal: BusinessGoal
  idempotency_key?: string
}

interface EventLogEntry extends CapperEvent {
  follower_count: number
  online_fan_count: number
  online_session_count: number
  offline_fan_count: number
  delivered_count: number
  pending_count: number
  replayed_count: number
  duplicate_ack_count: number
}

interface ClientMetrics {
  active_connections: number
  notifications_sent: number
  notifications_delivered: number
  average_latency_ms: number
  p95_latency_ms: number
  last_event_type: string
  follower_targets: number
  online_fan_targets: number
  online_sessions_targeted: number
  offline_pending: number
  replayed_deliveries: number
  duplicate_acks_ignored: number
  last_updated_at: string
}

interface ClientConnection {
  role: 'fan' | 'control' | 'unknown'
  fan_id?: string
  fan_name?: string
  last_seen_event_id?: string
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
const MAX_REQUEST_BYTES = 32_000

const CAPPERS: Capper[] = [
  {
    id: 'capper-sharpside-sam',
    name: 'SharpSide Sam',
    role: 'MLB / NBA Cappers',
    record: '62% last 180 tracked picks',
    specialty: 'Line movement and closing-line value'
  },
  {
    id: 'capper-courtside-kelly',
    name: 'Courtside Kelly',
    role: 'Live NBA + CFB Cappers',
    record: '+18.4u last 90 days',
    specialty: 'Live-game notes and player props'
  }
]

const CAPPERS_BY_ID = new Map(CAPPERS.map((capper) => [capper.id, capper]))

const FANS: FanSeed[] = [
  { id: 'fan-ava', name: 'Ava A.', avatar: 'AA', followed_cappers: ['capper-sharpside-sam'] },
  { id: 'fan-ben', name: 'Ben B.', avatar: 'BB', followed_cappers: ['capper-courtside-kelly'] },
  {
    id: 'fan-cara',
    name: 'Cara C.',
    avatar: 'CC',
    followed_cappers: ['capper-sharpside-sam', 'capper-courtside-kelly']
  },
  { id: 'fan-drew', name: 'Drew D.', avatar: 'DD', followed_cappers: ['capper-sharpside-sam'] },
  { id: 'fan-emma', name: 'Emma E.', avatar: 'EE', followed_cappers: [] },
  { id: 'fan-finn', name: 'Finn F.', avatar: 'FF', followed_cappers: ['capper-courtside-kelly'] }
]

const FAN_FOLLOWS = new Map<string, Set<string>>(
  FANS.map((fan) => [fan.id, new Set(fan.followed_cappers)])
)

const fanConnections = new Map<string, Set<WebSocket>>()
const controlConnections = new Set<WebSocket>()
const connectionState = new Map<WebSocket, ClientConnection>()
const pendingAcks = new Map<string, Map<string, number>>()
const acknowledgedAcks = new Map<string, Set<string>>()
const idempotencyKeys = new Map<string, EventLogEntry>()

const eventLog: EventLogEntry[] = []
const latencySamples: number[] = []

let notificationsSent = 0
let notificationsDelivered = 0
let replayedDeliveries = 0
let duplicateAcksIgnored = 0

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
    } catch (error) {
      const status = error instanceof Error && error.message === 'payload-too-large' ? 413 : 400
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: status === 413 ? 'Payload too large.' : 'Invalid JSON payload.' }))
      return
    }

    const { type, capper_id, payload, idempotency_key } = body as {
      type: CapperAction
      capper_id: string
      payload: FanNotificationPayload
      idempotency_key?: string
    }
    const audienceSegment = normalizeAudienceSegment(body.audience_segment)
    const deliveryChannels = normalizeDeliveryChannels(body.delivery_channels)
    const businessGoal = normalizeBusinessGoal(body.business_goal, type)

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

    const normalizedIdempotencyKey =
      typeof idempotency_key === 'string' && idempotency_key.trim() ? idempotency_key.trim().slice(0, 120) : undefined

    if (normalizedIdempotencyKey) {
      const existing = idempotencyKeys.get(`${capper.id}:${normalizedIdempotencyKey}`)
      if (existing) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ ok: true, event: existing, idempotent_replay: true }))
        return
      }
    }

    const event = createAndBroadcastEvent(capper, payload, type, {
      audience_segment: audienceSegment,
      delivery_channels: deliveryChannels,
      business_goal: businessGoal,
      idempotency_key: normalizedIdempotencyKey
    })
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
          context.last_seen_event_id =
            typeof message.last_seen_event_id === 'string' ? message.last_seen_event_id : undefined

          const existingConnections = fanConnections.get(fan.id) ?? new Set<WebSocket>()
          existingConnections.add(socket)
          fanConnections.set(fan.id, existingConnections)

          send(socket, {
            type: 'registered',
            payload: {
              kind: 'fan',
              fan_id: fan.id,
              followed_cappers: Array.from(FAN_FOLLOWS.get(fan.id) ?? []),
              cappers: CAPPERS
            }
          })

          replayMissedEventsForFan(fan.id, socket, context.last_seen_event_id)
          broadcastMetrics()
          return
        }
        return
      }
      case 'follow_update': {
        if (context.role !== 'fan' || !context.fan_id) return
        const next = message.followed_cappers
        if (Array.isArray(next)) {
          const requestedCappers = next.map((value) => String(value))
          const unknownCappers = requestedCappers.filter((capperId) => !CAPPERS_BY_ID.has(capperId))
          if (unknownCappers.length > 0) {
            send(socket, {
              type: 'error',
              message: `Unknown capper id(s): ${unknownCappers.join(', ')}`
            })
            return
          }

          FAN_FOLLOWS.set(context.fan_id, new Set(requestedCappers))
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
        if (isEventAlreadyAcknowledged(eventId, fanId)) {
          duplicateAcksIgnored += 1
          const logIndex = eventLog.findIndex((entry) => entry.event_id === eventId)
          if (logIndex >= 0) {
            eventLog[logIndex].duplicate_ack_count += 1
          }
          broadcastMetrics()
          return
        }

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
          eventLog[logIndex].pending_count = Math.max(0, eventLog[logIndex].pending_count - 1)
          if (!eventLog[logIndex].delivered_at) {
            eventLog[logIndex].delivered_at = new Date(now).toISOString()
          }
          eventLog[logIndex].latency_ms = latency
        }

        markAcknowledged(eventId, fanId)

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
      const fanSockets = fanConnections.get(context.fan_id)
      fanSockets?.delete(socket)
      if (fanSockets?.size === 0) {
        fanConnections.delete(context.fan_id)
      }
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
  type: CapperAction,
  options: {
    audience_segment: AudienceSegment
    delivery_channels: DeliveryChannel[]
    business_goal: BusinessGoal
    idempotency_key?: string
  }
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
    latency_ms: null,
    audience_segment: options.audience_segment,
    delivery_channels: options.delivery_channels,
    business_goal: options.business_goal,
    idempotency_key: options.idempotency_key
  }

  const followers = FANS.filter((fan) => (FAN_FOLLOWS.get(fan.id) ?? new Set()).has(capper.id)).map(
    (fan) => fan.id
  )
  const recipients = followers.filter((fanId) => (fanConnections.get(fanId)?.size ?? 0) > 0)
  const onlineSessionCount = recipients.reduce((total, fanId) => total + (fanConnections.get(fanId)?.size ?? 0), 0)

  const pendingForEvent = new Map<string, number>()
  const alreadyAcked = acknowledgedAcks.get(event.event_id)

  for (const fanId of recipients) {
    if (alreadyAcked?.has(fanId)) {
      continue
    }

    const sockets = fanConnections.get(fanId)
    if (!sockets || sockets.size === 0) continue

    for (const socket of sockets) {
      sendCapperEvent(socket, event)
    }
    pendingForEvent.set(fanId, Date.now())
  }

  notificationsSent += pendingForEvent.size

  const logEntry: EventLogEntry = {
    ...event,
    follower_count: followers.length,
    online_fan_count: recipients.length,
    online_session_count: onlineSessionCount,
    offline_fan_count: Math.max(0, followers.length - recipients.length),
    delivered_count: 0,
    pending_count: pendingForEvent.size,
    replayed_count: 0,
    duplicate_ack_count: 0
  }

  if (pendingForEvent.size > 0) {
    pendingAcks.set(logEntry.event_id, pendingForEvent)
  }

  if (!acknowledgedAcks.has(logEntry.event_id)) {
    acknowledgedAcks.set(logEntry.event_id, new Set())
  }

  eventLog.unshift(logEntry)
  if (eventLog.length > MAX_EVENT_LOG) {
    const removed = eventLog.pop()
    if (removed) {
      pendingAcks.delete(removed.event_id)
      acknowledgedAcks.delete(removed.event_id)
    }
  }

  if (options.idempotency_key) {
    idempotencyKeys.set(`${capper.id}:${options.idempotency_key}`, logEntry)
    while (idempotencyKeys.size > MAX_EVENT_LOG) {
      const oldestKey = idempotencyKeys.keys().next().value as string | undefined
      if (!oldestKey) break
      idempotencyKeys.delete(oldestKey)
    }
  }

  broadcastControlStream()
  return logEntry
}

function replayMissedEventsForFan(fanId: string, socket: WebSocket, lastSeenEventId?: string): void {
  const followedCappers = FAN_FOLLOWS.get(fanId) ?? new Set<string>()
  if (followedCappers.size === 0 || eventLog.length === 0) {
    return
  }

  const orderedEvents = [...eventLog].slice().reverse()
  let replayStartIndex = 0
  let truncated = false

  if (lastSeenEventId) {
    const seenEventIndex = orderedEvents.findIndex((entry) => entry.event_id === lastSeenEventId)
    if (seenEventIndex >= 0) {
      replayStartIndex = seenEventIndex + 1
    } else {
      truncated = true
    }
  }

  const eventsForFan = orderedEvents.slice(replayStartIndex).filter((entry) => {
    return followedCappers.has(entry.capper_id) && !isEventAlreadyAcknowledged(entry.event_id, fanId)
  })

  if (eventsForFan.length === 0) {
    if (truncated) {
      send(socket, {
        type: 'control_note',
        message: 'Reconnect was older than event buffer. Replaying available window only.'
      })
    }
    return
  }

  for (const event of eventsForFan) {
    sendCapperEvent(socket, event, { replayed: true })
    const existing = pendingAcks.get(event.event_id)
    const wasAlreadyPending = existing?.has(fanId) ?? false
    if (existing) {
      existing.set(fanId, Date.now())
    } else {
      pendingAcks.set(event.event_id, new Map([[fanId, Date.now()]]))
    }
    const logIndex = eventLog.findIndex((entry) => entry.event_id === event.event_id)
    if (logIndex >= 0) {
      eventLog[logIndex].replayed_count += 1
      if (!wasAlreadyPending) {
        eventLog[logIndex].pending_count += 1
      }
    }
    replayedDeliveries += 1
  }

  if (truncated) {
    send(socket, {
      type: 'control_note',
      message: 'Reconnect was older than event buffer. Replaying available window only.'
    })
  }

  broadcastMetrics()
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
  const activeConnections =
    Array.from(fanConnections.values()).reduce((total, sockets) => total + sockets.size, 0) + controlConnections.size
  const recentEvents = eventLog.slice(0, 50)

  return {
    active_connections: activeConnections,
    notifications_sent: notificationsSent,
    notifications_delivered: notificationsDelivered,
    average_latency_ms: averageLatency,
    p95_latency_ms: p95,
    last_event_type: hasEvent ? hasEvent.type : 'none',
    follower_targets: recentEvents.reduce((total, entry) => total + entry.follower_count, 0),
    online_fan_targets: recentEvents.reduce((total, entry) => total + entry.online_fan_count, 0),
    online_sessions_targeted: recentEvents.reduce((total, entry) => total + entry.online_session_count, 0),
    offline_pending: recentEvents.reduce((total, entry) => total + entry.offline_fan_count, 0),
    replayed_deliveries: replayedDeliveries,
    duplicate_acks_ignored: duplicateAcksIgnored,
    last_updated_at: new Date().toISOString()
  }
}

function isEventAlreadyAcknowledged(eventId: string, fanId: string): boolean {
  return acknowledgedAcks.get(eventId)?.has(fanId) ?? false
}

function markAcknowledged(eventId: string, fanId: string): void {
  let fans = acknowledgedAcks.get(eventId)
  if (!fans) {
    fans = new Set()
    acknowledgedAcks.set(eventId, fans)
  }
  fans.add(fanId)
}

function sendCapperEvent(
  socket: WebSocket,
  payload: CapperEvent,
  metadata?: {
    replayed?: boolean
  }
) {
  send(socket, {
    type: 'capper_event',
    payload,
    replayed: metadata?.replayed ?? false
  })
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

function normalizeAudienceSegment(value: unknown): AudienceSegment {
  const allowed: AudienceSegment[] = ['all_followers', 'premium_subscribers', 'high_intent_fans', 'at_risk_fans']
  return typeof value === 'string' && allowed.includes(value as AudienceSegment)
    ? (value as AudienceSegment)
    : 'all_followers'
}

function normalizeDeliveryChannels(value: unknown): DeliveryChannel[] {
  const allowed = new Set<DeliveryChannel>(['in_app', 'push', 'email', 'discord'])
  if (!Array.isArray(value)) {
    return ['in_app', 'push']
  }

  const channels = value
    .map((entry) => String(entry))
    .filter((entry): entry is DeliveryChannel => allowed.has(entry as DeliveryChannel))

  return channels.length > 0 ? Array.from(new Set(channels)) : ['in_app', 'push']
}

function normalizeBusinessGoal(value: unknown, action: CapperAction): BusinessGoal {
  const allowed: BusinessGoal[] = ['time_sensitive_pick', 'retention', 'conversion', 'trust', 'reward']
  if (typeof value === 'string' && allowed.includes(value as BusinessGoal)) {
    return value as BusinessGoal
  }

  const defaults: Record<CapperAction, BusinessGoal> = {
    new_pick: 'time_sensitive_pick',
    odds_moved: 'time_sensitive_pick',
    game_starting_soon: 'retention',
    result_posted: 'trust',
    reward_unlocked: 'reward',
    live_capper_note: 'retention'
  }
  return defaults[action]
}

function readRequestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
      if (Buffer.byteLength(data, 'utf8') > MAX_REQUEST_BYTES) {
        reject(new Error('payload-too-large'))
        req.destroy()
      }
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
