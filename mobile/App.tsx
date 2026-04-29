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

type CapperEvent = {
  event_id: string
  type: string
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

const SAMPLE_EVENT: CapperEvent = {
  event_id: 'sample-mobile-pick',
  type: 'new_pick',
  capper_name: 'SharpSide Sam',
  created_at: new Date().toISOString(),
  payload: {
    title: 'SharpSide Sam posted a live pick',
    body: 'Confidence locked with a positive edge before tip.',
    pick_id: 'sample-mobile-pick',
    market: 'NYK @ BOS - Jalen Brunson points',
    line: 'Over 27.5',
    odds: '-112',
    confidence: 74,
    status: 'open',
    deep_link: 'dubclub://picks/sample-mobile-pick'
  }
}

export default function App() {
  const [status, setStatus] = useState<'connecting' | 'online' | 'offline'>('connecting')
  const [inbox, setInbox] = useState<CapperEvent[]>([SAMPLE_EVENT])
  const [tailedPickIds, setTailedPickIds] = useState<string[]>([])
  const lastSeenEventId = useRef<string | undefined>(undefined)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    const connect = () => {
      setStatus('connecting')
      const socket = new WebSocket(WS_URL)
      socketRef.current = socket

      socket.onopen = () => {
        socket.send(JSON.stringify({
          type: 'register',
          role: 'fan',
          fan_id: FAN_ID,
          last_seen_event_id: lastSeenEventId.current
        }))
      }

      socket.onmessage = (raw) => {
        const msg = safeParse(raw.data) as FanMessage | null
        if (!msg) return

        if (msg.type === 'registered') {
          setStatus('online')
          return
        }

        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', at: Date.now() }))
          return
        }

        if (msg.type === 'capper_event') {
          const event = msg.payload
          lastSeenEventId.current = event.event_id
          setInbox((current) => [event, ...current.filter((item) => item.event_id !== event.event_id)].slice(0, 10))
          socket.send(JSON.stringify({ type: 'ack', event_id: event.event_id, fan_id: FAN_ID }))
        }
      }

      socket.onclose = () => {
        setStatus('offline')
        reconnectTimer.current = setTimeout(connect, 1500)
      }

      socket.onerror = () => {
        setStatus('offline')
      }
    }

    connect()

    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      socketRef.current?.close()
    }
  }, [])

  const latest = inbox[0]
  const tailCount = tailedPickIds.length
  const statusText = useMemo(() => {
    if (status === 'online') return 'Live'
    if (status === 'connecting') return 'Connecting'
    return 'Reconnecting'
  }, [status])

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>DubClub</Text>
            <Text style={styles.title}>Fan Inbox</Text>
          </View>
          <View style={[styles.statusPill, status === 'online' ? styles.statusOnline : styles.statusOffline]}>
            <Text style={styles.statusText}>{statusText}</Text>
          </View>
        </View>

        <View style={styles.summaryRow}>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{inbox.length}</Text>
            <Text style={styles.summaryLabel}>alerts</Text>
          </View>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{tailCount}</Text>
            <Text style={styles.summaryLabel}>tailed</Text>
          </View>
          <View style={styles.summaryTile}>
            <Text style={styles.summaryValue}>{latest?.payload.confidence ?? '--'}%</Text>
            <Text style={styles.summaryLabel}>edge</Text>
          </View>
        </View>

        {status !== 'online' ? (
          <View style={styles.reconnectBanner}>
            <Text style={styles.reconnectTitle}>Keeping your place</Text>
            <Text style={styles.reconnectText}>The app will reconnect with the last-seen event cursor.</Text>
          </View>
        ) : null}

        {inbox.map((event) => {
          const pickId = event.payload.pick_id
          const isTailed = Boolean(pickId && tailedPickIds.includes(pickId))

          return (
            <View key={event.event_id} style={styles.card}>
              <View style={styles.cardHeader}>
                <Text style={styles.capper}>{event.capper_name}</Text>
                {event.payload.status ? <Text style={styles.eventStatus}>{event.payload.status}</Text> : null}
              </View>
              <Text style={styles.cardTitle}>{event.payload.title}</Text>
              <Text style={styles.body}>{event.payload.body}</Text>

              {event.payload.market ? (
                <View style={styles.pickSlip}>
                  <Text style={styles.market}>{event.payload.market}</Text>
                  <View style={styles.pickMetaRow}>
                    <Text style={styles.pickMeta}>{event.payload.line}</Text>
                    <Text style={styles.pickMeta}>{event.payload.odds}</Text>
                    <Text style={styles.pickMeta}>{event.payload.confidence ? `${event.payload.confidence}%` : 'graded'}</Text>
                  </View>
                </View>
              ) : null}

              {event.payload.result ? <Text style={styles.outcome}>{event.payload.result}</Text> : null}
              {event.payload.reward ? <Text style={styles.outcome}>{event.payload.reward}</Text> : null}

              <View style={styles.actionRow}>
                {pickId ? (
                  <Pressable
                    disabled={isTailed}
                    style={[styles.primaryButton, isTailed ? styles.disabledButton : null]}
                    onPress={() => setTailedPickIds((current) => Array.from(new Set([...current, pickId])))}
                  >
                    <Text style={styles.primaryButtonText}>{isTailed ? 'Tailed' : 'Tail Pick'}</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  style={styles.secondaryButton}
                  onPress={() => Linking.openURL(event.payload.deep_link ?? `dubclub://picks/${pickId ?? event.event_id}`)}
                >
                  <Text style={styles.secondaryButtonText}>Open Pick</Text>
                </Pressable>
              </View>
            </View>
          )
        })}
      </ScrollView>
    </SafeAreaView>
  )
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
    padding: 20,
    gap: 16
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  brand: {
    color: '#7dd3fc',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.4
  },
  title: {
    color: '#f8fafc',
    fontSize: 34,
    fontWeight: '900'
  },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7
  },
  statusOnline: {
    backgroundColor: '#14532d'
  },
  statusOffline: {
    backgroundColor: '#713f12'
  },
  statusText: {
    color: '#f8fafc',
    fontWeight: '800'
  },
  summaryRow: {
    flexDirection: 'row',
    gap: 10
  },
  summaryTile: {
    flex: 1,
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#10233a',
    borderWidth: 1,
    borderColor: '#254260'
  },
  summaryValue: {
    color: '#f8fafc',
    fontSize: 24,
    fontWeight: '900'
  },
  summaryLabel: {
    color: '#94a3b8',
    fontWeight: '700'
  },
  reconnectBanner: {
    borderRadius: 16,
    padding: 14,
    backgroundColor: '#3b2f13',
    borderWidth: 1,
    borderColor: '#854d0e'
  },
  reconnectTitle: {
    color: '#fef3c7',
    fontWeight: '900',
    marginBottom: 4
  },
  reconnectText: {
    color: '#fde68a'
  },
  card: {
    borderRadius: 18,
    padding: 16,
    backgroundColor: '#0f1f34',
    borderWidth: 1,
    borderColor: '#2f4d6f'
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8
  },
  capper: {
    color: '#bfdbfe',
    fontWeight: '900'
  },
  eventStatus: {
    color: '#bbf7d0',
    textTransform: 'uppercase',
    fontSize: 12,
    fontWeight: '900'
  },
  cardTitle: {
    color: '#f8fafc',
    fontSize: 20,
    fontWeight: '900',
    marginBottom: 8
  },
  body: {
    color: '#cbd5e1',
    lineHeight: 20
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
    marginBottom: 10
  },
  pickMetaRow: {
    flexDirection: 'row',
    gap: 8
  },
  pickMeta: {
    flex: 1,
    color: '#dbeafe',
    backgroundColor: '#122944',
    borderRadius: 10,
    paddingVertical: 8,
    textAlign: 'center',
    fontWeight: '800'
  },
  outcome: {
    color: '#bbf7d0',
    marginTop: 10,
    fontWeight: '700'
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14
  },
  primaryButton: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
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
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#0b1626',
    borderWidth: 1,
    borderColor: '#385781'
  },
  secondaryButtonText: {
    color: '#bfdbfe',
    fontWeight: '900'
  }
})
