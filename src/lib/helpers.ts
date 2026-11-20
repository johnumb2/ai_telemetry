import { Sample, specValue, windowedRatio, baseSum, METRICS, seriesValue } from './derive'
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

export interface HostChips {
  ramUsed: number | undefined
  gpuFan: number | undefined
  gpuFanRpm: number | undefined
  gpuFanMaxRpm: number | undefined
  vramUsedGb: number | undefined
  processes: number | undefined
  nvmeMax: number | undefined
  uptimeH: number | undefined
}

/** Secondary (non-card) host telemetry chips, read from the latest host sample. */
export function computeHostChips(samples: Sample[]): HostChips {
  const empty: HostChips = {
    ramUsed: undefined,
    gpuFan: undefined,
    gpuFanRpm: undefined,
    gpuFanMaxRpm: undefined,
    vramUsedGb: undefined,
    processes: undefined,
    nvmeMax: undefined,
    uptimeH: undefined,
  }
  if (samples.length === 0) return empty
  const cur = samples[samples.length - 1]

  const ramUsed = seriesValue(cur, 'host_ram_used_percent')
  const gpuFan = seriesValue(cur, 'host_gpu_fan_percent')
  const gpuFanRpm = seriesValue(cur, 'host_gpu_fan_rpm')
  const gpuFanMaxRpm = seriesValue(cur, 'host_gpu_fan_max_rpm')
  const vramUsedGb = seriesValue(cur, 'host_gpu_vram_used_bytes') !== undefined ? seriesValue(cur, 'host_gpu_vram_used_bytes')! / 1e9 : undefined
  const processes = seriesValue(cur, 'host_process_count')

  let nvmeMax: number | undefined
  for (const [k, v] of Object.entries(cur.values)) {
    if (k.startsWith('host_nvme_temp_celsius|')) nvmeMax = nvmeMax === undefined ? v : Math.max(nvmeMax, v)
  }

  const up = seriesValue(cur, 'host_uptime_seconds')
  const uptimeH = up !== undefined ? up / 3600 : undefined

  return { ramUsed, gpuFan, gpuFanRpm, gpuFanMaxRpm, vramUsedGb, processes, nvmeMax, uptimeH }
}

export { windowedRatio }
