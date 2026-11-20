export type MetricType = 'gauge' | 'counter' | 'histogram' | 'summary' | 'unknown'

export type SeriesLabels = Record<string, string>

/** A single labeled metric series from one scrape. */
export interface MetricSeries {
  name: string
  type: MetricType
  labels: SeriesLabels
  value: number
  help: string
}

/** Compact numeric snapshot used by the rolling buffer (cheap per sample). */
export interface SnapshotValues {
  values: Record<string, number>
  types: Record<string, MetricType>
  help: Record<string, string>
}

export interface Sample extends SnapshotValues {
  t: number
}

/** Full parsed scrape (incl. every labeled series) for the explorer / stats. */
export interface Parsed extends SnapshotValues {
  series: MetricSeries[]
}

export const seriesKey = (name: string, labels: SeriesLabels = {}): string => {
  const ks = Object.keys(labels)
  if (ks.length === 0) return name
  const formatted = ks
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',')
  return `${name}|${formatted}`
}

export const metricNameOf = (key: string): string => {
  const i = key.indexOf('|')
  return i === -1 ? key : key.slice(0, i)
}

export const metricValueOf = (s: SnapshotValues, key: string): number | undefined =>
  s.values[key]
