import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { useMetrics } from './lib/useMetrics'
import { useAuth } from './lib/useAuth'
import { computeSecondaryChips } from './lib/helpers'
import { METRICS, MetricFamily } from './lib/derive'
import { Parsed } from './types'
import { KpiCard } from './components/KpiCard'
import { ActivityFeed } from './components/ActivityFeed'
import { MetricsExplorer } from './components/MetricsExplorer'
import { MetricChart } from './components/MetricChart'
import { StatusBar } from './components/StatusBar'
import { HostTelemetrySection } from './components/HostTelemetrySection'
import { HistorySection } from './components/HistorySection'
import { LoginPage } from './components/LoginPage'

const FAMILY_COLOR: Record<MetricFamily, string> = {
  cyan: 'var(--cyan)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
  violet: 'var(--violet)',
  rose: 'var(--rose)',
  green: 'var(--green)',
}

export default function App() {
  const { user, status: authStatus } = useAuth()
  // The password-reset link (email → ?token=...) is handled before auth.
  const token = useMemo(() => new URLSearchParams(window.location.search).get('token'), [])

  // While the session is being resolved, show a splash so the dashboard
  // (which needs credentials for /metrics) does not flash or 401.
  if (authStatus === 'loading') {
    return (
      <div className="auth-splash">
        <span className="auth-splash-wordmark">PULSE</span>
        <span className="auth-splash-hint">Loading…</span>
      </div>
    )
  }

  // Signed out: show the login / forgot-password / reset form.
  if (authStatus === 'out' || !user) {
    return (
      <LoginPage
        token={token}
        onResetDone={() => {
          // Clear the one-time token so re-loading shows the login screen.
          const url = new URL(window.location.href)
          url.searchParams.delete('token')
          window.history.replaceState({}, '', url.toString())
        }}
      />
    )
  }

  return <Dashboard />
}

function Dashboard() {
  const { state, settings, enableDemo, disableDemo, setEndpoint, setPollMs, setSelectedChartMetric } = useMetrics()
  const chips = computeSecondaryChips(state.samples)
  const kpi = METRICS.filter((m) => m.isKpi)

  // Merge the vLLM scrape with the host sidecar scrape so the Metrics Explorer
  // surfaces host_gpu_/host_cpu_ gauges alongside the vLLM series in one table.
  const mergedParsed = useMemo<Parsed | null>(() => {
    const primary = state.parsed
    const host = state.hostParsed
    if (!primary && !host) return null
    if (!host) return primary
    if (!primary) return host
    return {
      values: { ...host.values, ...primary.values },
      types: { ...host.types, ...primary.types },
      help: { ...host.help, ...primary.help },
      series: [...host.series, ...primary.series],
    }
  }, [state.parsed, state.hostParsed])

  return (
    <div className="app-shell">
      <StatusBar
        status={state.status}
        endpoint={settings.endpoint}
        pollMs={settings.pollMs}
        lastUpdated={state.lastUpdated}
        fetchLatency={state.fetchLatency}
        hint={state.hint}
        settings={{
          demo: settings.demo,
          onToggleDemo: settings.demo ? disableDemo : enableDemo,
          onSetEndpoint: setEndpoint,
          onSetPollMs: setPollMs,
        }}
      />

      <main className="app-main">
        <section className="kpi-section" aria-label="Key performance indicators">
          <div className="kpi-grid">
            {kpi.map((m) => (
              <KpiCard key={m.id} spec={m} samples={state.samples} accent={FAMILY_COLOR[m.family]} />
            ))}
          </div>

          <div className="kpi-secondary" aria-label="Secondary metrics">
            <SecondaryChip
              label="Spec-decode accept"
              value={chips.specAccept === undefined ? '—' : `${(chips.specAccept * 100).toFixed(1)} %`}
              color="var(--green)"
            />
            <SecondaryChip
              label="Prefix-cache hit"
              value={chips.prefixHit === undefined ? '—' : `${(chips.prefixHit * 100).toFixed(1)} %`}
              color="var(--green)"
            />
            <SecondaryChip
              label="Engine"
              value={chips.engine === 'unknown' ? '—' : chips.engine === 'awake' ? 'AWAKE' : 'SLEEPING'}
              color={chips.engine === 'awake' ? 'var(--green)' : 'var(--violet)'}
            />
            <SecondaryChip label="Preemptions" value={String(Math.round(chips.preemptions ?? 0))} color="var(--rose)" />
          </div>
        </section>

        <MetricChart
          samples={state.samples}
          parsed={state.parsed}
          selectedMetric={settings.selectedChartMetric}
          onSelectedMetric={setSelectedChartMetric}
          demoAutoOffered={state.demoAutoOffered}
          onEnableDemo={enableDemo}
        />

        <HostTelemetrySection hostSamples={state.hostSamples} hostStatus={state.hostStatus} />

        <HistorySection />

        <div className="two-col">
          <MetricsExplorer parsed={mergedParsed} />
          <ActivityFeed events={state.events} />
        </div>
      </main>

      <footer className="app-footer" aria-label="Status footer">
        <span>
          Polling every {(settings.pollMs / 1000).toFixed(1)}s · {state.samples.length} samples (cap 240)
        </span>
        <a className="footer-link" href={settings.endpoint} target="_blank" rel="noreferrer">
          {settings.endpoint}
        </a>
      </footer>
    </div>
  )
}

function SecondaryChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <span className="chip-sec" style={{ '--accent': color } as CSSProperties}>
      <span className="chip-label">{label}</span>
      <span className="chip-val">{value}</span>
    </span>
  )
}
