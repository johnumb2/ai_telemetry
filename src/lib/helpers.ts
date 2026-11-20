import { Sample, specValue, windowedRatio, baseSum, METRICS } from './derive'
import { seriesKey } from '../types'

export type EngineState = 'awake' | 'sleeping' | 'unknown'

export function sampleEngineState(sample: Sample): EngineState {
  const awake = sample.values[seriesKey('vllm:engine_sleep_state', { engine: '0', model_name: 'Qwen3.8', sleep_state: 'awake' })]
  if (awake !== undefined && awake > 0) return 'awake'
  const off = sample.values[seriesKey('vllm:engine_sleep_state', { engine: '0', model_name: 'Qwen3.8', sleep_state: 'weights_offloaded' })]
  if (off !== undefined && off > 0) return 'sleeping'
  const disc = sample.values[seriesKey('vllm:engine_sleep_state', { engine: '0', model_name: 'Qwen3.8', sleep_state: 'discard_all' })]
  if (disc !== undefined && disc > 0) return 'sleeping'
  return 'unknown'
}

export interface SecondaryChips {
  specAccept: number | undefined
  prefixHit: number | undefined
  engine: 'awake' | 'sleeping' | 'unknown'
  preemptions: number | undefined
}

export function computeSecondaryChips(samples: Sample[]): SecondaryChips {
  if (samples.length === 0) {
    return { specAccept: undefined, prefixHit: undefined, engine: 'unknown', preemptions: 0 }
  }
  const cur = samples[samples.length - 1]
  const specAcceptSpec = METRICS.find((m) => m.id === 'specAccept')
  const prefixHitSpec = METRICS.find((m) => m.id === 'prefixHit')
  const preemptionSpec = METRICS.find((m) => m.id === 'preemptions')

  const specAccept = specAcceptSpec ? specValue(specAcceptSpec, samples, samples.length - 1, 8) : undefined
  const prefixHit = prefixHitSpec ? specValue(prefixHitSpec, samples, samples.length - 1, 8) : undefined
  const preemptions = preemptionSpec ? baseSum(cur, preemptionSpec.baseName) : 0

  return {
    specAccept,
    prefixHit,
    engine: sampleEngineState(cur),
    preemptions: preemptions ?? 0,
  }
}

export { windowedRatio }
