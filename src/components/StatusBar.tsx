import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { ConnStatus } from '../lib/useMetrics'
import { pollMsPresets } from '../lib/settings'
import { UserMenu } from './UserMenu'

export interface StatusBarProps {
  status: ConnStatus
  endpoint: string
  pollMs: number
  lastUpdated: number | null
  fetchLatency: number | null
  hint: string | null
  settings: {
    demo: boolean
    onToggleDemo: () => void
    onSetEndpoint: (ep: string) => void
    onSetPollMs: (ms: number) => void
  }
}

const STATUS_META: Record<ConnStatus, { label: string; color: string; pulse: boolean }> = {
  live: { label: 'LIVE', color: 'var(--green)', pulse: true },
  reconnecting: { label: 'RECONNECTING', color: 'var(--amber)', pulse: true },
  offline: { label: 'OFFLINE', color: 'var(--rose)', pulse: false },
  demo: { label: 'DEMO', color: 'var(--violet)', pulse: true },
}

/** Plain-language meaning of each status-dot state, shown in the legend. */
const STATUS_LEGEND: Record<ConnStatus, string> = {
  live: 'every poll got a successful response from the metrics endpoint',
  reconnecting: 'the last poll failed — the app is retrying every poll interval',
  offline: 'failed 4+ polls in a row — the endpoint is down or the URL is wrong',
  demo: 'no real endpoint — data is simulated, not measured',
}

function fmtClock(t: number | null): string {
  if (t === null) return '--:--:--'
  const d = new Date(t)
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => n.toString().padStart(2, '0')).join(':')
}

export function StatusBar({ status, endpoint, pollMs, lastUpdated, fetchLatency, hint, settings }: StatusBarProps) {
  const [open, setOpen] = useState(false)
  const [epDraft, setEpDraft] = useState(endpoint)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => setEpDraft(endpoint), [endpoint])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const meta = STATUS_META[status]

  return (
    <div className={`status-bar status-${status}`} role="status" aria-live="polite">
      <div className="status-left">
        <span className="wordmark" aria-hidden="true">PULSE</span>
        <span className="pulse-dot" data-pulse={meta.pulse} style={{ backgroundColor: meta.color, color: meta.color } as CSSProperties} title={STATUS_LEGEND[status]} />
        <span className="status-label" style={{ color: meta.color }} title={`${meta.label} — ${STATUS_LEGEND[status]}`}>{meta.label}</span>
        {hint && <span className="status-hint" title={hint}>{hint}</span>}
        <span className="status-legend">
          <span className="status-legend-chip" title="green = receiving data" style={{ color: 'var(--green)' }}>
            <span className="status-legend-dot" style={{ backgroundColor: 'var(--green)' }} />
            live
          </span>
          <span className="status-legend-chip" title="amber = a poll failed, retrying" style={{ color: 'var(--amber)' }}>
            <span className="status-legend-dot" style={{ backgroundColor: 'var(--amber)' }} />
            retrying
          </span>
          <span className="status-legend-chip" title="red = endpoint unreachable" style={{ color: 'var(--rose)' }}>
            <span className="status-legend-dot" style={{ backgroundColor: 'var(--rose)' }} />
            offline
          </span>
          <span className="status-legend-chip" title="violet = simulated data" style={{ color: 'var(--violet)' }}>
            <span className="status-legend-dot" style={{ backgroundColor: 'var(--violet)' }} />
            demo
          </span>
        </span>
      </div>

      <div className="status-center">
        <code className="endpoint" title={endpoint}>{endpoint}</code>
        <span className="meta-chip" title="fetch latency in milliseconds">
          <span className="meta-dot" />
          {fetchLatency === null ? '—' : `${Math.round(fetchLatency)}ms`}
        </span>
        <span className="meta-chip" title="last update time">upd {fmtClock(lastUpdated)}</span>
      </div>

      <div className="status-right" ref={ref}>
        <span className="poll-readout" title="poll interval">poll {pollMs / 1000 < 1 ? (pollMs / 1000).toFixed(1) + 's' : (pollMs / 1000).toFixed(0) + 's'}</span>
        <button
          type="button"
          className="iconbtn"
          aria-label="Open settings"
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1l2.1-2.1M17 7l2.1-2.1" />
          </svg>
        </button>
        {open && (
          <div className="settings-pop" role="dialog" aria-label="Settings">
            <div className="settings-row">
              <label className="settings-label" htmlFor="pulse-ep">Endpoint</label>
              <input
                id="pulse-ep"
                className="settings-input"
                type="text"
                value={epDraft}
                spellCheck={false}
                onChange={(e) => setEpDraft(e.target.value)}
                onBlur={() => settings.onSetEndpoint(epDraft.trim() || endpoint)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') settings.onSetEndpoint(epDraft.trim() || endpoint)
                }}
              />
            </div>
            <div className="settings-row">
              <span className="settings-label">Poll interval</span>
              <div className="pill-row">
                {pollMsPresets().map((p) => (
                  <button
                    key={p.ms}
                    type="button"
                    className={`pill ${pollMs === p.ms ? 'pill-active' : ''}`}
                    onClick={() => settings.onSetPollMs(p.ms)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="settings-row">
              <span className="settings-label">Demo data</span>
              <button
                type="button"
                className={`pill ${settings.demo ? 'pill-active pill-demo' : ''}`}
                aria-pressed={settings.demo}
                onClick={settings.onToggleDemo}
              >
                {settings.demo ? 'Simulating' : 'Simulate'}
              </button>
            </div>
            <p className="settings-note">
              Tip: the dev-server proxies <code>/metrics</code> to the vLLM host with zero CORS. Use an absolute cross-origin
              URL and enable CORS there if you want to bypass the proxy.
            </p>
          </div>
        )}
        <UserMenu />
      </div>
    </div>
  )
}
