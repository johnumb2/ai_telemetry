import type { CSSProperties } from 'react'
import { KpiCard } from './KpiCard'
import { Sample, MetricFamily, HOST_METRICS, MetricSpec } from '../lib/derive'
import { HostStatus } from '../lib/useMetrics'
import { computeHostChips } from '../lib/helpers'

const HOST_FAMILY_COLOR: Record<'all' | MetricFamily, string> = {
  all: 'var(--text-dim)',
  cyan: 'var(--cyan)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
  violet: 'var(--violet)',
  rose: 'var(--rose)',
  green: 'var(--green)',
}

export interface HostTelemetrySectionProps {
  hostSamples: Sample[]
  hostStatus: HostStatus
}

export function HostTelemetrySection({ hostSamples, hostStatus }: HostTelemetrySectionProps) {
  const kpi = HOST_METRICS.filter((m) => m.isKpi)
  const chips = computeHostChips(hostSamples)
  const live = hostStatus === 'live'

  const chip = (label: string, value: string, color: string): JSX.Element => (
    <span className="chip-sec" style={{ '--accent': color } as CSSProperties}>
      <span className="chip-label">{label}</span>
      <span className="chip-val">{value}</span>
    </span>
  )

  return (
    <section className="kpi-section" aria-label="Host telemetry">
      <header className="panel-head host-head">
        <h2 className="panel-title">
          Host telemetry
          <span className={`host-dot pulse-dot`} data-pulse={live ? 'true' : 'false'} style={{ background: live ? 'var(--green)' : 'var(--amber)' }} />
        </h2>
        <span className="panel-sub">
          {live ? `${hostSamples.length} samples · live` : hostStatus === 'offline' ? 'sidecar offline' : 'connecting…'}
        </span>
      </header>

      <div className="kpi-grid">
        {kpi.map((m: MetricSpec) => (
          <KpiCard key={m.id} spec={m} samples={hostSamples} accent={HOST_FAMILY_COLOR[m.family]} />
        ))}
      </div>

      <div className="kpi-secondary" aria-label="Secondary host metrics">
        {chip('RAM used', chips.ramUsed === undefined ? '—' : `${chips.ramUsed.toFixed(1)} %`, 'var(--blue)')}
        {chip('GPU fan', chips.gpuFan === undefined ? '—' : `${chips.gpuFan.toFixed(0)} %`, 'var(--cyan)')}
        {chip('VRAM used', chips.vramUsedGb === undefined ? '—' : `${chips.vramUsedGb.toFixed(1)} GB`, 'var(--violet)')}
        {chip('Processes', chips.processes === undefined ? '—' : `${Math.round(chips.processes)}`, 'var(--amber)')}
        {chip('NVMe temp', chips.nvmeMax === undefined ? '—' : `${chips.nvmeMax.toFixed(1)} °C`, 'var(--rose)')}
        {chip('Uptime', chips.uptimeH === undefined ? '—' : `${Math.round(chips.uptimeH)} h`, 'var(--green)')}
      </div>
    </section>
  )
}
