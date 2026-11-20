import { useMemo, useState } from 'react'
import { categoryOf, displayMetricName } from '../lib/parser'
import { Parsed, seriesKey, MetricType } from '../types'

type Category = 'all' | 'vllm' | 'process' | 'python' | 'http' | 'host' | 'other'
const CATEGORIES: Category[] = ['all', 'vllm', 'host', 'process', 'python', 'http']

export interface MetricsExplorerProps {
  parsed: Parsed | null
}

interface Row {
  key: string
  name: string
  type: MetricType
  labels: Record<string, string>
  value: number
  help: string
  cat: Category
}

function fmtVal(v: number): string {
  if (Math.abs(v) >= 1e6) return v.toExponential(3)
  if (Number.isInteger(v) && Math.abs(v) < 1e6) return v.toString()
  return v.toFixed(4).replace(/\.?0+$/, '') || '0'
}

export function MetricsExplorer({ parsed }: MetricsExplorerProps) {
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<Category>('all')

  const rows = useMemo<Row[]>(() => {
    if (!parsed) return []
    return parsed.series.map((s) => {
      const key = seriesKey(s.name, s.labels)
      return {
        key,
        name: s.name,
        type: s.type,
        labels: s.labels,
        value: s.value,
        help: s.help,
        cat: categoryOf(s.name),
      }
    })
  }, [parsed])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return rows.filter((r) => {
      if (cat !== 'all' && r.cat !== cat) return false
      if (!needle) return true
      const names = `${r.name} ${Object.keys(r.labels).map((k) => `${k}=${r.labels[k]}`).join(' ')}`.toLowerCase()
      return names.includes(needle)
    })
  }, [rows, q, cat])

  return (
    <section className="panel explorer-panel">
      <header className="panel-head">
        <h2 className="panel-title">Metrics explorer</h2>
        <span className="panel-sub">{rows.length} series</span>
      </header>
      <div className="explorer-tools">
        <input
          className="explorer-search"
          type="text"
          placeholder="filter name or label…"
          aria-label="Filter metrics"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="explorer-chips" role="group" aria-label="Category filter">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              type="button"
              className={`chip ${cat === c ? 'chip-active' : ''}`}
              aria-pressed={cat === c}
              onClick={() => setCat(c)}
            >
              {c === 'all' ? 'All' : c}
            </button>
          ))}
        </div>
      </div>
      <div className="explorer-table-wrap">
        <table className="explorer-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Labels</th>
              <th className="num">Value</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={4} className="explorer-empty">no metrics match this filter</td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr key={r.key} className={`explorer-row ${r.cat === 'vllm' ? 'row-vllm' : ''}`}>
                <td className="ex-name" title={r.help || r.name}>
                  {displayMetricName(r.name.replace(/_bucket$/, ''))}
                </td>
                <td>
                  <span className={`type-badge type-${r.type}`}>{r.type.toUpperCase()}</span>
                </td>
                <td className="ex-labels">
                  {Object.entries(r.labels).map(([k, v]) => (
                    <span key={k + v} className="label-pill">
                      {k}={v}
                    </span>
                  ))}
                </td>
                <td className={r.type === 'counter' || r.type === 'histogram' ? 'num' : 'num'}>{fmtVal(r.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
