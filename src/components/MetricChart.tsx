import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { AreaChart } from './AreaChart'
import { METRICS, MetricFamily, Sample, specSeries } from '../lib/derive'
import { Parsed, seriesKey } from '../types'

const FAMILY_COLOR: Record<MetricFamily, string> = {
  cyan: 'var(--cyan)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
  violet: 'var(--violet)',
  rose: 'var(--rose)',
  green: 'var(--green)',
}

interface RawOption {
  key: string
  base: string
  labels: Record<string, string>
}

function fmtShort(v: number): string {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k'
  if (Math.abs(v) < 1 && v !== 0) return v.toPrecision(2)
  return v.toFixed(2)
}

function keyForLabels(base: string, labels: Record<string, string>): string {
  return seriesKey(base, labels)
}

function labelsObj(l: Record<string, string> | undefined): Record<string, string> {
  return l ?? {}
}

export interface MetricChartProps {
  samples: Sample[]
  parsed: Parsed | null
  selectedMetric: string
  onSelectedMetric: (id: string) => void
  demoAutoOffered: boolean
  onEnableDemo: () => void
}

export function MetricChart({ samples, parsed, selectedMetric, onSelectedMetric, demoAutoOffered, onEnableDemo }: MetricChartProps) {
  const rawOptions: RawOption[] = useMemo(() => {
    if (!parsed) return []
    const seen = new Map<string, RawOption>()
    for (const s of parsed.series) {
      const labels = s.labels
      const key = keyForLabels(s.name, labels)
      if (!seen.has(key)) {
        seen.set(key, { key, base: s.name, labels })
      }
    }
    return Array.from(seen.values())
  }, [parsed])

  const isRaw = useMemo(() => rawOptions.some((r) => r.key === selectedMetric), [rawOptions, selectedMetric])
  const rawOpt = isRaw ? rawOptions.find((r) => r.key === selectedMetric) : undefined
  const spec = useMemo(() => METRICS.find((m) => m.id === selectedMetric), [selectedMetric, isRaw])

  const meta = useMemo(() => {
    if (isRaw && rawOpt) return { accent: 'var(--text-dim)', label: rawOpt.base + (Object.keys(rawOpt.labels).length ? ` {${Object.entries(labelsObj(rawOpt.labels)).map(([k, v]) => `${k}=${v}`).join(', ')}}` : ''), unit: '' }
    if (spec) return { accent: FAMILY_COLOR[spec.family], label: spec.label, unit: spec.unit }
    return { accent: 'var(--text-dim)', label: 'select a metric', unit: '' }
  }, [isRaw, rawOpt, spec])

  const seriesPoints = useMemo(() => {
    if (isRaw && rawOpt) {
      const out: Array<{ t: number; v: number }> = []
      for (const s of samples) {
        const v = s.values[rawOpt.key]
        if (v !== undefined) out.push({ t: s.t, v })
      }
      return out
    }
    if (spec) return specSeries(spec, samples)
    return []
  }, [isRaw, rawOpt, spec, samples])

  const currentLabel = useMemo(() => {
    const last = seriesPoints[seriesPoints.length - 1]
    if (!last) return '—'
    return fmtShort(last.v) + (meta.unit ? ' ' + meta.unit : '')
  }, [seriesPoints, meta.unit])

  return (
    <section className="panel chart-panel">
      <header className="panel-head">
        <h2 className="panel-title">Live telemetry</h2>
        <div className="chart-controls">
          <label className="chart-label" htmlFor="metric-select">Metric</label>
          <select
            id="metric-select"
            className="metric-select"
            value={selectedMetric}
            onChange={(e) => onSelectedMetric(e.target.value)}
            aria-label="Select metric"
          >
            <optgroup label="Derived series">
              {METRICS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Raw metric…">
              {rawOptions.map((r) => {
                const lbl = Object.entries(labelsObj(r.labels)).map(([k, v]) => `${k}=${v}`).join(', ')
                return (
                  <option key={r.key} value={r.key}>
                    {r.base}{lbl ? ` {${lbl}}` : ''}
                  </option>
                )
              })}
            </optgroup>
          </select>
        </div>
      </header>
      <div className="chart-body">
        <div className="chart-readout">
          <span className="readout-val" style={{ color: meta.accent } as CSSProperties}>{currentLabel}</span>
          <span className="readout-unit">{meta.label}</span>
        </div>
        <div className="chart-svg">
          <AreaChart points={seriesPoints} accent={meta.accent} formatValue={fmtShort} unit={meta.unit} />
        </div>
      </div>
      {demoAutoOffered && (
        <div className="demo-offer">
          <span>Endpoint offline. Watch a simulated model server instead?</span>
          <button type="button" className="btn-mini" onClick={onEnableDemo}>
            Enable demo data
          </button>
        </div>
      )}
    </section>
  )
}
