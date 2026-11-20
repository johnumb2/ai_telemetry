import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { Sample, specSeries, MetricSpec } from '../lib/derive'
import { Sparkline } from './Sparkline'

export interface KpiCardProps {
  spec: MetricSpec
  samples: Sample[]
  accent: string
}

export function KpiCard({ spec, samples, accent }: KpiCardProps) {
  const { cur, delta } = useMemo(() => {
    if (samples.length === 0) return { cur: undefined as number | undefined, delta: undefined as number | undefined }
    const series = specSeries(spec, samples)
    const last = series[series.length - 1]?.v
    const prev = series[series.length - 2]?.v
    return {
      cur: last,
      delta: last !== undefined && prev !== undefined ? last - prev : undefined,
    }
  }, [spec, samples])

  const spark = useMemo(
    () => (samples.length === 0 ? [] : specSeries(spec, samples).slice(-40)),
    [spec, samples],
  )

  const deltaStr = useMemo(() => {
    if (delta === undefined) return ''
    if (Math.abs(delta) < 1e-6) return '· steady'
    const up = delta > 0
    const abs = Math.abs(delta)
    const num = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1)
    return `${up ? '▲' : '▼'} ${num}`
  }, [delta])

  const fmt = (v: number): string => {
    if (spec.unit === '%') return v.toFixed(1)
    if (Math.abs(v) < 1 && v !== 0) return v.toPrecision(2)
    return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  }

  return (
    <article className="kpi-card" style={{ '--accent': accent } as CSSProperties}>
      <header className="kpi-head">
        <span className="kpi-label">{spec.label}</span>
        <span className={`kpi-delta ${delta !== undefined && delta !== 0 ? (delta > 0 ? 'up' : 'down') : 'flat'}`}>{deltaStr}</span>
      </header>
      <div className="kpi-value-wrap">
        <span className="num" data-live="true">{cur === undefined ? '—' : fmt(cur)}</span>
        {spec.unit && <span className="kpi-unit">{spec.unit}</span>}
      </div>
      <div className="kpi-spark">
        <Sparkline points={spark} accent={accent} idPrefix={`kpi-${spec.id}`} />
      </div>
    </article>
  )
}
