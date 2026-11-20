import {
  metricNameOf,
  MetricType,
  Parsed,
  seriesKey,
  SnapshotValues,
  SeriesLabels,
} from '../types'

/** A compact scraped sample: plain values + histogram bucket data. */
export interface Sample {
  t: number
  values: Record<string, number>
  types: Record<string, MetricType>
  help: Record<string, string>
  /** key = seriesKey(name, labels) + "|le=<boundary>", cumulative bucket counts */
  buckets: Record<string, number>
}

/** Convert labels minus `le` into a series key. */
function baseLabelsKey(name: string, labels: SeriesLabels): string {
  const rest: SeriesLabels = {}
  for (const [k, v] of Object.entries(labels)) if (k !== 'le') rest[k] = v
  return seriesKey(name, rest)
}

/** Derive a Sample from a fully parsed scrape. Bucket series are indexed by base name + le. */
export function toSample(parsed: Parsed): Sample {
  const buckets: Record<string, number> = {}
  for (const s of parsed.series) {
    const baseMatch = s.name.match(/^(.*?)(?:_bucket|_buckets)$/)
    if (!baseMatch) continue
    const base = baseMatch[1]
    const le = s.labels.le ?? ''
    const prefix = baseLabelsKey(base, s.labels)
    buckets[`${prefix}|le=${le}`] = s.value
  }
  return {
    t: Date.now(),
    values: parsed.values,
    types: parsed.types,
    help: parsed.help,
    buckets,
  }
}

/** Sum of all labeled series that share a base metric name. */
export function baseSum(snap: SnapshotValues, baseName: string): number | undefined {
  let total = 0
  let found = false
  for (const [k, v] of Object.entries(snap.values)) {
    if (metricNameOf(k) === baseName && Number.isFinite(v)) {
      total += v
      found = true
    }
  }
  return found ? total : undefined
}

/**
 * Counter rate (units/sec) between two snapshots with a reset guard:
 * if the counter went backwards, treat the increment as the current value.
 */
export function counterRate(cur: number, prev: number, dtSec: number): number | undefined {
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return undefined
  if (dtSec <= 0) return undefined
  let delta = cur - prev
  if (delta < 0) delta = cur
  return delta / dtSec
}

/**
 * Packed counter-rate computed from two sample maps (all series of a base summed).
 */
export function sumRate(
  cur: SnapshotValues,
  prev: SnapshotValues | undefined,
  dtSec: number,
  baseName: string,
): number | undefined {
  const c = baseSum(cur, baseName)
  const p = prev ? baseSum(prev, baseName) : undefined
  if (c === undefined || p === undefined) return undefined
  return counterRate(c, p, dtSec)
}

/** Percentile from cumulative le→count buckets (interpolated linearly). */
function pctlFromLeMap(leMap: Map<string, number>, p: number): number | undefined {
  type Bound = { le: number; count: number }
  const bounds: Bound[] = []
  let total = 0
  for (const [leStr, v] of leMap.entries()) {
    if (leStr === 'Inf' || leStr === '+Inf') {
      total = v
      continue
    }
    const le = Number(leStr)
    if (!Number.isFinite(le)) continue
    bounds.push({ le, count: v })
  }
  if (total <= 0) {
    for (const b of bounds) if (b.count > total) total = b.count
  }
  if (total <= 0 || bounds.length === 0) return undefined
  bounds.sort((a, b) => a.le - b.le)
  const target = total * p
  let prevLe = 0
  let prevCount = 0
  for (const b of bounds) {
    if (b.count >= target) {
      const denom = b.count - prevCount
      if (denom <= 0) return b.le
      return prevLe + ((target - prevCount) / denom) * (b.le - prevLe)
    }
    prevLe = b.le
    prevCount = b.count
  }
  return bounds[bounds.length - 1].le
}

export function bucketPctl(
  buckets: Record<string, number>,
  seriesKeyPrefix: string,
  p: number,
): number | undefined {
  const leMap = new Map<string, number>()
  const prefix = `${seriesKeyPrefix}|le=`
  for (const [k, v] of Object.entries(buckets)) {
    if (k.startsWith(prefix)) leMap.set(k.slice(prefix.length), v)
  }
  return pctlFromLeMap(leMap, p)
}

/**
 * Across all label-combos of a histogram base name: weighted-average percentile,
 * each combo weighted by its total count (its +Inf bucket value).
 */
export function histPctl(
  sample: Sample,
  baseName: string,
  p: number,
): number | undefined {
  const groups: Record<string, Map<string, number>> = {}
  for (const [k, v] of Object.entries(sample.buckets)) {
    const leIdx = k.indexOf('|le=')
    if (leIdx === -1) continue
    const prefix = k.slice(0, leIdx)
    if (metricNameOf(prefix) !== baseName) continue
    const leStr = k.slice(leIdx + 4)
    if (!groups[prefix]) groups[prefix] = new Map()
    groups[prefix].set(leStr, v)
  }
  const combos: Array<{ count: number; pct: number }> = []
  for (const leMap of Object.values(groups)) {
    const pct = pctlFromLeMap(leMap, p)
    if (pct === undefined) continue
    const total = leMap.get('Inf') ?? leMap.get('+Inf') ?? 0
    combos.push({ count: total, pct })
  }
  if (combos.length === 0) return undefined
  const weight = combos.reduce((a, c) => a + c.count, 0)
  if (weight <= 0) {
    return combos.reduce((a, c) => a + c.pct, 0) / combos.length
  }
  return combos.reduce((a, c) => a + c.pct * c.count, 0) / weight
}

/** Windowed mean of a histogram from _sum/_count deltas across the buffer. */
export function histWindowedMean(samples: Sample[], baseName: string, window: number): number | undefined {
  if (samples.length < 2) return undefined
  const i = samples.length - 1
  const j = Math.max(0, i - Math.max(1, window - 1))
  const cur = samples[i]
  const prev = samples[j]
  const curSum = baseSum(cur, `${baseName}_sum`)
  const curCount = baseSum(cur, `${baseName}_count`)
  const prevSum = baseSum(prev, `${baseName}_sum`)
  const prevCount = baseSum(prev, `${baseName}_count`)
  if (curSum === undefined || curCount === undefined) return undefined
  const dSum = Math.max(0, curSum - (prevSum ?? curSum))
  const dCount = Math.max(0, curCount - (prevCount ?? curCount))
  if (dCount <= 0) {
    // no new observations inside this window; fall back to all-time mean
    const allCount = baseSum(cur, `${baseName}_count`) ?? 0
    if (allCount > 0) return (baseSum(cur, `${baseName}_sum`) ?? 0) / allCount
    return undefined
  }
  return dSum / dCount
}

/** Rate of a counter base name across the buffer's tail (window samples apart). */
export function windowedRate(samples: Sample[], baseName: string, window: number): number | undefined {
  if (samples.length < 2) return undefined
  const i = samples.length - 1
  const j = Math.max(0, i - Math.max(1, window - 1))
  const dt = (samples[i].t - samples[j].t) / 1000
  const r = sumRate(samples[i], samples[j], dt, baseName)
  return r === undefined ? undefined : Math.max(0, r)
}

/** Delta ratio (percent) of a counter base over the window. */
export function windowedRatio(
  samples: Sample[],
  numName: string,
  denName: string,
  window: number,
): number | undefined {
  if (samples.length < 2) return undefined
  const i = samples.length - 1
  const j = Math.max(0, i - Math.max(1, window - 1))
  const d1 = Math.max(0, (baseSum(samples[i], numName) ?? 0) - (baseSum(samples[j], numName) ?? 0))
  const d2 = Math.max(0, (baseSum(samples[i], denName) ?? 0) - (baseSum(samples[j], denName) ?? 0))
  if (d2 <= 0) {
    const tot = baseSum(samples[i], denName) ?? 0
    if (tot <= 0) return undefined
    return (baseSum(samples[i], numName) ?? 0) / tot
  }
  return d1 / d2
}

export type MetricFamily = 'cyan' | 'blue' | 'amber' | 'violet' | 'rose' | 'green'

export type SpecStat =
  | 'rate'
  | 'gauge'
  | 'total'
  | 'p50'
  | 'p95'
  | 'mean'
  | 'invMean'
  | 'ratio'

/**
 * Declarative description of a (derived or raw) metric the UI can plot,
 * chart, and sparkline. KPI cards are the subset flagged `isKpi`.
 */
export interface MetricSpec {
  id: string
  label: string
  baseName: string
  stat: SpecStat
  denomName?: string
  unit: string
  scale: number
  family: MetricFamily
  isKpi: boolean
  /** for raw-series specs: full label combo to isolate (undefined = sum all) */
  comboLabels?: SeriesLabels
}

export const METRICS: MetricSpec[] = [
  { id: 'requestsRate', label: 'Requests/s', baseName: 'vllm:request_success_total', stat: 'rate', unit: '/s', scale: 1, family: 'cyan', isKpi: true },
  { id: 'tokensRate', label: 'Tokens/s', baseName: 'vllm:generation_tokens_total', stat: 'rate', unit: '', scale: 1, family: 'cyan', isKpi: true },
  { id: 'active', label: 'Active requests', baseName: 'vllm:num_requests_running', stat: 'gauge', unit: '', scale: 1, family: 'blue', isKpi: true },
  { id: 'queued', label: 'Queued', baseName: 'vllm:num_requests_waiting', stat: 'gauge', unit: '', scale: 1, family: 'amber', isKpi: true },
  { id: 'kvPct', label: 'KV cache', baseName: 'vllm:kv_cache_usage_perc', stat: 'gauge', unit: '%', scale: 100, family: 'violet', isKpi: true },
  { id: 'ttft', label: 'TTFT (p50)', baseName: 'vllm:time_to_first_token_seconds', stat: 'p50', unit: 'ms', scale: 1000, family: 'rose', isKpi: true },
  { id: 'ttftMean', label: 'TTFT (recent mean)', baseName: 'vllm:time_to_first_token_seconds', stat: 'mean', unit: 'ms', scale: 1000, family: 'rose', isKpi: false },
  { id: 'itlTps', label: 'Throughput tok/s (1/ITL)', baseName: 'vllm:inter_token_latency_seconds', stat: 'invMean', unit: ' tok/s', scale: 1, family: 'rose', isKpi: false },
  { id: 'e2e', label: 'E2E latency (p50)', baseName: 'vllm:e2e_request_latency_seconds', stat: 'p50', unit: 'ms', scale: 1000, family: 'rose', isKpi: false },
  { id: 'queueTime', label: 'Queue time (p50)', baseName: 'vllm:request_queue_time_seconds', stat: 'p50', unit: 'ms', scale: 1000, family: 'amber', isKpi: false },
  { id: 'prefillTime', label: 'Prefill time (p50)', baseName: 'vllm:request_prefill_time_seconds', stat: 'p50', unit: 'ms', scale: 1000, family: 'amber', isKpi: false },
  { id: 'decodeTime', label: 'Decode time (p50)', baseName: 'vllm:request_decode_time_seconds', stat: 'p50', unit: 'ms', scale: 1000, family: 'amber', isKpi: false },
  { id: 'promptRate', label: 'Prompt tokens/s', baseName: 'vllm:prompt_tokens_total', stat: 'rate', unit: '', scale: 1, family: 'blue', isKpi: false },
  { id: 'specAccept', label: 'Spec-decode accept rate', baseName: 'vllm:spec_decode_num_accepted_tokens_total', denomName: 'vllm:spec_decode_num_draft_tokens_total', stat: 'ratio', unit: '%', scale: 100, family: 'green', isKpi: false },
  { id: 'prefixHit', label: 'Prefix-cache hit rate', baseName: 'vllm:prefix_cache_hits_total', denomName: 'vllm:prefix_cache_queries_total', stat: 'ratio', unit: '%', scale: 100, family: 'green', isKpi: false },
  { id: 'preemptions', label: 'Preemptions', baseName: 'vllm:num_preemptions_total', stat: 'total', unit: '', scale: 1, family: 'rose', isKpi: false },
  { id: 'http4xx', label: 'HTTP 4xx /s', baseName: 'http_requests_total', stat: 'rate', unit: '/s', scale: 1, family: 'amber', isKpi: false, comboLabels: { status: '4xx' } },
  { id: 'cpu', label: 'CPU (cores)', baseName: 'process_cpu_seconds_total', stat: 'rate', unit: '', scale: 1, family: 'blue', isKpi: false },
]

/**
 * Host telemetry gauges reported by the Go hoststats sidecar (the /host-metrics
 * endpoint). These are all plain gauges — each card reads a single value from a
 * sample with an optional label combo. Kept separate from METRICS so the LLM
 * chart/explorer can be driven independently from the vLLM endpoint.
 */
export const HOST_METRICS: MetricSpec[] = [
  { id: 'gpuTemp', label: 'GPU edge', baseName: 'host_gpu_temp_celsius', comboLabels: { part: 'edge' }, stat: 'gauge', unit: '°C', scale: 1, family: 'rose', isKpi: true },
  { id: 'gpuJuncTemp', label: 'GPU junction', baseName: 'host_gpu_temp_celsius', comboLabels: { part: 'junction' }, stat: 'gauge', unit: '°C', scale: 1, family: 'rose', isKpi: true },
  { id: 'gpuMemTemp', label: 'GPU memory', baseName: 'host_gpu_temp_celsius', comboLabels: { part: 'memory' }, stat: 'gauge', unit: '°C', scale: 1, family: 'rose', isKpi: true },
  { id: 'gpuBusy', label: 'GPU busy', baseName: 'host_gpu_busy_percent', stat: 'gauge', unit: '%', scale: 1, family: 'amber', isKpi: true },
  { id: 'gpuVram', label: 'GPU VRAM', baseName: 'host_gpu_vram_used_percent', stat: 'gauge', unit: '%', scale: 1, family: 'violet', isKpi: true },
  { id: 'gpuPower', label: 'GPU power', baseName: 'host_gpu_power_watts', stat: 'gauge', unit: 'W', scale: 1, family: 'cyan', isKpi: true },
  { id: 'gpuFanRpm', label: 'GPU fan', baseName: 'host_gpu_fan_rpm', stat: 'gauge', unit: 'rpm', scale: 1, family: 'green', isKpi: true },
  { id: 'cpuUsage', label: 'CPU usage', baseName: 'host_cpu_usage_percent', stat: 'gauge', unit: '%', scale: 1, family: 'blue', isKpi: true },
  { id: 'cpuTemp', label: 'CPU temp', baseName: 'host_cpu_temp_celsius', stat: 'gauge', unit: '°C', scale: 1, family: 'rose', isKpi: true },
  { id: 'cpuLoad', label: 'CPU load (1m)', baseName: 'host_cpu_load', comboLabels: { period: '1m' }, stat: 'gauge', unit: '', scale: 1, family: 'amber', isKpi: false },
]

export const hostSpecById = (id: string): MetricSpec | undefined => HOST_METRICS.find((m) => m.id === id)

export const specById = (id: string): MetricSpec | undefined => METRICS.find((m) => m.id === id)

function matchLabels(spec: MetricSpec, labels: SeriesLabels): boolean {
  if (!spec.comboLabels) return true
  for (const [k, v] of Object.entries(spec.comboLabels)) {
    if (labels[k] !== v) return false
  }
  return true
}

function baseSumFiltered(snap: SnapshotValues, spec: MetricSpec): number | undefined {
  let total = 0
  let found = false
  for (const [k, v] of Object.entries(snap.values)) {
    if (metricNameOf(k) !== spec.baseName) continue
    const labels = labelsFromKey(k)
    if (!matchLabels(spec, labels)) continue
    if (Number.isFinite(v)) {
      total += v
      found = true
    }
  }
  return found ? total : undefined
}

function labelsFromKey(k: string): SeriesLabels {
  const idx = k.indexOf('|')
  if (idx === -1) return {}
  const out: SeriesLabels = {}
  const rest = k.slice(idx + 1)
  for (const part of rest.split(',')) {
    const eq = part.indexOf('=')
    if (eq !== -1) out[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return out
}

/**
 * Read the value of a single labeled series from a sample. When `labels` is
 * empty/omitted, sums all series of `baseName` (baseSum). Returns undefined for
 * a missing series.
 */
export function seriesValue(snap: SnapshotValues, baseName: string, labels?: SeriesLabels): number | undefined {
  if (labels && Object.keys(labels).length > 0) {
    return snap.values[seriesKey(baseName, labels)]
  }
  return baseSum(snap, baseName)
}

/**
 * Resolve the value of a spec at a given sample in the buffer.
 * Rate/ratio stats look back `window` samples; others read the sample directly.
 */
export function specValue(
  spec: MetricSpec,
  samples: Sample[],
  i: number,
  window: number = 4,
): number | undefined {
  const cur = samples[i]
  switch (spec.stat) {
    case 'rate': {
      const j = Math.max(0, i - window)
      const dt = (cur.t - samples[j].t) / 1000
      if (dt <= 0) return undefined
      const c = baseSumFiltered(cur, spec)
      const p = baseSumFiltered(samples[j], spec)
      if (c === undefined || p === undefined) return undefined
      const inc = c - p
      return Math.max(0, (inc < 0 ? c : inc) / dt)
    }
    case 'total': {
      const v = baseSumFiltered(cur, spec)
      return v
    }
    case 'gauge': {
      const v = baseSumFiltered(cur, spec)
      return v
    }
    case 'p50':
      return histPctl(cur, spec.baseName, 0.5)
    case 'p95':
      return histPctl(cur, spec.baseName, 0.95)
    case 'mean':
    case 'invMean': {
      const m = histWindowedMean(samples, spec.baseName, window)
      if (m === undefined) return undefined
      return spec.stat === 'invMean' && m > 0 ? 1 / m : m
    }
    case 'ratio': {
      if (!spec.denomName) return undefined
      const r = windowedRatio(samples, spec.baseName, spec.denomName, window)
      return r
    }
    default:
      return undefined
  }
}

/** Full time series for a spec across the rolling buffer. */
export function specSeries(spec: MetricSpec, samples: Sample[], window = 4): Array<{ t: number; v: number }> {
  const out: Array<{ t: number; v: number }> = []
  for (let i = 0; i < samples.length; i++) {
    const v = specValue(spec, samples, i, window)
    if (v !== undefined && Number.isFinite(v)) out.push({ t: samples[i].t, v })
  }
  return out
}

export function fmtNum(v: number | undefined, digits: number = 1): string {
  if (v === undefined || !Number.isFinite(v)) return '—'
  if (Math.abs(v) >= 10000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (Math.abs(v) < 0.01 && v !== 0) return v.toPrecision(2)
  return v.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: 0 })
}

export function fmtRate(v: number | undefined, digits: number = 2): string {
  if (v === undefined) return '—'
  return fmtNum(v, digits)
}
