import { useEffect, useMemo, useState } from 'react'
import './App.css'

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

type Capper = {
  id: string
  name: string
  role: string
  record: string
  specialty: string
}

type FanSeed = {
  id: string
  name: string
  avatar: string
  followed_cappers: string[]
}

type CapperEvent = {
  event_id: string
  type: CapperAction
  capper_id: string
  capper_name: string
  payload: {
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
  created_at: string
  sent_at: string
  delivered_at: string | null
  latency_ms: number | null
  audience_segment: AudienceSegment
  delivery_channels: DeliveryChannel[]
  business_goal: BusinessGoal
  idempotency_key?: string
}

type EventLogEntry = CapperEvent & {
  follower_count: number
  online_fan_count: number
  online_session_count: number
  offline_fan_count: number
  delivered_count: number
  pending_count: number
  replayed_count: number
  duplicate_ack_count: number
}

type Metrics = {
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

type FanClientState = {
  status: 'connecting' | 'online' | 'offline'
  inbox: Array<CapperEvent & { receiveLatencyMs: number; seen: boolean }>
  followedCappers: string[]
  tailedPickIds: string[]
  latestLatencyMs: number | null
  highlightId: string | null
}

type BootstrapState = {
  cappers: Capper[]
  fans: FanSeed[]
  metrics: Metrics
  event_log: EventLogEntry[]
}

type ControlMessage =
  | { type: 'registered'; payload: { kind: 'control'; metrics: Metrics; event_log: EventLogEntry[] } }
  | { type: 'control_stream'; event_log: EventLogEntry[]; metrics: Metrics }
  | { type: 'delivery_update'; event_id: string; fan_id: string; delivered_count: number; latency_ms: number }
  | { type: 'ping'; at: number }

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:4000'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000'

const ACTION_LABELS: Record<CapperAction, string> = {
  new_pick: 'Post New Pick',
  odds_moved: 'Odds Moved',
  game_starting_soon: 'Game Starting Soon',
  result_posted: 'Result Posted',
  reward_unlocked: 'Reward Unlocked',
  live_capper_note: 'Live Capper Note'
}

const PRODUCT_LENSES = [
  {
    title: 'Capper operating system',
    body: 'Reduce admin work while giving creators urgency, audience, and business-outcome controls.'
  },
  {
    title: 'Fan trust loop',
    body: 'Show record context, pick lifecycle, result ledger, rewards, and responsible-play reminders.'
  },
  {
    title: 'Delivery health',
    body: 'Separate followers, online sessions, replay, duplicate acks, latency, and offline pending work.'
  }
]

const ACTION_CONFIG: Record<
  CapperAction,
  {
    audience_segment: AudienceSegment
    delivery_channels: DeliveryChannel[]
    business_goal: BusinessGoal
    urgency: string
    outcome: string
  }
> = {
  new_pick: {
    audience_segment: 'premium_subscribers',
    delivery_channels: ['in_app', 'push', 'email'],
    business_goal: 'time_sensitive_pick',
    urgency: 'Lock-sensitive',
    outcome: 'Fan tail intent'
  },
  odds_moved: {
    audience_segment: 'high_intent_fans',
    delivery_channels: ['in_app', 'push'],
    business_goal: 'time_sensitive_pick',
    urgency: 'Immediate',
    outcome: 'Line protection'
  },
  game_starting_soon: {
    audience_segment: 'all_followers',
    delivery_channels: ['in_app', 'push'],
    business_goal: 'retention',
    urgency: 'Soon',
    outcome: 'Engagement'
  },
  result_posted: {
    audience_segment: 'all_followers',
    delivery_channels: ['in_app', 'email'],
    business_goal: 'trust',
    urgency: 'Post-game',
    outcome: 'Ledger trust'
  },
  reward_unlocked: {
    audience_segment: 'at_risk_fans',
    delivery_channels: ['in_app', 'push', 'email'],
    business_goal: 'reward',
    urgency: 'Personalized',
    outcome: 'Retention'
  },
  live_capper_note: {
    audience_segment: 'premium_subscribers',
    delivery_channels: ['in_app', 'discord'],
    business_goal: 'retention',
    urgency: 'Live context',
    outcome: 'Community value'
  }
}

const TEMPLATE_ACTIONS: Record<CapperAction, (capper: Capper) => CapperEvent['payload']> = {
  new_pick: (capper) => ({
    title: `${capper.name} posted a live pick`,
    body: 'Confidence locked: 74% with a positive expected edge before lock.',
    pick_id: `pick-${Date.now()}`,
    market: 'NYK @ BOS - Jalen Brunson points',
    line: 'Over 27.5',
    odds: '-112',
    confidence: 74,
    status: 'open',
    deep_link: '/mobile/picks/live-brunson-over',
    trust_context: {
      capper_record: capper.record,
      pick_lifecycle: 'Open pick, line still available in-app',
      result_ledger: 'Will grade into the fan ledger after final score',
      responsible_note: 'Informational content only. Tail within your own limits.'
    }
  }),
  odds_moved: (capper) => ({
    title: `${capper.name} alerts odds drift`,
    body: 'Opening line moved 3 points over 60 seconds. Re-calc your stake sizing now.',
    pick_id: 'pick-line-watch',
    market: 'LAD @ CHC - first five innings total',
    line: 'Under 4.5',
    odds: '+102 -> -118',
    confidence: 68,
    status: 'moved',
    deep_link: '/mobile/picks/line-watch',
    trust_context: {
      capper_record: capper.record,
      pick_lifecycle: 'Moved line, compare current book before tailing',
      result_ledger: 'Closing-line value tracked for subscribers',
      responsible_note: 'Odds movement is context, not a guarantee.'
    }
  }),
  game_starting_soon: (capper) => ({
    title: `Game starting soon - ${capper.name} watch`,
    body: 'Reminder: Game starts in under 30 minutes. Final lineup and weather notes attached.',
    trust_context: {
      capper_record: capper.record,
      pick_lifecycle: 'Pre-game context window',
      responsible_note: 'Use reminders to make calmer decisions, not rushed ones.'
    }
  }),
  result_posted: (capper) => ({
    title: `${capper.name} posted results`,
    body: 'Result posted for the latest game. Review scoreboard breakdown and grading.',
    pick_id: 'pick-result-recap',
    market: 'BOS moneyline',
    line: 'Closed -135',
    odds: '-122',
    status: 'graded',
    result: 'Won by 8. ROI updated in fan ledger.',
    deep_link: '/mobile/picks/result-recap',
    trust_context: {
      capper_record: capper.record,
      pick_lifecycle: 'Graded and locked',
      result_ledger: 'Ledger updated with price, close, result, and unit outcome',
      responsible_note: 'Transparent grading builds trust across winning and losing picks.'
    }
  }),
  reward_unlocked: (capper) => ({
    title: `${capper.name} reward unlocked`,
    body: 'A new reward tier unlocked. Update your unlock panel to claim this weekend bonus.',
    status: 'reward',
    reward: '3-day premium trial unlocked after your third tailed win.',
    deep_link: '/mobile/rewards/weekend-bonus',
    trust_context: {
      capper_record: capper.record,
      pick_lifecycle: 'Reward surfaced after fan engagement',
      result_ledger: 'Reward tied to tailed-result history',
      responsible_note: 'Rewards should deepen community value without encouraging over-spend.'
    }
  }),
  live_capper_note: (capper) => ({
    title: `${capper.name} live note`,
    body: 'In-play volatility increased; monitor quarter pace and steam pressure.',
    trust_context: {
      capper_record: capper.record,
      pick_lifecycle: 'Live informational note',
      responsible_note: 'Use live notes to understand context before taking action.'
    }
  })
}

function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([])
  const [selectedCapper, setSelectedCapper] = useState<string>('')
  const [fanState, setFanState] = useState<Record<string, FanClientState>>({})
  const [currentPath, setCurrentPath] = useState(() => window.location.pathname)

  useEffect(() => {
    const loadBootstrap = async () => {
      const response = await fetch(`${API_BASE}/api/state`)
      const data: BootstrapState = await response.json()
      setBootstrap(data)
      setMetrics(data.metrics)
      setEventLog(data.event_log)
      setSelectedCapper(data.cappers[0]?.id ?? '')
      const initial: Record<string, FanClientState> = {}
      for (const fan of data.fans) {
        initial[fan.id] = createInitialFanState(fan)
      }
      setFanState(initial)
    }

    void loadBootstrap()
  }, [])

  useEffect(() => {
    if (!bootstrap) return
    let socket: WebSocket | null = null
    let cancelled = false

    const connectTimer = window.setTimeout(() => {
      if (cancelled) return
      const nextSocket = new WebSocket(WS_URL)
      socket = nextSocket

      nextSocket.onopen = () => {
        nextSocket.send(JSON.stringify({ type: 'register', role: 'control' }))
      }

      nextSocket.onmessage = (event) => {
        const msg = JSON.parse(event.data) as ControlMessage
        if (msg.type === 'registered') {
          setMetrics(msg.payload.metrics)
          setEventLog(msg.payload.event_log)
          return
        }

        if (msg.type === 'control_stream') {
          setMetrics(msg.metrics)
          setEventLog(msg.event_log)
          return
        }

        if (msg.type === 'delivery_update') {
          setEventLog((prev) =>
            prev.map((entry) =>
              entry.event_id === msg.event_id
                ? {
                    ...entry,
                    delivered_count: msg.delivered_count,
                    latency_ms: msg.latency_ms ?? entry.latency_ms
                  }
                : entry
            )
          )
        }

        if (msg.type === 'ping') {
          nextSocket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
        }
      }

      nextSocket.onclose = () => {
        setMetrics((prev) => (prev ? { ...prev, active_connections: Math.max(0, prev.active_connections - 1) } : null))
      }
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(connectTimer)
      socket?.close()
    }
  }, [bootstrap])

  useEffect(() => {
    const syncPath = () => setCurrentPath(window.location.pathname)
    window.addEventListener('popstate', syncPath)
    return () => window.removeEventListener('popstate', syncPath)
  }, [])

  const fanById = useMemo(() => {
    const map = new Map<string, FanSeed>()
    if (!bootstrap) return map
    for (const fan of bootstrap.fans) {
      map.set(fan.id, fan)
    }
    return map
  }, [bootstrap])

  const onFanUpdate = (fanId: string, updater: (state: FanClientState) => FanClientState) => {
    setFanState((current) => ({
      ...current,
      [fanId]: updater(current[fanId] ?? createInitialFanState(fanById.get(fanId)))
    }))
  }

  const openDeepLink = (path: string) => {
    window.history.pushState({}, '', path)
    setCurrentPath(path)
  }

  const closeDeepLink = () => {
    window.history.pushState({}, '', '/')
    setCurrentPath('/')
  }

  const sendAction = async (type: CapperAction) => {
    const selected = bootstrap?.cappers.find((capper) => capper.id === selectedCapper)
    if (!selected) return

    const template = TEMPLATE_ACTIONS[type](selected)
    const config = ACTION_CONFIG[type]
    await fetch(`${API_BASE}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type,
        capper_id: selected.id,
        payload: template,
        audience_segment: config.audience_segment,
        delivery_channels: config.delivery_channels,
        business_goal: config.business_goal,
        idempotency_key: `${selected.id}:${type}:${Date.now()}`
      })
    })
  }

  if (!bootstrap || !metrics) {
    return <main className="app-shell">
      <h1>DubClub Realtime Notifications</h1>
      <p>Loading demo seed data and connecting to server...</p>
    </main>
  }

  const detailEvent = findDeepLinkEvent(currentPath, fanState, eventLog)
  const selectedCapperProfile = bootstrap.cappers.find((capper) => capper.id === selectedCapper) ?? bootstrap.cappers[0]

  return (
    <main className="app-shell">
      <header className="dashboard-section section-header header-card">
        <div>
          <p className="eyebrow">Staff CTO/Product Demo</p>
          <h1>DubClub Realtime Ops Cockpit</h1>
          <p className="header-copy">
            A product-specific control room for cappers, fans, and delivery health: built to show
            how DubClub can Win More Together with trust, speed, and operational clarity.
          </p>
        </div>
        <div className="status-pill-wrap">
          <span className="status-pill">Server: online</span>
          <span className="status-pill">Last update: {new Date(metrics.last_updated_at).toLocaleTimeString()}</span>
        </div>
      </header>

      <section className="dashboard-section section-lenses product-lenses" aria-label="product lenses">
        {PRODUCT_LENSES.map((lens) => (
          <article className="lens-card" key={lens.title}>
            <strong>{lens.title}</strong>
            <p>{lens.body}</p>
          </article>
        ))}
      </section>

      {currentPath !== '/' ? (
        <DeepLinkPanel event={detailEvent} path={currentPath} onClose={closeDeepLink} />
      ) : null}

      <section className="dashboard-section section-metrics metrics-grid" aria-label="live metrics">
        <article className="metric-card">
          <p>Active connections</p>
          <strong className="metric-value">{metrics.active_connections}</strong>
        </article>
        <article className="metric-card">
          <p>Follower targets</p>
          <strong className="metric-value">{metrics.follower_targets}</strong>
        </article>
        <article className="metric-card">
          <p>Online fan targets</p>
          <strong className="metric-value">{metrics.online_fan_targets}</strong>
        </article>
        <article className="metric-card">
          <p>Online sessions</p>
          <strong className="metric-value">{metrics.online_sessions_targeted}</strong>
        </article>
        <article className="metric-card">
          <p>Unique sends</p>
          <strong className="metric-value">{metrics.notifications_sent}</strong>
        </article>
        <article className="metric-card">
          <p>Unique delivered</p>
          <strong className="metric-value">{metrics.notifications_delivered}</strong>
        </article>
        <article className="metric-card">
          <p>Average latency</p>
          <strong className="metric-value">{metrics.average_latency_ms} ms</strong>
        </article>
        <article className="metric-card">
          <p>P95 latency</p>
          <strong className="metric-value">{metrics.p95_latency_ms} ms</strong>
        </article>
        <article className="metric-card">
          <p>Offline pending</p>
          <strong className="metric-value">{metrics.offline_pending}</strong>
        </article>
        <article className="metric-card">
          <p>Replay sends</p>
          <strong className="metric-value">{metrics.replayed_deliveries}</strong>
        </article>
        <article className="metric-card">
          <p>Duplicate acks ignored</p>
          <strong className="metric-value">{metrics.duplicate_acks_ignored}</strong>
        </article>
        <article className="metric-card">
          <p>Last event type</p>
          <strong className="metric-value metric-value--wide">{metrics.last_event_type}</strong>
        </article>
      </section>

      <section className="dashboard-section section-capper-control card">
        <h2>Capper Control Room</h2>
        <p>
          Publish targeted product moments with audience, channel, urgency, and business intent
          attached to every event.
        </p>

        <label htmlFor="capper-select">Active capper</label>
        <select
          id="capper-select"
          value={selectedCapper}
          onChange={(event) => setSelectedCapper(event.target.value)}
        >
          {bootstrap.cappers.map((capper) => (
            <option value={capper.id} key={capper.id}>
              {capper.name}
            </option>
          ))}
        </select>

        {selectedCapperProfile ? (
          <div className="capper-profile-strip">
            <span>{selectedCapperProfile.role}</span>
            <span>{selectedCapperProfile.record}</span>
            <span>{selectedCapperProfile.specialty}</span>
          </div>
        ) : null}

        <div className="button-grid">
          {(Object.entries(ACTION_LABELS) as Array<[CapperAction, string]>).map(([action, label]) => (
            <button className="workflow-button" key={action} onClick={() => void sendAction(action)}>
              <span>{label}</span>
              <small>
                {formatLabel(ACTION_CONFIG[action].audience_segment)} · {ACTION_CONFIG[action].urgency}
              </small>
              <small>{ACTION_CONFIG[action].outcome}</small>
            </button>
          ))}
        </div>
      </section>

      <section className="dashboard-section section-fans card">
        <h2>Simulated Fan Clients</h2>
        <div className="fans-grid">
          {bootstrap.fans.map((fan) => (
            <FanClientPanel
              key={fan.id}
              fan={fan}
              wsUrl={WS_URL}
              state={fanState[fan.id]}
              capperMap={new Map(bootstrap.cappers.map((capper) => [capper.id, capper.name]))}
              onUpdate={(next) => onFanUpdate(fan.id, next)}
              onOpenDeepLink={openDeepLink}
            />
          ))}
        </div>
      </section>

      <section className="dashboard-section section-event-stream card">
        <h2>Live Event Stream</h2>
        <div className="event-table-wrapper desktop-visible">
          <table>
            <thead>
              <tr>
                <th>Event ID</th>
                <th>Type</th>
                <th>Capper</th>
                <th>Goal</th>
                <th>Followers</th>
                <th>Online</th>
                <th>Delivered</th>
                <th>Replay/Dupe</th>
                <th>Latency</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {eventLog.length === 0 ? (
                <tr>
                  <td colSpan={10}>No events yet.</td>
                </tr>
              ) : (
                eventLog.map((entry) => (
                  <tr key={entry.event_id}>
                    <td className="mono">{entry.event_id.slice(0, 8)}</td>
                    <td>{ACTION_LABELS[entry.type]}</td>
                    <td>{entry.capper_name}</td>
                    <td>{formatLabel(entry.business_goal)}</td>
                    <td>{entry.follower_count}</td>
                    <td>
                      {entry.online_fan_count} fans / {entry.online_session_count} sessions
                    </td>
                    <td>{entry.delivered_count} delivered / {entry.pending_count} pending</td>
                    <td>{entry.replayed_count} replay / {entry.duplicate_ack_count} dupe</td>
                    <td>{entry.latency_ms ?? '-'} ms</td>
                    <td>{entry.payload.title}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="mobile-event-list">
          {eventLog.length === 0 ? (
            <p className="muted">No events yet.</p>
          ) : (
            eventLog.map((entry) => (
              <article className="event-card" key={`${entry.event_id}-mobile`}>
                <div className="event-card-row">
                  <strong>{ACTION_LABELS[entry.type]}</strong>
                  <span>{entry.capper_name}</span>
                </div>
                <p className="small">
                  Delivered: {entry.delivered_count}/{entry.follower_count} followers · {entry.online_session_count} sessions
                </p>
                <p className="small">Goal: {formatLabel(entry.business_goal)} · Audience: {formatLabel(entry.audience_segment)}</p>
                <p className="small">Latency: {entry.latency_ms ?? '-'} ms</p>
                <p>{entry.payload.title}</p>
              </article>
            ))
          )}
        </div>
      </section>

      <section className="dashboard-section section-architecture card">
        <h2>Architecture Summary</h2>
        <ul>
          <li>Demo-only Node + ws gateway with in-memory fan presence, follow map, replay buffer, and idempotency keys.</li>
          <li>Each publish carries audience, channels, business goal, trust context, and responsible-play metadata.</li>
          <li>Fanout separates follower count, online fan targets, session fanout, offline pending, replay, and duplicate acks.</li>
          <li>Production path maps this boundary to Django/Go APIs, Redis presence/indexes, Postgres delivery durability, and push fallback.</li>
        </ul>
      </section>

      <section className="dashboard-section section-event-log card">
        <h2>Notification Event Log</h2>
        <div className="log-list">
          {eventLog.map((entry) => (
            <div className="log-item" key={`${entry.event_id}-log`}>
              <p className="event-log-title">
                <strong>{entry.payload.title}</strong> - {entry.capper_name}
              </p>
              <p className="mono small event-log-id">{entry.event_id}</p>
              <p className="event-log-time">
                created {new Date(entry.created_at).toLocaleTimeString()} · delivered at {entry.delivered_at ?? 'pending'}
              </p>
              <p className="small">
                {formatLabel(entry.audience_segment)} · {entry.delivery_channels.map(formatLabel).join(', ')} ·{' '}
                {formatLabel(entry.business_goal)}
              </p>
            </div>
          ))}
        </div>
      </section>
    </main>
  )
}

type FanClientPanelProps = {
  fan: FanSeed
  wsUrl: string
  state?: FanClientState
  capperMap: Map<string, string>
  onUpdate: (next: (state: FanClientState) => FanClientState) => void
  onOpenDeepLink: (path: string) => void
}

function FanClientPanel({ fan, wsUrl, state, capperMap, onUpdate, onOpenDeepLink }: FanClientPanelProps) {
  const localState = state ?? createInitialFanState(fan)

  useEffect(() => {
    let socket: WebSocket | null = null
    let cancelled = false

    const connectTimer = window.setTimeout(() => {
      if (cancelled) return
      const nextSocket = new WebSocket(wsUrl)
      socket = nextSocket

      nextSocket.onopen = () => {
        onUpdate((prev) => ({
          ...prev,
          status: 'connecting'
        }))
        nextSocket.send(JSON.stringify({ type: 'register', role: 'fan', fan_id: fan.id }))
      }

      nextSocket.onmessage = (raw) => {
        const msg = JSON.parse(raw.data) as {
          type: string
          payload?: CapperEvent
          followed_cappers?: string[]
          at?: number
        }

        if (msg.type === 'registered') {
          onUpdate((prev) => ({
            ...prev,
            status: 'online',
            followedCappers: msg.followed_cappers ?? prev.followedCappers
          }))
          return
        }

        if (msg.type === 'ping') {
          nextSocket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
          return
        }

        if (msg.type === 'capper_event' && msg.payload) {
          const now = Date.now()
          const receiveLatencyMs = Math.max(0, now - Date.parse(msg.payload.created_at))
          const withEntry = {
            ...(msg.payload as CapperEvent),
            receiveLatencyMs,
            seen: true
          }

          nextSocket.send(
            JSON.stringify({
              type: 'ack',
              event_id: msg.payload.event_id,
              fan_id: fan.id
            })
          )

          onUpdate((prev) => {
            return {
              ...prev,
              status: 'online',
              inbox: [withEntry, ...prev.inbox.filter((entry) => entry.event_id !== withEntry.event_id).slice(0, 7)],
              latestLatencyMs: receiveLatencyMs,
              highlightId: msg.payload!.event_id
            }
          })

          window.setTimeout(() => {
            onUpdate((latest) => ({
              ...latest,
              highlightId: latest.highlightId === msg.payload!.event_id ? null : latest.highlightId
            }))
          }, 1000)
        }
      }

      nextSocket.onclose = () => {
        onUpdate((prev) => ({
          ...prev,
          status: 'offline'
        }))
      }
    }, 0)

    return () => {
      cancelled = true
      window.clearTimeout(connectTimer)
      socket?.close()
    }
  }, [fan.id, wsUrl])

  const statusClass = localState.status === 'online' ? 'online' : localState.status === 'connecting' ? 'connecting' : 'offline'

  return (
    <article className="fan-card">
      <header>
        <div>
          <h3>
            {fan.name} <span className="avatar">{fan.avatar}</span>
          </h3>
          <p className={`dot ${statusClass}`}>{localState.status}</p>
        </div>
      </header>

      <p>
        Follows: {localState.followedCappers.map((id) => capperMap.get(id) ?? id).join(', ') || 'none'}
      </p>

      <p>
        Latest latency: {localState.latestLatencyMs === null ? 'waiting...' : `${localState.latestLatencyMs} ms`}
      </p>

      <p>
        Tailed picks: {localState.tailedPickIds.length}
      </p>

      <div className="inbox-list">
        {localState.inbox.length === 0 ? (
          <p className="muted">No notifications yet.</p>
        ) : (
          localState.inbox.map((entry) => {
            const pickId = entry.payload.pick_id
            const isTailed = Boolean(pickId && localState.tailedPickIds.includes(pickId))

            return (
              <div
                key={entry.event_id}
                className={
                  localState.highlightId === entry.event_id ? 'inbox-item highlight' : 'inbox-item'
                }
              >
                <div className="inbox-title-row">
                  <strong>{entry.payload.title}</strong>
                  {entry.payload.status ? <span className={`pick-status ${entry.payload.status}`}>{entry.payload.status}</span> : null}
                </div>
                <p className="small">{entry.payload.body}</p>
                {entry.payload.market ? (
                  <div className="pick-slip">
                    <p>{entry.payload.market}</p>
                    <div className="pick-slip-grid">
                      <span>{entry.payload.line}</span>
                      <span>{entry.payload.odds}</span>
                      <span>{entry.payload.confidence ? `${entry.payload.confidence}% edge` : entry.payload.result ?? entry.payload.reward}</span>
                    </div>
                  </div>
                ) : null}
                {entry.payload.result ? <p className="small outcome">{entry.payload.result}</p> : null}
                {entry.payload.reward ? <p className="small outcome">{entry.payload.reward}</p> : null}
                {entry.payload.trust_context ? (
                  <div className="trust-panel">
                    {entry.payload.trust_context.capper_record ? <span>{entry.payload.trust_context.capper_record}</span> : null}
                    {entry.payload.trust_context.pick_lifecycle ? <span>{entry.payload.trust_context.pick_lifecycle}</span> : null}
                    {entry.payload.trust_context.result_ledger ? <span>{entry.payload.trust_context.result_ledger}</span> : null}
                    {entry.payload.trust_context.responsible_note ? <span>{entry.payload.trust_context.responsible_note}</span> : null}
                  </div>
                ) : null}
                <div className="inbox-actions">
                  {pickId ? (
                    <button
                      className={isTailed ? 'secondary-action' : undefined}
                      disabled={isTailed}
                      onClick={() => {
                        onUpdate((prev) => ({
                          ...prev,
                          tailedPickIds: Array.from(new Set([...prev.tailedPickIds, pickId]))
                        }))
                      }}
                    >
                      {isTailed ? 'Tailed' : 'Tail Pick'}
                    </button>
                  ) : null}
                  {entry.payload.deep_link ? (
                    <a
                      href={entry.payload.deep_link}
                      onClick={(event) => {
                        event.preventDefault()
                        onOpenDeepLink(entry.payload.deep_link!)
                      }}
                    >
                      Open
                    </a>
                  ) : null}
                </div>
                <div className="notification-meta">
                  <span>{formatLabel(entry.business_goal)}</span>
                  <span>{formatLabel(entry.audience_segment)}</span>
                  <span>{entry.receiveLatencyMs}ms</span>
                </div>
              </div>
            )
          })
        )}
      </div>
    </article>
  )
}

function createInitialFanState(fan?: FanSeed): FanClientState {
  return {
    status: 'offline',
    inbox: [],
    followedCappers: fan?.followed_cappers ?? [],
    tailedPickIds: [],
    latestLatencyMs: null,
    highlightId: null
  }
}

function findDeepLinkEvent(
  path: string,
  fanState: Record<string, FanClientState>,
  eventLog: EventLogEntry[]
): CapperEvent | EventLogEntry | null {
  if (path === '/') return null

  for (const fan of Object.values(fanState)) {
    const inboxMatch = fan.inbox.find((entry) => entry.payload.deep_link === path)
    if (inboxMatch) return inboxMatch
  }

  return eventLog.find((entry) => entry.payload.deep_link === path) ?? null
}

type DeepLinkPanelProps = {
  event: CapperEvent | EventLogEntry | null
  path: string
  onClose: () => void
}

function DeepLinkPanel({ event, path, onClose }: DeepLinkPanelProps) {
  return (
    <section className="dashboard-section section-deep-link card">
      <div className="detail-header">
        <div>
          <p className="eyebrow">Deep Link</p>
          <h2>{event?.payload.title ?? 'No matching notification'}</h2>
        </div>
        <button className="secondary-action" onClick={onClose}>
          Back
        </button>
      </div>
      {event ? (
        <div className="detail-body">
          <p>{event.payload.body}</p>
          {event.payload.market ? (
            <div className="pick-slip detail-pick-slip">
              <p>{event.payload.market}</p>
              <div className="pick-slip-grid">
                <span>{event.payload.line}</span>
                <span>{event.payload.odds}</span>
                <span>{event.payload.confidence ? `${event.payload.confidence}% edge` : event.payload.result ?? event.payload.reward}</span>
              </div>
            </div>
          ) : null}
          {event.payload.result ? <p className="small outcome">{event.payload.result}</p> : null}
          {event.payload.reward ? <p className="small outcome">{event.payload.reward}</p> : null}
          {event.payload.trust_context ? (
            <div className="trust-panel detail-trust-panel">
              {event.payload.trust_context.capper_record ? <span>{event.payload.trust_context.capper_record}</span> : null}
              {event.payload.trust_context.pick_lifecycle ? <span>{event.payload.trust_context.pick_lifecycle}</span> : null}
              {event.payload.trust_context.result_ledger ? <span>{event.payload.trust_context.result_ledger}</span> : null}
              {event.payload.trust_context.responsible_note ? <span>{event.payload.trust_context.responsible_note}</span> : null}
            </div>
          ) : null}
          <p className="small">
            {formatLabel(event.business_goal)} · {formatLabel(event.audience_segment)} ·{' '}
            {event.delivery_channels.map(formatLabel).join(', ')}
          </p>
          <p className="small mono">{path}</p>
        </div>
      ) : (
        <p className="muted">{path}</p>
      )}
    </section>
  )
}

function formatLabel(value: string): string {
  return value.replace(/_/g, ' ')
}

export default App
