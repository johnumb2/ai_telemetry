import { useCallback, useEffect, useRef, useState } from 'react'
import { parseMetrics } from './parser'
import { Sample, toSample } from './derive'
import { baseSum } from './derive'
import { bootstrapDemoSamples, DemoState, makeDemoState, stepDemo } from './demo'
import { DashSettings, loadSettings, saveSettings } from './settings'
import { Parsed } from '../types'

export type ConnStatus = 'live' | 'reconnecting' | 'offline' | 'demo'

/** Connection status of the separate host-telemetry endpoint. */
export type HostStatus = 'live' | 'reconnecting' | 'offline'

export type EventKind = 'req' | 'tokens' | 'preempt' | 'state' | 'conn' | 'rate'

export interface EventEntry {
  id: number
  t: number
  kind: EventKind
  msg: string
}

export interface MetricsState {
  status: ConnStatus
  hint: string | null
  lastUpdated: number | null
  fetchLatency: number | null
  samples: Sample[]
  parsed: Parsed | null
  events: EventEntry[]
  errorCount: number
  demoAutoOffered: boolean
  /** Telemetry from the independent /host-metrics sidecar endpoint. */
  hostSamples: Sample[]
  hostParsed: Parsed | null
  hostStatus: HostStatus
  hostHint: string | null
}

export interface MetricsHook {
  state: MetricsState
  settings: DashSettings
  enableDemo: () => void
  disableDemo: () => void
  setEndpoint: (ep: string) => void
  setHostEndpoint: (ep: string) => void
  setPollMs: (ms: number) => void
  setSelectedChartMetric: (id: string) => void
}

const SAMPLE_CAP = 240
const EVENT_CAP = 40
const OFFLINE_AFTER = 4
const DEMO_BOOTSTRAP = 40
const FETCH_TIMEOUT_MS = 5000

const initialState = (): MetricsState => ({
  status: 'reconnecting',
  hint: null,
  lastUpdated: null,
  fetchLatency: null,
  samples: [],
  parsed: null,
  events: [],
  errorCount: 0,
  demoAutoOffered: false,
  hostSamples: [],
  hostParsed: null,
  hostStatus: 'reconnecting',
  hostHint: null,
})

function isCrossOrigin(endpoint: string): boolean {
  if (!endpoint) return false
  if (endpoint.startsWith('/') || endpoint.startsWith('localhost') || endpoint.startsWith('127.')) return false
  return /^https?:/.test(endpoint)
}

type EngineState = 'awake' | 'sleeping' | 'unknown'

function sampleEngineState(sample: Sample): EngineState {
  const awake = sample.values['vllm:engine_sleep_state|engine=0,model_name=Qwen3.8,sleep_state=awake']
  if (awake !== undefined && awake > 0) return 'awake'
  const off = sample.values['vllm:engine_sleep_state|engine=0,model_name=Qwen3.8,sleep_state=weights_offloaded']
  if (off !== undefined && off > 0) return 'sleeping'
  const discard = sample.values['vllm:engine_sleep_state|engine=0,model_name=Qwen3.8,sleep_state=discard_all']
  if (discard !== undefined && discard > 0) return 'sleeping'
  return 'unknown'
}

export function useMetrics(): MetricsHook {
  const [settings, setSettings] = useState<DashSettings>(() => loadSettings())
  const [state, setState] = useState<MetricsState>(initialState)

  const samplesRef = useRef<Sample[]>([])
  const errorsRef = useRef(0)
  const prevErrorRef = useRef(0)
  const eventCounter = useRef(0)
  const eventsRef = useRef<EventEntry[]>([])
  const demoStateRef = useRef<DemoState>(makeDemoState())
  const demoBootstrappedRef = useRef(false)
  const inflightRef = useRef<AbortController | null>(null)
  const lastEngineRef = useRef<EngineState | null>(null)

  // Independent telemetry for the host sidecar (separate buffer + inflight).
  const hostSamplesRef = useRef<Sample[]>([])
  const hostParsedRef = useRef<Parsed | null>(null)
  const hostInflightRef = useRef<AbortController | null>(null)

  const persist = useCallback((next: Partial<DashSettings>) => {
    setSettings((prev) => {
      const merged = { ...prev, ...next }
      saveSettings(merged)
      return merged
    })
  }, [])

  const appendEvent = useCallback((kind: EventKind, msg: string) => {
    eventCounter.current += 1
    eventsRef.current = [
      { id: eventCounter.current, t: Date.now(), kind, msg },
      ...eventsRef.current,
    ].slice(0, EVENT_CAP)
  }, [])

  useEffect(() => {
    const { demo, pollMs, endpoint, hostEndpoint } = settings
    let cancelled = false

    const pushSample = (sample: Sample, parsed: Parsed, fetchMs: number | null): void => {
      const prev = samplesRef.current[samplesRef.current.length - 1]
      const now = sample.t

      if (prev) {
        const reqCur = baseSum(sample, 'vllm:request_success_total') ?? 0
        const reqPrev = baseSum(prev, 'vllm:request_success_total') ?? 0
        const tokCur = baseSum(sample, 'vllm:generation_tokens_total') ?? 0
        const tokPrev = baseSum(prev, 'vllm:generation_tokens_total') ?? 0
        const preCur = baseSum(sample, 'vllm:num_preemptions_total') ?? 0
        const prePrev = baseSum(prev, 'vllm:num_preemptions_total') ?? 0
        const dReq = reqCur - reqPrev
        const dTok = tokCur - tokPrev
        const dPre = preCur - prePrev

        if (dReq > 0) appendEvent('req', `request completed (counter +${Math.round(dReq)})`)
        if (dTok > 0) appendEvent('tokens', `tokens +${Math.round(dTok).toLocaleString('en-US')} this tick`)
        if (dPre > 0) appendEvent('preempt', `preemption recorded (+${Math.round(dPre)})`)
      }

      const curEngine = sampleEngineState(sample)
      if (lastEngineRef.current !== null && lastEngineRef.current !== curEngine && curEngine !== 'unknown') {
        appendEvent('state', curEngine === 'awake' ? 'engine state → AWAKE' : 'engine state → SLEEPING')
      }
      lastEngineRef.current = curEngine

      samplesRef.current = [...samplesRef.current, sample].slice(-SAMPLE_CAP)
      setState((p) => ({
        ...p,
        samples: samplesRef.current,
        parsed,
        lastUpdated: now,
        fetchLatency: fetchMs,
        events: eventsRef.current,
      }))
    }

    const onOk = (parsed: Parsed, ms: number): void => {
      if (prevErrorRef.current > 0) appendEvent('conn', 'connection re-established')
      errorsRef.current = 0
      prevErrorRef.current = 0
      pushSample(toSample(parsed), parsed, Math.round(ms))
      setState((p) => ({ ...p, status: 'live', hint: null, errorCount: 0, events: eventsRef.current }))
    }

    const onError = (hint: string | null): void => {
      errorsRef.current += 1
      prevErrorRef.current = errorsRef.current
      const consecutive = errorsRef.current
      const status: ConnStatus = consecutive >= OFFLINE_AFTER ? 'offline' : 'reconnecting'
      const finalHint =
        hint ??
        (status === 'offline'
          ? 'endpoint unreachable — check the URL in settings'
          : 'retrying…')
      appendEvent(
        'conn',
        status === 'offline'
          ? 'endpoint unreachable — OFFLINE'
          : `endpoint error (attempt ${consecutive}) — reconnecting`,
      )
      setState((p) => ({
        ...p,
        status,
        hint: finalHint,
        errorCount: consecutive,
        demoAutoOffered: p.demoAutoOffered || (status === 'offline' && p.samples.length === 0),
        events: eventsRef.current,
      }))
    }

    const doDemoTick = (): void => {
      if (!demoBootstrappedRef.current) {
        demoBootstrappedRef.current = true
        samplesRef.current = bootstrapDemoSamples(DEMO_BOOTSTRAP, demoStateRef.current)
      }
      const parsed = parseMetrics(stepDemo(demoStateRef.current))
      pushSample(toSample(parsed), parsed, 35)
      setState((p) => ({ ...p, status: 'demo', hint: null, events: eventsRef.current }))
    }

    const hostOnOk = (parsed: Parsed, ms: number): void => {
      const sample = toSample(parsed)
      hostParsedRef.current = parsed
      hostSamplesRef.current = [...hostSamplesRef.current, sample].slice(-SAMPLE_CAP)
      void ms
      setState((p) => ({
        ...p,
        hostSamples: hostSamplesRef.current,
        hostParsed: parsed,
        hostStatus: 'live',
        hostHint: null,
      }))
    }

    const hostOnError = (hint: string | null): void => {
      setState((p) => ({
        ...p,
        hostStatus: 'reconnecting',
        hostHint: hint ?? 'reconnecting…',
      }))
    }

    // Poll one endpoint. onOk/onError are the caller-specific handlers so the
    // LLM endpoint and the host sidecar can drive fully independent state.
    const fetchOnce = (
      url: string,
      onOk: (parsed: Parsed, ms: number) => void,
      onError: (hint: string | null) => void,
      inflightRef: React.MutableRefObject<AbortController | null>,
    ): void => {
      const ctl = new AbortController()
      inflightRef.current = ctl
      const started = performance.now()
      const timer = window.setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS)

      fetch(url, { signal: ctl.signal, cache: 'no-store' })
        .then((resp) => {
          window.clearTimeout(timer)
          if (!resp.ok) {
            const hint = resp.status === 404 ? 'endpoint not found — check your path' : `HTTP ${resp.status} from endpoint`
            onError(hint)
            return
          }
          return resp.text().then((text) => {
            const parsed = parseMetrics(text)
            if (parsed.series.length === 0) {
              onError('response contained no parseable metrics')
              return
            }
            onOk(parsed, performance.now() - started)
          })
        })
        .catch((err: unknown) => {
          window.clearTimeout(timer)
          if (err instanceof DOMException && err.name === 'AbortError') {
            onError('fetch timed out — endpoint is not responding')
          } else {
            const hint = isCrossOrigin(url)
              ? 'browser blocked the request — CORS. Use the dev-server proxy or enable CORS on the server'
              : 'network error — endpoint unreachable'
            onError(hint)
          }
        })
        .finally(() => {
          inflightRef.current = null
        })
    }

    const tick = (): void => {
      if (cancelled) return
      if (demo) {
        doDemoTick()
        return
      }

      // Primary LLM endpoint + the independent host-telemetry sidecar.
      // Each failure is handled by its own onError, so they never interfere.
      fetchOnce(endpoint, onOk, onError, inflightRef)
      if (hostEndpoint) fetchOnce(hostEndpoint, hostOnOk, hostOnError, hostInflightRef)
    }

    const intervalId = window.setInterval(tick, pollMs)
    tick()

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
      if (inflightRef.current) {
        inflightRef.current.abort()
        inflightRef.current = null
      }
      if (hostInflightRef.current) {
        hostInflightRef.current.abort()
        hostInflightRef.current = null
      }
    }
  }, [settings, appendEvent])

  const enableDemo = useCallback(() => persist({ demo: true }), [persist])
  const disableDemo = useCallback(() => persist({ demo: false }), [persist])
  const setEndpoint = useCallback((ep: string) => persist({ endpoint: ep }), [persist])
  const setHostEndpoint = useCallback((ep: string) => persist({ hostEndpoint: ep }), [persist])
  const setPollMs = useCallback((ms: number) => persist({ pollMs: ms }), [persist])
  const setSelectedChartMetric = useCallback((id: string) => persist({ selectedChartMetric: id }), [persist])

  return { state, settings, enableDemo, disableDemo, setEndpoint, setHostEndpoint, setPollMs, setSelectedChartMetric }
}
