import { useEffect, useMemo, useState } from 'react'
import './App.css'

type CapperAction =
  | 'new_pick'
  | 'odds_moved'
  | 'game_starting_soon'
  | 'result_posted'
  | 'reward_unlocked'
  | 'live_capper_note'

// single source mapping for capper actions and template builders

type Capper = {
  id: string
  name: string
  role: string
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
  }
  created_at: string
  sent_at: string
  delivered_at: string | null
  latency_ms: number | null
}

type EventLogEntry = CapperEvent & {
  recipient_count: number
  delivered_count: number
}

type Metrics = {
  active_connections: number
  notifications_sent: number
  notifications_delivered: number
  average_latency_ms: number
  p95_latency_ms: number
  last_event_type: string
  last_updated_at: string
}

type FanClientState = {
  status: 'connecting' | 'online' | 'offline'
  inbox: Array<CapperEvent & { receiveLatencyMs: number; seen: boolean }>
  followedCappers: string[]
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

const TEMPLATE_ACTIONS: Record<CapperAction, (capperName: string) => { title: string; body: string }> = {
  new_pick: (name: string) => ({
    title: `${name} posted a live pick`,
    body: 'Confidence locked: 74% — projected edge remains positive before lock.'
  }),
  odds_moved: (name: string) => ({
    title: `${name} alerts odds drift`,
    body: 'Opening line moved 3 points over 60 seconds. Re-calc your stake sizing now.'
  }),
  game_starting_soon: (name: string) => ({
    title: `Game starting soon — ${name} watch`,
    body: 'Reminder: Game starts in under 30 minutes. Final lineup and weather notes attached.'
  }),
  result_posted: (name: string) => ({
    title: `${name} posted results`,
    body: 'Result posted for the latest game. Review scoreboard breakdown and grading.'
  }),
  reward_unlocked: (name: string) => ({
    title: `${name} reward unlocked`,
    body: 'A new reward tier unlocked. Update your unlock panel to claim this weekend bonus.'
  }),
  live_capper_note: (name: string) => ({
    title: `${name} live note`,
    body: 'In-play volatility increased; monitor quarter pace and steam pressure.'
  })
}

function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [metrics, setMetrics] = useState<Metrics | null>(null)
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([])
  const [selectedCapper, setSelectedCapper] = useState<string>('')
  const [fanState, setFanState] = useState<Record<string, FanClientState>>({})

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
        initial[fan.id] = {
          status: 'offline',
          inbox: [],
          followedCappers: fan.followed_cappers,
          latestLatencyMs: null,
          highlightId: null
        }
      }
      setFanState(initial)
    }

    void loadBootstrap()
  }, [])

  useEffect(() => {
    if (!bootstrap) return
    const socket = new WebSocket(WS_URL)

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: 'register', role: 'control' }))
    }

    socket.onmessage = (event) => {
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
        socket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
      }
    }

    socket.onclose = () => {
      setMetrics((prev) => (prev ? { ...prev, active_connections: Math.max(0, prev.active_connections - 1) } : null))
    }

    return () => {
      socket.close()
    }
  }, [bootstrap])

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
      [fanId]: updater(current[fanId] ?? {
        status: 'offline',
        inbox: [],
        followedCappers: fanById.get(fanId)?.followed_cappers ?? [],
        latestLatencyMs: null,
        highlightId: null
      })
    }))
  }

  const sendAction = async (type: CapperAction) => {
    const selected = bootstrap?.cappers.find((capper) => capper.id === selectedCapper)
    if (!selected) return

    const template = TEMPLATE_ACTIONS[type](selected.name)
    await fetch(`${API_BASE}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        type,
        capper_id: selected.id,
        payload: template
      })
    })
  }

  if (!bootstrap || !metrics) {
    return <main className="app-shell">
      <h1>Dub Club Realtime Notifications</h1>
      <p>Loading demo seed data and connecting to server...</p>
    </main>
  }

  return (
    <main className="app-shell">
      <header className="header-card">
        <div>
          <p className="eyebrow">Staff System Design Demo</p>
          <h1>Dub Club Realtime Notifications</h1>
        </div>
        <div className="status-pill-wrap">
          <span className="status-pill">Server: online</span>
          <span className="status-pill">Last update: {new Date(metrics.last_updated_at).toLocaleTimeString()}</span>
        </div>
      </header>

      <section className="metrics-grid" aria-label="live metrics">
        <article className="metric-card">
          <p>Active connections</p>
          <strong>{metrics.active_connections}</strong>
        </article>
        <article className="metric-card">
          <p>Notifications sent</p>
          <strong>{metrics.notifications_sent}</strong>
        </article>
        <article className="metric-card">
          <p>Notifications delivered</p>
          <strong>{metrics.notifications_delivered}</strong>
        </article>
        <article className="metric-card">
          <p>Average latency</p>
          <strong>{metrics.average_latency_ms} ms</strong>
        </article>
        <article className="metric-card">
          <p>P95 latency</p>
          <strong>{metrics.p95_latency_ms} ms</strong>
        </article>
        <article className="metric-card">
          <p>Last event type</p>
          <strong>{metrics.last_event_type}</strong>
        </article>
      </section>

      <section className="two-column">
        <article className="card">
          <h2>Capper Control Room</h2>
          <p>Broadcast capper updates to only fans who follow that capper.</p>

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

          <div className="button-grid">
            {(
              Object.entries(ACTION_LABELS) as Array<[CapperAction, string]>
            ).map(([action, label]) => (
              <button key={action} onClick={() => void sendAction(action)}>
                {label}
              </button>
            ))}
          </div>
        </article>

        <article className="card">
          <h2>Architecture Summary</h2>
          <ul>
            <li>Node + ws backend with in-memory fan presence and follow map.</li>
            <li>One WebSocket per fan connection.</li>
            <li>Capper actions pushed over HTTP and fanout executed on server.</li>
            <li>Fan clients acknowledge each message so latency is measured per delivery.</li>
            <li>Control room receives a live control stream for metrics + event logs.</li>
          </ul>
        </article>
      </section>

      <section className="card">
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
            />
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Live Event Stream</h2>
        <div className="event-table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Event ID</th>
                <th>Type</th>
                <th>Capper</th>
                <th>Recipients</th>
                <th>Delivered</th>
                <th>Latency</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {eventLog.length === 0 ? (
                <tr>
                  <td colSpan={7}>No events yet.</td>
                </tr>
              ) : (
                eventLog.map((entry) => (
                  <tr key={entry.event_id}>
                    <td className="mono">{entry.event_id.slice(0, 8)}</td>
                    <td>{ACTION_LABELS[entry.type]}</td>
                    <td>{entry.capper_name}</td>
                    <td>
                      {entry.delivered_count}/{entry.recipient_count}
                    </td>
                    <td>{entry.delivered_count}</td>
                    <td>{entry.latency_ms ?? '-'} ms</td>
                    <td>{entry.payload.title}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Notification Event Log</h2>
        <div className="log-list">
          {eventLog.map((entry) => (
            <div className="log-item" key={`${entry.event_id}-log`}>
              <p>
                <strong>{entry.payload.title}</strong> - {entry.capper_name}
              </p>
              <p className="mono small">{entry.event_id}</p>
              <p>
                created {new Date(entry.created_at).toLocaleTimeString()} · delivered at {entry.delivered_at ?? 'pending'}
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
}

function FanClientPanel({ fan, wsUrl, state, capperMap, onUpdate }: FanClientPanelProps) {
  const localState = state ?? {
    status: 'offline' as const,
    inbox: [],
    followedCappers: [],
    latestLatencyMs: null,
    highlightId: null
  }

  useEffect(() => {
    const socket = new WebSocket(wsUrl)

    socket.onopen = () => {
      onUpdate(() => ({
        ...localState,
        status: 'connecting'
      }))
      socket.send(JSON.stringify({ type: 'register', role: 'fan', fan_id: fan.id }))
    }

    socket.onmessage = (raw) => {
      const msg = JSON.parse(raw.data) as {
        type: string
        payload?: CapperEvent
        followed_cappers?: string[]
        at?: number
      }

      if (msg.type === 'registered') {
        onUpdate(() => ({
          ...localState,
          status: 'online',
          followedCappers: msg.followed_cappers ?? localState.followedCappers
        }))
        return
      }

      if (msg.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
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

        socket.send(
          JSON.stringify({
            type: 'ack',
            event_id: msg.payload.event_id,
            fan_id: fan.id
          })
        )

        onUpdate((prev) => {
          const previous = prev ?? {
            ...localState,
            inbox: [],
            followedCappers: fan.followed_cappers,
            latestLatencyMs: null,
            highlightId: null
          }
          return {
            ...previous,
            status: 'online',
            inbox: [withEntry, ...previous.inbox.slice(0, 7)],
            latestLatencyMs: receiveLatencyMs,
            highlightId: msg.payload!.event_id
          }
        })

        window.setTimeout(() => {
          onUpdate((latest) => ({
            ...(latest ?? localState),
            highlightId: latest.highlightId === msg.payload!.event_id ? null : latest.highlightId
          }))
        }, 1000)
      }
    }

    socket.onclose = () => {
      onUpdate((prev) => ({
        ...prev,
        ...localState,
        status: 'offline'
      }))
    }

    return () => {
      socket.close()
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

      <div className="inbox-list">
        {localState.inbox.length === 0 ? (
          <p className="muted">No notifications yet.</p>
        ) : (
          localState.inbox.map((entry) => (
            <div
              key={entry.event_id}
              className={
                localState.highlightId === entry.event_id ? 'inbox-item highlight' : 'inbox-item'
              }
            >
              <strong>{entry.payload.title}</strong>
              <p className="small">{entry.payload.body}</p>
              <p className="small mono">{entry.type} · {entry.receiveLatencyMs}ms</p>
            </div>
          ))
        )}
      </div>
    </article>
  )
}

export default App
