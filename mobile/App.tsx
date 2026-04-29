import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Linking,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View
} from 'react-native'

type ConnectionStatus = 'connecting' | 'online' | 'offline'
type InboxFilter = 'alerts' | 'ledger'

type CapperEvent = {
  event_id: string
  type: string
  capper_name: string
  audience_segment?: string
  business_goal?: string
  delivery_channels?: string[]
  replayed?: boolean
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
}

type FanMessage =
  | { type: 'registered'; payload?: { followed_cappers?: string[] } }
  | { type: 'capper_event'; payload: CapperEvent; replayed?: boolean }
  | { type: 'ping'; at: number }
  | { type: 'control_note'; message: string }

const FAN_ID = 'fan-cara'
const WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'ws://localhost:4000'

const SAMPLE_EVENTS: CapperEvent[] = [
  {
    event_id: 'sample-live-pick',
    type: 'new_pick',
    capper_name: 'SharpSide Sam',
    audience_segment: 'premium subscribers',
    business_goal: 'time sensitive pick',
    delivery_channels: ['push', 'in app'],
    created_at: new Date().toISOString(),
    payload: {
      title: 'Live pick is ready',
      body: 'Confidence locked with a positive expected edge before tip.',
      pick_id: 'sample-live-pick',
      market: 'NYK @ BOS - Jalen Brunson points',
      line: 'Over 27.5',
      odds: '-112',
      confidence: 74,
      status: 'open',
      deep_link: 'dubclub://picks/sample-live-pick',
      trust_context: {
        capper_record: '62% last 180 tracked picks',
        pick_lifecycle: 'Open pick, line still available',
        result_ledger: 'Grades into your fan ledger after final score',
        responsible_note: 'Informational content only. Tail within your own limits.'
      }
    }
  },
  {
    event_id: 'sample-line-move',
    type: 'odds_moved',
    capper_name: 'SharpSide Sam',
    audience_segment: 'high intent fans',
    business_goal: 'line protection',
    delivery_channels: ['push', 'in app'],
    created_at: new Date(Date.now() - 1000 * 60 * 7).toISOString(),
    payload: {
      title: 'Line moved against us',
      body: 'Opening price is gone. Compare current book before tailing.',
      pick_id: 'sample-line-move',
      market: 'LAD @ CHC - first five innings total',
      line: 'Under 4.5',
      odds: '+102 -> -118',
      confidence: 68,
      status: 'moved',
      deep_link: 'dubclub://picks/sample-line-move',
      trust_context: {
        capper_record: '62% last 180 tracked picks',
        pick_lifecycle: 'Moved line, compare current price',
        result_ledger: 'Closing-line value tracked for subscribers',
        responsible_note: 'Odds movement is context, not a guarantee.'
      }
    }
  },
  {
    event_id: 'sample-result',
    type: 'result_posted',
    capper_name: 'Courtside Kelly',
    audience_segment: 'all followers',
    business_goal: 'trust',
    delivery_channels: ['email', 'in app'],
    created_at: new Date(Date.now() - 1000 * 60 * 45).toISOString(),
    payload: {
      title: 'Result graded',
      body: 'Pick closed and your ledger has the final unit result.',
      pick_id: 'sample-result',
      market: 'BOS moneyline',
      line: 'Closed -135',
      odds: '-122',
      status: 'graded',
      result: 'Won by 8. Fan ledger updated +0.82u.',
      deep_link: 'dubclub://picks/sample-result',
      trust_context: {
        capper_record: '+18.4u last 90 days',
        pick_lifecycle: 'Graded and locked',
        result_ledger: 'Ledger includes price, close, result, and unit outcome',
        responsible_note: 'Transparent grading builds trust across wins and losses.'
      }
    }
  },
  {
    event_id: 'sample-reward',
    type: 'reward_unlocked',
    capper_name: 'DubClub',
    audience_segment: 'at risk fans',
    business_goal: 'retention',
    delivery_channels: ['push', 'email', 'in app'],
    created_at: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
    payload: {
      title: 'Weekend reward unlocked',
      body: 'Your third tailed win unlocked a new subscriber reward.',
      status: 'reward',
      reward: '3-day premium trial available in rewards.',
      deep_link: 'dubclub://rewards/weekend-bonus',
      trust_context: {
        pick_lifecycle: 'Reward surfaced after fan engagement',
        result_ledger: 'Reward tied to tailed-result history',
        responsible_note: 'Rewards should add community value without encouraging over-spend.'
      }
    }
  }
]

export default function App() {
  const [status, setStatus] = useState<ConnectionStatus>('connecting')
  const [inbox, setInbox] = useState<CapperEvent[]>(SAMPLE_EVENTS)
  const [tailedPickIds, setTailedPickIds] = useState<string[]>(['sample-result'])
  const [filter, setFilter] = useState<InboxFilter>('alerts')
  const [lastControlNote, setLastControlNote] = useState<string>('Last-seen cursor ready for reconnect replay.')
  const lastSeenEventId = useRef<string | undefined>(SAMPLE_EVENTS[0]?.event_id)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    let shouldReconnect = true

    const connect = () => {
      setStatus('connecting')
      const socket = new WebSocket(WS_URL)
      socketRef.current = socket

      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            type: 'register',
            role: 'fan',
            fan_id: FAN_ID,
            last_seen_event_id: lastSeenEventId.current
          })
        )
      }

      socket.onmessage = (raw) => {
        const msg = safeParse(raw.data) as FanMessage | null
        if (!msg) return

        if (msg.type === 'registered') {
          setStatus('online')
          setLastControlNote('Live socket registered. Cursor will protect reconnects.')
          return
        }

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
          return
        }

        if (msg.type === 'control_note') {
          setLastControlNote(msg.message)
          return
        }

        if (msg.type === 'capper_event') {
          const event = { ...msg.payload, replayed: msg.replayed }
          lastSeenEventId.current = event.event_id
          setInbox((current) => [event, ...current.filter((item) => item.event_id !== event.event_id)].slice(0, 12))
          setFilter('alerts')
          socket.send(JSON.stringify({ type: 'ack', event_id: event.event_id, fan_id: FAN_ID }))
        }
      }

      socket.onclose = () => {
        setStatus('offline')
        if (shouldReconnect) {
          reconnectTimer.current = setTimeout(connect, 1500)
        }
      }

      socket.onerror = () => {
        setStatus('offline')
      }
    }

    connect()

    return () => {
      shouldReconnect = false
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      socketRef.current?.close()
    }
  }, [])

  const visibleInbox = useMemo(() => {
    if (filter === 'ledger') {
      return inbox.filter((event) => event.payload.status === 'graded' || event.payload.status === 'reward')
    }
    return inbox.filter((event) => event.payload.status !== 'graded' && event.payload.status !== 'reward')
  }, [filter, inbox])

  const stats = useMemo(() => {
    const openAlerts = inbox.filter((event) => event.payload.status === 'open' || event.payload.status === 'moved').length
    const ledgerItems = inbox.filter((event) => event.payload.status === 'graded' || event.payload.status === 'reward').length
    const latestConfidence = inbox.find((event) => typeof event.payload.confidence === 'number')?.payload.confidence

    return {
      openAlerts,
      ledgerItems,
      latestConfidence,
      tailedCount: tailedPickIds.length
    }
  }, [inbox, tailedPickIds.length])

  const statusText = useMemo(() => {
    if (status === 'online') return 'Live'
    if (status === 'connecting') return 'Connecting'
    return 'Reconnecting'
  }, [status])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.brand}>DubClub</Text>
            <Text style={styles.title}>Trust Inbox</Text>
            <Text style={styles.subtitle}>Fast picks, clear context, and a ledger fans can trust.</Text>
          </View>
          <View style={[styles.statusPill, status === 'online' ? styles.statusOnline : styles.statusOffline]}>
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
        </View>

        <View style={styles.summaryRow}>
          <SummaryTile value={String(stats.openAlerts)} label="live alerts" tone="blue" />
          <SummaryTile value={String(stats.tailedCount)} label="tailed" tone="green" />
          <SummaryTile value={stats.latestConfidence ? `${stats.latestConfidence}%` : '--'} label="edge" tone="amber" />
        </View>

        <View style={styles.connectionCard}>
          <View>
            <Text style={styles.connectionTitle}>Realtime delivery</Text>
            <Text style={styles.connectionBody}>{lastControlNote}</Text>
          </View>
          <Text style={styles.cursorText}>{lastSeenEventId.current?.slice(0, 8) ?? 'no cursor'}</Text>
        </View>

        <View style={styles.guardrailCard}>
          <Text style={styles.guardrailTitle}>Fan guardrail</Text>
          <Text style={styles.guardrailBody}>
            DubClub can make tailing smoother without making it reckless. Every actionable alert keeps
            record, lifecycle, and limit context close to the decision.
          </Text>
        </View>

        <View style={styles.segmentedControl}>
          <SegmentButton
            active={filter === 'alerts'}
            label="Alerts"
            count={stats.openAlerts}
            onPress={() => setFilter('alerts')}
          />
          <SegmentButton
            active={filter === 'ledger'}
            label="Ledger"
            count={stats.ledgerItems}
            onPress={() => setFilter('ledger')}
          />
        </View>

        {visibleInbox.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>Nothing here yet</Text>
            <Text style={styles.emptyBody}>New capper activity will land here with replay-safe delivery.</Text>
          </View>
        ) : (
          visibleInbox.map((event) => {
            const pickId = event.payload.pick_id
            const isTailed = Boolean(pickId && tailedPickIds.includes(pickId))

            return (
              <EventCard
                event={event}
                isTailed={isTailed}
                key={event.event_id}
                onOpen={() => openDeepLink(event)}
                onTail={() => {
                  if (!pickId) return
                  setTailedPickIds((current) => Array.from(new Set([...current, pickId])))
                }}
              />
            )
          })
        )}
      </ScrollView>
    </SafeAreaView>
  )
}

function SummaryTile({ value, label, tone }: { value: string; label: string; tone: 'blue' | 'green' | 'amber' }) {
  return (
    <View style={[styles.summaryTile, styles[`summaryTile_${tone}`]]}>
      <Text style={styles.summaryValue}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  )
}

function SegmentButton({
  active,
  label,
  count,
  onPress
}: {
  active: boolean
  label: string
  count: number
  onPress: () => void
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      hitSlop={8}
      onPress={onPress}
      style={[styles.segmentButton, active ? styles.segmentButtonActive : null]}
    >
      <Text style={[styles.segmentText, active ? styles.segmentTextActive : null]}>{label}</Text>
      <Text style={[styles.segmentCount, active ? styles.segmentTextActive : null]}>{count}</Text>
    </Pressable>
  )
}

function EventCard({
  event,
  isTailed,
  onOpen,
  onTail
}: {
  event: CapperEvent
  isTailed: boolean
  onOpen: () => void
  onTail: () => void
}) {
  const pickId = event.payload.pick_id
  const canTail = Boolean(pickId && event.payload.status !== 'graded')

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View>
          <Text style={styles.capper}>{event.capper_name}</Text>
          <Text style={styles.timestamp}>{formatAge(event.created_at)}</Text>
        </View>
        <View style={[styles.eventStatus, styles[`status_${event.payload.status ?? 'open'}`]]}>
          <Text style={styles.eventStatusText}>{event.payload.status ?? 'note'}</Text>
        </View>
      </View>

      <Text style={styles.cardTitle}>{event.payload.title}</Text>
      <Text style={styles.body}>{event.payload.body}</Text>

      <View style={styles.intentRow}>
        {event.business_goal ? <Text style={styles.intentPill}>{event.business_goal}</Text> : null}
        {event.audience_segment ? <Text style={styles.intentPill}>{event.audience_segment}</Text> : null}
        {event.replayed ? <Text style={styles.replayPill}>replayed</Text> : null}
      </View>

      {event.payload.market ? <PickSlip event={event} /> : null}
      {event.payload.result ? <Text style={styles.outcome}>{event.payload.result}</Text> : null}
      {event.payload.reward ? <Text style={styles.reward}>{event.payload.reward}</Text> : null}
      {event.payload.trust_context ? <TrustPanel event={event} /> : null}

      <View style={styles.actionRow}>
        {canTail ? (
          <Pressable
            accessibilityRole="button"
            disabled={isTailed}
            hitSlop={6}
            onPress={onTail}
            style={[styles.primaryButton, isTailed ? styles.disabledButton : null]}
          >
            <Text style={styles.primaryButtonText}>{isTailed ? 'Tailed' : 'Tail Pick'}</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="link" hitSlop={6} onPress={onOpen} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>{event.payload.status === 'reward' ? 'Open Reward' : 'Open Pick'}</Text>
        </Pressable>
      </View>
    </View>
  )
}

function PickSlip({ event }: { event: CapperEvent }) {
  return (
    <View style={styles.pickSlip}>
      <Text style={styles.market}>{event.payload.market}</Text>
      <View style={styles.pickMetaRow}>
        <View style={styles.pickMeta}>
          <Text style={styles.pickMetaLabel}>Line</Text>
          <Text style={styles.pickMetaValue}>{event.payload.line}</Text>
        </View>
        <View style={styles.pickMeta}>
          <Text style={styles.pickMetaLabel}>Odds</Text>
          <Text style={styles.pickMetaValue}>{event.payload.odds}</Text>
        </View>
        <View style={styles.pickMeta}>
          <Text style={styles.pickMetaLabel}>Edge</Text>
          <Text style={styles.pickMetaValue}>{event.payload.confidence ? `${event.payload.confidence}%` : 'graded'}</Text>
        </View>
      </View>
    </View>
  )
}

function TrustPanel({ event }: { event: CapperEvent }) {
  const trust = event.payload.trust_context
  if (!trust) return null

  return (
    <View style={styles.trustPanel}>
      <Text style={styles.trustTitle}>Trust context</Text>
      {trust.capper_record ? <Text style={styles.trustText}>{trust.capper_record}</Text> : null}
      {trust.pick_lifecycle ? <Text style={styles.trustText}>{trust.pick_lifecycle}</Text> : null}
      {trust.result_ledger ? <Text style={styles.trustText}>{trust.result_ledger}</Text> : null}
      {trust.responsible_note ? <Text style={styles.trustNote}>{trust.responsible_note}</Text> : null}
    </View>
  )
}

function openDeepLink(event: CapperEvent) {
  const pickId = event.payload.pick_id ?? event.event_id
  const url = event.payload.deep_link ?? `dubclub://picks/${pickId}`
  void Linking.openURL(url)
}

function formatAge(value: string): string {
  const diffMs = Math.max(0, Date.now() - Date.parse(value))
  const minutes = Math.floor(diffMs / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

function safeParse(raw: string) {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#07111f'
  },
  content: {
    padding: 18,
    paddingBottom: 34,
    gap: 14
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 14
  },
  headerText: {
    flex: 1
  },
  brand: {
    color: '#7dd3fc',
    fontSize: 14,
    fontWeight: '900',
    letterSpacing: 0.3
  },
  title: {
    color: '#f8fafc',
    fontSize: 34,
    fontWeight: '900',
    lineHeight: 38
  },
  subtitle: {
    color: '#a9b7cc',
    fontSize: 14,
    lineHeight: 19,
    marginTop: 4
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  statusOnline: {
    backgroundColor: '#14532d'
  },
  statusOffline: {
    backgroundColor: '#713f12'
  },
  statusText: {
    color: '#f8fafc',
    fontWeight: '900'
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 10
  },
  summaryTile: {
    flex: 1,
    borderRadius: 14,
    padding: 13,
    borderWidth: 1
  },
  summaryTile_blue: {
    backgroundColor: '#10233a',
    borderColor: '#254260'
  },
  summaryTile_green: {
    backgroundColor: '#102a21',
    borderColor: '#1e5d45'
  },
  summaryTile_amber: {
    backgroundColor: '#2c2110',
    borderColor: '#7c4d12'
  },
  summaryValue: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '900'
  },
  summaryLabel: {
    color: '#b7c4d8',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 2
  },
  connectionCard: {
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#0f1f34',
    borderWidth: 1,
    borderColor: '#2f4d6f',
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12
  },
  connectionTitle: {
    color: '#f8fafc',
    fontWeight: '900',
    marginBottom: 4
  },
  connectionBody: {
    color: '#c6d3e2',
    lineHeight: 19,
    maxWidth: 230
  },
  cursorText: {
    color: '#93c5fd',
    fontFamily: 'Courier',
    fontWeight: '900'
  },
  guardrailCard: {
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#2b2110',
    borderWidth: 1,
    borderColor: '#7c4d12'
  },
  guardrailTitle: {
    color: '#fef3c7',
    fontWeight: '900',
    marginBottom: 5
  },
  guardrailBody: {
    color: '#fde68a',
    lineHeight: 20
  },
  segmentedControl: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: 14,
    backgroundColor: '#0b1626',
    borderWidth: 1,
    borderColor: '#233852'
  },
  segmentButton: {
    flex: 1,
    minHeight: 44,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8
  },
  segmentButtonActive: {
    backgroundColor: '#1d4ed8'
  },
  segmentText: {
    color: '#9fb0ce',
    fontWeight: '900'
  },
  segmentTextActive: {
    color: '#f8fafc'
  },
  segmentCount: {
    color: '#9fb0ce',
    fontWeight: '900'
  },
  emptyCard: {
    borderRadius: 16,
    padding: 18,
    backgroundColor: '#0f1f34',
    borderWidth: 1,
    borderColor: '#2f4d6f'
  },
  emptyTitle: {
    color: '#f8fafc',
    fontWeight: '900',
    fontSize: 18
  },
  emptyBody: {
    color: '#c6d3e2',
    marginTop: 6
  },
  card: {
    borderRadius: 18,
    padding: 16,
    backgroundColor: '#0f1f34',
    borderWidth: 1,
    borderColor: '#2f4d6f',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 10
  },
  capper: {
    color: '#bfdbfe',
    fontSize: 15,
    fontWeight: '900'
  },
  timestamp: {
    color: '#8ea2bd',
    marginTop: 2,
    fontSize: 12,
    fontWeight: '700'
  },
  eventStatus: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  status_open: {
    backgroundColor: '#14532d'
  },
  status_moved: {
    backgroundColor: '#78350f'
  },
  status_graded: {
    backgroundColor: '#155e75'
  },
  status_reward: {
    backgroundColor: '#5b21b6'
  },
  eventStatusText: {
    color: '#f8fafc',
    textTransform: 'uppercase',
    fontSize: 11,
    fontWeight: '900'
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 21,
    fontWeight: '900',
    lineHeight: 25,
    marginBottom: 8
  },
  body: {
    color: '#cbd5e1',
    lineHeight: 20
  },
  intentRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 12
  },
  intentPill: {
    color: '#dbeafe',
    backgroundColor: '#172a45',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: '800'
  },
  replayPill: {
    color: '#bbf7d0',
    backgroundColor: '#14532d',
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
    fontSize: 12,
    fontWeight: '900'
  },
  pickSlip: {
    borderRadius: 14,
    padding: 12,
    marginTop: 14,
    backgroundColor: '#071827',
    borderWidth: 1,
    borderColor: '#244361'
  },
  market: {
    color: '#f8fafc',
    fontWeight: '900',
    marginBottom: 11
  },
  pickMetaRow: {
    flexDirection: 'row',
    gap: 8
  },
  pickMeta: {
    flex: 1,
    backgroundColor: '#122944',
    borderRadius: 10,
    paddingVertical: 8,
    paddingHorizontal: 6,
    alignItems: 'center'
  },
  pickMetaLabel: {
    color: '#93a8c7',
    fontSize: 11,
    fontWeight: '800',
    marginBottom: 2
  },
  pickMetaValue: {
    color: '#dbeafe',
    textAlign: 'center',
    fontWeight: '900'
  },
  outcome: {
    color: '#bbf7d0',
    marginTop: 11,
    fontWeight: '800',
    lineHeight: 19
  },
  reward: {
    color: '#e9d5ff',
    marginTop: 11,
    fontWeight: '800',
    lineHeight: 19
  },
  trustPanel: {
    borderLeftWidth: 3,
    borderLeftColor: '#f59e0b',
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
    backgroundColor: '#352910',
    gap: 4
  },
  trustTitle: {
    color: '#fef3c7',
    fontWeight: '900',
    marginBottom: 2
  },
  trustText: {
    color: '#fde68a',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '700'
  },
  trustNote: {
    color: '#fef9c3',
    fontSize: 12,
    lineHeight: 17,
    fontWeight: '900'
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14
  },
  primaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#2563eb'
  },
  disabledButton: {
    backgroundColor: '#334155'
  },
  primaryButtonText: {
    color: '#f8fafc',
    fontWeight: '900'
  },
  secondaryButton: {
    flex: 1,
    minHeight: 48,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0b1626',
    borderWidth: 1,
    borderColor: '#385781'
  },
  secondaryButtonText: {
    color: '#bfdbfe',
    fontWeight: '900'
  }
})
