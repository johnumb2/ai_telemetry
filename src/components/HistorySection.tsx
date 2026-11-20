import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { AreaChart } from './AreaChart'
import { METRICS, HOST_METRICS, MetricSpec } from '../lib/derive'

/** Retainer query API stats (mirror of the frontend's derived stat names). */
type GoStat = 'gauge' | 'total' | 'rate' | 'p50' | 'p95' | 'mean' | 'invmean' | 'ratio'

function statToGo(stat: MetricSpec['stat']): GoStat {
  switch (stat) {
    case 'rate':
      return 'rate'
    case 'gauge':
      return 'gauge'
    case 'total':
      return 'total'
    case 'p50':
      return 'p50'
    case 'p95':
      return 'p95'
    case 'mean':
      return 'mean'
    case 'invMean':
      return 'invmean'
    case 'ratio':
      return 'ratio'
    default:
      return 'gauge'
  }
}

/** k=v,k2=v2 (sorted) — matches how the retainer renders series keys. */
function comboOf(labels?: Record<string, string>): string {
  if (!labels) return ''
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',')
}

interface RangeDef {
  id: string
  label: string
  ms: number
}

const RANGES: RangeDef[] = [
  { id: '5m', label: '5m', ms: 5 * 60_000 },
  { id: '15m', label: '15m', ms: 15 * 60_000 },
  { id: '1h', label: '1h', ms: 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 3600_000 },
  { id: '24h', label: '24h', ms: 24 * 3600_000 },
  { id: '7d', label: '7d', ms: 7 * 24 * 3600_000 },
  { id: '90d', label: '90d', ms: 90 * 24 * 3600_000 },
]

/** A pickable item in the history metric menu. */
type Pick =
  | { kind: 'vllm'; id: string; spec: MetricSpec }
  | { kind: 'host'; id: string; spec: MetricSpec }
  | { kind: 'raw'; key: string }

function pickValue(p: Pick): string {
  return p.kind === 'raw' ? `raw:${p.key}` : `${p.kind}:${p.id}`
}

function sourceOfPick(p: Pick): 'vllm' | 'host' {
  if (p.kind === 'host') return 'host'
  if (p.kind === 'vllm') return 'vllm'
  return p.key.includes('host_') ? 'host' : 'vllm'
}

/** Display name for a raw skey: base {labels minus le}. */
function rawDisplay(key: string): string {
  const bar = key.indexOf('|')
  const base = bar === -1 ? key : key.slice(0, bar)
  if (bar === -1) return base
  const lbls = key
    .slice(bar + 1)
    .split(',')
    .filter((l) => l !== 'le')
    .join(', ')
  return lbls ? `${base} {${lbls}}` : base
}

function isRawAux(key: string): boolean {
  const bar = key.indexOf('|')
  const base = bar === -1 ? key : key.slice(0, bar)
  return /(_bucket|_buckets|_sum|_count|_count)$/.test(base)
}

function fmtShort(v: number): string {
  if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + 'k'
  if (Math.abs(v) < 1 && v !== 0) return v.toPrecision(2)
  return v.toFixed(2)
}

interface QueryArgs {
  series?: string
  base?: string
  stat?: GoStat
  denom?: string
  combo?: string
  source: 'vllm' | 'host' | 'both'
  start: number
  end: number
  step?: number
}

async function fetchHistoryQuery(args: QueryArgs, signal: AbortSignal): Promise<Array<{ t: number; v: number }>> {
  const resp = await fetch('/api/history/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal,
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = (await resp.json()) as { ok: boolean; points?: Array<{ t: number; v: number }>; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'history query failed')
  return data.points ?? []
}

async function fetchHistorySeries(signal: AbortSignal): Promise<string[]> {
  const resp = await fetch('/api/history/series?source=both', { signal })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const data = (await resp.json()) as { ok: boolean; series?: string[]; error?: string }
  if (!data.ok) throw new Error(data.error ?? 'history series failed')
  return data.series ?? []
}

/**
 * Recall panel: replays what the retainer has stored (both sources scraped
 * every 15s, per-minute storage) as a chart over a selectable time window.
 * Uses the same derived specs as the live view so history matches live.
 */
export function HistorySection() {
  const [rangeId, setRangeId] = useState('24h')
  const [pick, setPick] = useState<Pick>(() => ({ kind: 'vllm', id: 'requestsRate', spec: METRICS[0] }))
  const [points, setPoints] = useState<Array<{ t: number; v: number }>>([])
  const [seriesKeys, setSeriesKeys] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const ctlRef = useRef<AbortController | null>(null)

  const range = RANGES.find((r) => r.id === rangeId) ?? RANGES[4]

  // Resolve the pick to a query + chart meta.
  const query = useMemo<QueryArgs>(() => {
    const end = Date.now()
    const start = end - range.ms
    if (pick.kind === 'raw') {
      return { series: pick.key, combo: '', source: sourceOfPick(pick), start, end }
    }
    const spec = pick.spec
    const source = pick.kind === 'host' ? 'host' : 'vllm'
    return {
      base: spec.baseName,
      stat: statToGo(spec.stat),
      denom: spec.denomName,
      combo: comboOf(spec.comboLabels),
      source,
      start,
      end,
    }
  }, [pick, range])

  const meta = useMemo(() => {
    if (pick.kind === 'raw') {
      return { accent: 'var(--text-dim)', label: rawDisplay(pick.key), unit: '' }
    }
    const spec = pick.spec
    return {
      accent: `var(--${spec.family})`,
      label: `${spec.label}${spec.unit ? ` · ${spec.unit}` : ''}`,
      unit: spec.unit,
    }
  }, [pick])

  const lastPoint = points.length > 0 ? points[points.length - 1] : null
  const curLabel = lastPoint === null ? '—' : `${fmtShort(lastPoint.v)}${meta.unit ? ' ' + meta.unit : ''}`

  // One fetch on selection/range change (the "end" moves with the clock, so a
  // fixed end would drift; reusing the memo keeps a single request in flight
  // for (pick, range) and the periodic refresh below keeps the tail fresh).
  useEffect(() => {
    const ctl = new AbortController()
    ctlRef.current = ctl
    setLoading(true)
    fetchHistoryQuery(query, ctl.signal)
      .then((pts) => {
        setPoints(pts)
        setError(null)
      })
      .catch((e: unknown) => {
        if (e instanceof DOMException && e.name === 'AbortError') return
        setError(e instanceof Error ? e.message : 'history query failed')
      })
      .finally(() => {
        setLoading(false)
      })
    return () => {
      ctl.abort()
      ctlRef.current = null
    }
  }, [query])

  // Background refresh so the end of the selected window tracks "now".
  useEffect(() => {
    const span = query.end - query.start
    const id = window.setInterval(() => {
      if (ctlRef.current) ctlRef.current.abort()
      const fresh: QueryArgs = {
        ...query,
        start: Date.now() - span,
        end: Date.now(),
      }
      const ctl = new AbortController()
      fetchHistoryQuery(fresh, ctl.signal)
        .then((pts) => {
          setPoints(pts)
          setError(null)
        })
        .catch(() => void null)
        .finally(() => {
          if (ctlRef.current === ctl) ctlRef.current = null
        })
      ctlRef.current = ctl
    }, 20_000)
    return () => {
      window.clearInterval(id)
      if (ctlRef.current) ctlRef.current.abort()
    }
  }, [query])

  // Raw series are only useful once samples exist; load them alongside a
  // refresh when the list is empty (or re-load when a new range is chosen).
  useEffect(() => {
    const ctl = new AbortController()
    fetchHistorySeries(ctl.signal)
      .then((keys) => {
        setSeriesKeys(keys.filter((k) => !isRawAux(k)))
      })
      .catch(() => void null)
    return () => {
      ctl.abort()
    }
  }, [rangeId])

  const empty = points.length < 2
  const emptyMsg =
    empty && !error
      ? 'history is building — the retainer scrapes both endpoints every 15s and keeps 90 days of per-minute samples'
      : null

  return (
    <section className="panel chart-panel" aria-label="History">
      <header className="panel-head">
        <h2 className="panel-title">History</h2>
        <div className="chart-controls">
          <div className="range-pills" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                type="button"
                key={r.id}
                className={`range-pill${rangeId === r.id ? ' on' : ''}`}
                aria-pressed={rangeId === r.id}
                onClick={() => setRangeId(r.id)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <label className="chart-label" htmlFor="history-select">
            Metric
          </label>
          <select
            id="history-select"
            className="metric-select"
            value={pickValue(pick)}
            aria-label="Select history metric"
            onChange={(e) => {
              const val = e.target.value
              const colon = val.indexOf(':')
              const kind = val.slice(0, colon) as Pick['kind']
              const id = val.slice(colon + 1)
              if (kind === 'raw') setPick({ kind: 'raw', key: id })
              else {
                const spec = (kind === 'host' ? HOST_METRICS : METRICS).find((m) => m.id === id)
                if (spec) setPick({ kind, id: spec.id, spec })
              }
            }}
          >
            <optgroup label="vLLM metrics">
              {METRICS.map((m) => (
                <option key={`vllm:${m.id}`} value={`vllm:${m.id}`}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="Host metrics">
              {HOST_METRICS.map((m) => (
                <option key={`host:${m.id}`} value={`host:${m.id}`}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            {seriesKeys.length > 0 && (
              <optgroup label="Raw stored series">
                {seriesKeys.map((k) => (
                  <option key={`raw:${k}`} value={`raw:${k}`}>
                    {rawDisplay(k)}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </header>

      <div className="chart-body">
        <div className="chart-readout">
          <span className="readout-val" style={{ color: meta.accent } as CSSProperties}>{curLabel}</span>
          <span className="readout-unit">{meta.label}</span>
        </div>
        <div className="chart-svg">
          <AreaChart points={points} accent={meta.accent} formatValue={fmtShort} unit={meta.unit} />
        </div>
      </div>

      {error && (
        <div className="demo-offer">
          <span>history unavailable — {error}</span>
        </div>
      )}
      {!error && emptyMsg && (
        <div className="history-hint">
          <span>
            {emptyMsg} {loading ? '…' : ''}
          </span>
        </div>
      )}
    </section>
  )
}
