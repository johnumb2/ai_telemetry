import { Sample, toSample, baseSum } from './derive'
import { parseMetrics } from './parser'

/**
 * Generate a fully-populated demo sample using plausible random-walk values.
 * Counters are monotonically increasing so rates stay sensible; histograms
 * bucket counts are derived from the walk so p50/p95 stay coherent.
 */
export interface DemoState {
  tick: number
  reqCounter: number
  genTokCounter: number
  promptTokCounter: number
  preemption: number
  prefixHits: number
  prefixQueries: number
  specDraft: number
  specAccepted: number
  active: number
  queued: number
  kv: number
  ttftSum: number
  ttftCount: number
  ttftBuckets: number[]
  e2eBuckets: number[]
  itlBuckets: number[]
  http4xx: number
  cpuSec: number
  preemptionsTotal: number
}

export function makeDemoState(): DemoState {
  return {
    tick: 0,
    reqCounter: 400,
    genTokCounter: 400_000,
    promptTokCounter: 12_000,
    preemption: 3,
    prefixHits: 3.6e8,
    prefixQueries: 3.9e8,
    specDraft: 820_000,
    specAccepted: 540_000,
    active: 8,
    queued: 2,
    kv: 0.42,
    ttftSum: 0.0,
    ttftCount: 0,
    ttftBuckets: new Array(12).fill(0),
    e2eBuckets: new Array(12).fill(0),
    itlBuckets: new Array(12).fill(0),
    http4xx: 24,
    cpuSec: 2200,
    preemptionsTotal: 3,
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const gauss = (): number => {
  // Box-Muller
  const u = Math.random()
  const v = Math.random()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

const TTFT_BUCKETS = [0.005, 0.01, 0.015, 0.02, 0.04, 0.06, 0.08, 0.1, 0.15, 0.2, 0.4, 0.8]
const E2E_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60, 120]
const ITL_BUCKETS = [0.001, 0.002, 0.004, 0.006, 0.008, 0.01, 0.02, 0.04, 0.08, 0.12]

/** advance the demo state one tick; returns the full Parsed-shaped body string */
export function stepDemo(state: DemoState): string {
  state.tick += 1
  const targetActive = 8 + Math.round(gauss() * 6 + Math.sin(state.tick / 6) * 4)
  state.active = clamp(Math.round(state.active + (targetActive - state.active) * 0.5 + gauss()), 0, 48)
  const targetQueued = state.active > 24 ? 8 : 2
  state.queued = clamp(Math.round(state.queued + (targetQueued - state.queued) * 0.5), 0, 40)
  const targetKv = state.active / 48
  state.kv = clamp(state.kv + (targetKv - state.kv) * 0.3 + gauss() * 0.02, 0.02, 0.999)

  const newReq = Math.max(0, Math.round(gauss() * 1.4 + (state.active > 10 ? 1.5 : 0)))
  state.reqCounter = Math.max(0, state.reqCounter + newReq)

  const newTok = state.active >= 2 ? Math.round(state.active * (80 + Math.abs(gauss()) * 80)) : 0
  state.genTokCounter += newTok
  state.promptTokCounter += state.active * (240 + Math.abs(gauss()) * 120)

  if (state.queued >= 12) state.preemptionsTotal += Math.max(0, Math.round(gauss() * 0.4))
  if (Math.random() < 0.04) state.http4xx += 1

  const q = 3.8 + Math.abs(gauss()) * 2
  state.prefixQueries += q
  state.prefixHits += q * clamp(0.82 + Math.abs(gauss()) * 0.1, 0.6, 0.98)

  const d = state.active >= 2 ? Math.round(state.active * 12 * Math.abs(gauss())) : 0
  state.specDraft += d
  state.specAccepted += Math.round(d * clamp(0.6 + Math.abs(gauss()) * 0.08, 0.3, 0.9))

  state.cpuSec += 0.05 + Math.abs(gauss()) * 0.03

  const p50ttft = 0.018 + Math.abs(gauss()) * 0.01
  if (newReq > 0) {
    const ttft = p50ttft * (0.6 + Math.abs(gauss()))
    state.ttftSum += ttft
    state.ttftCount += newReq
    // spread count across buckets by where the sample landed
    for (let i = TTFT_BUCKETS.length - 1; i >= 0; i--) {
      if (ttft <= TTFT_BUCKETS[i]) {
        state.ttftBuckets[i] += newReq
        break
      }
    }
    const e2e = ttft * (8 + Math.abs(gauss()) * 6) + 0.4
    for (let i = E2E_BUCKETS.length - 1; i >= 0; i--) {
      if (e2e <= E2E_BUCKETS[i]) {
        state.e2eBuckets[i] += newReq
        break
      }
    }
    const itl = 0.005 + Math.abs(gauss()) * 0.005
    for (let i = ITL_BUCKETS.length - 1; i >= 0; i--) {
      if (itl <= ITL_BUCKETS[i]) {
        state.itlBuckets[i] += newTok
        break
      }
    }
  }

  return renderDemo(state)
}

function renderDemo(state: DemoState): string {
  const out: string[] = []
  const push = (...args: string[]): void => {
    out.push(args.join(' '))
  }

  push(`vllm:num_requests_running{engine="0",model_name="Qwen3.8"} ${state.active}`)
  push(`vllm:num_requests_waiting{engine="0",model_name="Qwen3.8"} ${state.queued}`)
  push(`vllm:kv_cache_usage_perc{engine="0",model_name="Qwen3.8"} ${state.kv.toFixed(4)}`)
  push(`# TYPE vllm:generation_tokens_total counter`)
  push(`vllm:generation_tokens_total{engine="0",model_name="Qwen3.8"} ${state.genTokCounter}`)
  push(`# TYPE vllm:prompt_tokens_total counter`)
  push(`vllm:prompt_tokens_total{engine="0",model_name="Qwen3.8"} ${state.promptTokCounter}`)
  push(`# TYPE vllm:request_success_total counter`)
  for (const reason of ['stop', 'length', 'abort', 'error', 'repetition']) {
    const v = state.reqCounter
    push(`vllm:request_success_total{engine="0",finished_reason="${reason}",model_name="Qwen3.8"} ${reason === 'stop' ? v : 0}`)
  }
  push(`# TYPE vllm:num_preemptions_total counter`)
  push(`vllm:num_preemptions_total{engine="0",model_name="Qwen3.8"} ${state.preemptionsTotal}`)
  push(`# TYPE vllm:prefix_cache_hits_total counter`)
  push(`vllm:prefix_cache_hits_total{engine="0",model_name="Qwen3.8"} ${state.prefixHits}`)
  push(`# TYPE vllm:prefix_cache_queries_total counter`)
  push(`vllm:prefix_cache_queries_total{engine="0",model_name="Qwen3.8"} ${state.prefixQueries}`)
  push(`# TYPE vllm:spec_decode_num_draft_tokens_total counter`)
  push(`vllm:spec_decode_num_draft_tokens_total{engine="0",model_name="Qwen3.8"} ${state.specDraft}`)
  push(`# TYPE vllm:spec_decode_num_accepted_tokens_total counter`)
  push(`vllm:spec_decode_num_accepted_tokens_total{engine="0",model_name="Qwen3.8"} ${state.specAccepted}`)
  push(`# TYPE vllm:engine_sleep_state gauge`)
  push(`vllm:engine_sleep_state{engine="0",model_name="Qwen3.8",sleep_state="awake"} 1`)
  push(`vllm:engine_sleep_state{engine="0",model_name="Qwen3.8",sleep_state="weights_offloaded"} 0`)
  push(`vllm:engine_sleep_state{engine="0",model_name="Qwen3.8",sleep_state="discard_all"} 0`)
  push(`# TYPE vllm:time_to_first_token_seconds histogram`)
  let runSum = 0
  for (let i = 0; i < TTFT_BUCKETS.length; i++) {
    runSum += state.ttftBuckets[i]
    push(`vllm:time_to_first_token_seconds_bucket{engine="0",le="${TTFT_BUCKETS[i]}",model_name="Qwen3.8"} ${runSum}`)
  }
  push(`vllm:time_to_first_token_seconds_bucket{engine="0",le="Inf",model_name="Qwen3.8"} ${state.ttftCount}`)
  push(`vllm:time_to_first_token_seconds_sum{engine="0",model_name="Qwen3.8"} ${state.ttftSum}`)
  push(`vllm:time_to_first_token_seconds_count{engine="0",model_name="Qwen3.8"} ${state.ttftCount}`)
  push(`# TYPE vllm:e2e_request_latency_seconds histogram`)
  let e2eSum = 0
  for (let i = 0; i < E2E_BUCKETS.length; i++) {
    e2eSum += state.e2eBuckets[i]
    push(`vllm:e2e_request_latency_seconds_bucket{engine="0",le="${E2E_BUCKETS[i]}",model_name="Qwen3.8"} ${e2eSum}`)
  }
  push(`vllm:e2e_request_latency_seconds_bucket{engine="0",le="Inf",model_name="Qwen3.8"} ${state.ttftCount}`)
  push(`vllm:e2e_request_latency_seconds_sum{engine="0",model_name="Qwen3.8"} ${state.ttftSum * 10}`)
  push(`vllm:e2e_request_latency_seconds_count{engine="0",model_name="Qwen3.8"} ${state.ttftCount}`)
  push(`# TYPE vllm:inter_token_latency_seconds histogram`)
  let itlSum = 0
  for (let i = 0; i < ITL_BUCKETS.length; i++) {
    itlSum += state.itlBuckets[i]
    push(`vllm:inter_token_latency_seconds_bucket{engine="0",le="${ITL_BUCKETS[i]}",model_name="Qwen3.8"} ${itlSum}`)
  }
  push(`vllm:inter_token_latency_seconds_bucket{engine="0",le="Inf",model_name="Qwen3.8"} ${state.genTokCounter}`)
  push(`vllm:inter_token_latency_seconds_sum{engine="0",model_name="Qwen3.8"} ${state.genTokCounter * 0.006}`)
  push(`vllm:inter_token_latency_seconds_count{engine="0",model_name="Qwen3.8"} ${state.genTokCounter}`)
  push(`# TYPE http_requests_total counter`)
  push(`http_requests_total{handler="/v1/chat/completions",method="POST",status="2xx"} ${state.reqCounter}`)
  push(`http_requests_total{handler="/v1/chat/completions",method="POST",status="4xx"} ${state.http4xx}`)
  push(`# TYPE process_cpu_seconds_total counter`)
  push(`process_cpu_seconds_total ${state.cpuSec}`)
  return out.join('\n')
}

/**
 * Build the initial burst of demo samples so charts/sparklines/fill look alive
 * immediately when the user toggles demo mode on.
 */
export function bootstrapDemoSamples(count: number, state: DemoState): Sample[] {
  const out: Sample[] = []
  const now = Date.now()
  for (let i = 0; i < count; i++) {
    const body = stepDemo(state)
    const parsed = parseMetrics(body)
    const s = toSample(parsed)
    s.t = now - (count - i) * 1500
    out.push(s)
  }
  return out
}

export { baseSum }
