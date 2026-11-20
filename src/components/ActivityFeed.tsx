import type { CSSProperties } from 'react'
import { EventEntry } from '../lib/useMetrics'

const EVENT_META: Record<EventEntry['kind'], { label: string; color: string }> = {
  req: { label: 'request', color: 'var(--blue)' },
  tokens: { label: 'tokens', color: 'var(--cyan)' },
  preempt: { label: 'preemption', color: 'var(--rose)' },
  state: { label: 'engine', color: 'var(--violet)' },
  conn: { label: 'connection', color: 'var(--amber)' },
  rate: { label: 'rate', color: 'var(--green)' },
}

function fmtTime(t: number): string {
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => n.toString().padStart(2, '0')).join(':')
}

export interface ActivityFeedProps {
  events: EventEntry[]
}

export function ActivityFeed({ events }: ActivityFeedProps) {
  return (
    <section className="panel feed-panel">
      <header className="panel-head">
        <h2 className="panel-title">Activity</h2>
        <span className="panel-sub" aria-hidden="true">live · {events.length} events</span>
      </header>
      <ol
        className="feed-list"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Live event activity"
      >
        {events.length === 0 && <li className="feed-empty">waiting for the first poll…</li>}
        {events.map((e) => {
          const m = EVENT_META[e.kind]
          return (
            <li key={e.id} className="feed-row" style={{ accentColor: m.color } as CSSProperties} data-accent={m.color}>
              <time className="feed-time" dateTime={new Date(e.t).toISOString()}>
                {fmtTime(e.t)}
              </time>
              <span className="feed-tag">{m.label}</span>
              <span className="feed-msg">{e.msg}</span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
