import {
  metricNameOf,
  MetricType,
  Parsed,
  MetricSeries,
  seriesKey,
} from '../types'

/** Parse a Prometheus text exposition body (plus a JSON fallback) into series. */
export function parseMetrics(body: string): Parsed {
  const text = body.trim()
  const looksJson =
    text.startsWith('{') || text.startsWith('[') || text.startsWith('"')
  if (looksJson) {
    try {
      return parseJsonMetrics(text)
    } catch {
      // fall through to text parsing
    }
  }
  return parsePrometheusText(text)
}

function isMetricNameChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_'
  )
}

/**
 * Parse a single metric line: `name{label="v",...} value`.
 * Handles quoted values and unquoted scalars / +Inf.
 */
function parseMetricLine(input: string): MetricSeries | null {
  let i = 0
  const n = input.length

  while (i < n && (isMetricNameChar(input[i]) || ':-.'.includes(input[i]))) i += 1
  if (i === 0) return null
  const name = input.slice(0, i)

  const labels: Record<string, string> = {}
  if (i < n && input[i] === '{') {
    i += 1
    while (i < n) {
      while (i < n && ' \t'.includes(input[i])) i += 1
      // key
      let j = i
      while (j < n && (isMetricNameChar(input[j]) || ':-.'.includes(input[j]))) j += 1
      if (j === i) break
      const key = input.slice(i, j)
      i = j
      if (i >= n || input[i] !== '=') break
      i += 1
      // value
      let val: string
      if (i < n && input[i] === '"') {
        let k = i + 1
        while (k < n && input[k] !== '"' && input[k] !== '\\') {
          k += 1
          // handle escape: skip the next char
        }
        if (k < n && input[k] === '\\') k += 2
        val = input.slice(i + 1, k).replace(/\\(.)/g, '$1')
        i = k + 1
      } else {
        let k = i
        while (k < n && input[k] !== ',' && input[k] !== '}') k += 1
        val = input.slice(i, k).trim()
        i = k
      }
      labels[key] = val
      // skip separator/comma
      if (i < n && input[i] === ',') {
        i += 1
      }
    }
    if (i >= n || input[i] !== '}') return null
    i += 1
  }

  while (i < n && ' \t'.includes(input[i])) i += 1
  const valueStr = input.slice(i).trim()
  const value = Number(valueStr)
  if (!Number.isFinite(value) && valueStr !== 'NaN') return null
  const parsedValue = Number.isFinite(value) ? value : 0

  return { name, type: 'gauge', labels, value: parsedValue, help: '' }
}

function parsePrometheusText(text: string): Parsed {
  const types: Record<string, MetricType> = {}
  const help: Record<string, string> = {}

  for (const line of text.split('\n')) {
    const l = line.trim()
    if (l.startsWith('# TYPE ')) {
      const rest = l.slice('# TYPE '.length).trim()
      const space = rest.indexOf(' ')
      if (space > 0) types[rest.slice(0, space)] = normalizeType(rest.slice(space + 1))
    } else if (l.startsWith('# HELP ')) {
      const rest = l.slice('# HELP '.length).trim()
      const space = rest.indexOf(' ')
      if (space > 0) help[rest.slice(0, space)] = rest.slice(space + 1)
    }
  }

  const series: MetricSeries[] = []
  for (const line of text.split('\n')) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    const parsed = parseMetricLine(l)
    if (!parsed) continue
    parsed.type = types[parsed.name] ?? 'gauge'
    parsed.help = help[parsed.name] ?? ''
    series.push(parsed)
  }

  return toParsed(series)
}

function toParsed(series: MetricSeries[]): Parsed {
  const values: Record<string, number> = {}
  const types: Record<string, MetricType> = {}
  const help: Record<string, string> = {}
  for (const s of series) {
    const k = seriesKey(s.name, s.labels)
    values[k] = s.value
    if (!types[s.name]) types[s.name] = s.type
    if (!help[s.name]) help[s.name] = s.help
  }
  return { values, types, help, series }
}

function normalizeType(t: string): MetricType {
  const low = t.toLowerCase()
  if (low === 'counter' || low === 'gauge' || low === 'histogram' || low === 'summary') {
    return low
  }
  return 'unknown'
}

/**
 * JSON fallback: accept `{ key: number }`, `[{name,value}]`, or a list of
 * `{name, value}` objects.
 */
function parseJsonMetrics(raw: string): Parsed {
  const data: unknown = JSON.parse(raw)
  const list: Array<{ name: string; value: number }> = []

  const pushOne = (name: unknown, val: unknown): void => {
    if (typeof name !== 'string' || !name) return
    const num = typeof val === 'number' ? val : Number(val)
    if (Number.isFinite(num)) list.push({ name, value: num })
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const row = item as Record<string, unknown>
        pushOne(row.name, row.value ?? row.val)
      } else if (typeof item === 'number') {
        list.push({ name: `metric_${list.length}`, value: item })
      }
    }
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const k of Object.keys(obj)) {
      const v = obj[k]
      if (typeof v === 'number') pushOne(k, v)
    }
  } else if (typeof data === 'number') {
    list.push({ name: 'value', value: data })
  }

  const series: MetricSeries[] = list.map(({ name, value }) => ({
    name,
    type: 'gauge',
    labels: {},
    value,
    help: '',
  }))
  return toParsed(series)
}

/** Classify the category an explorer row belongs to. */
export function categoryOf(name: string): 'vllm' | 'process' | 'python' | 'http' | 'host' | 'other' {
  if (name.startsWith('vllm:')) return 'vllm'
  if (name.startsWith('host_')) return 'host'
  if (name.startsWith('process_') || name.startsWith('node_')) return 'process'
  if (name.startsWith('python_')) return 'python'
  if (name.startsWith('http_') || name === 'http_requests_total' || name.startsWith('request_')) {
    return 'http'
  }
  return 'other'
}

/** Strip prometheus suffixes for display. */
export function displayMetricName(name: string): string {
  for (const suffix of ['_buckets', '_bucket', '_sum', '_count', '_created']) {
    if (name.endsWith(suffix)) return name.slice(0, -suffix.length)
  }
  return name
}

export { metricNameOf }
