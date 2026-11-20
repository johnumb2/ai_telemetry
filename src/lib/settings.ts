const STORAGE_KEY = 'pulse-dash'

export interface DashSettings {
  endpoint: string
  pollMs: number
  demo: boolean
  selectedChartMetric: string
}

export const DEFAULT_SETTINGS: DashSettings = {
  endpoint: '/metrics',
  pollMs: 1500,
  demo: false,
  selectedChartMetric: 'tokensRate',
}

export function loadSettings(): DashSettings {
  const out = { ...DEFAULT_SETTINGS }
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<DashSettings>
      if (typeof saved.endpoint === 'string' && saved.endpoint) out.endpoint = saved.endpoint
      if (typeof saved.pollMs === 'number' && saved.pollMs > 0) out.pollMs = saved.pollMs
      if (typeof saved.demo === 'boolean') out.demo = saved.demo
      if (typeof saved.selectedChartMetric === 'string' && saved.selectedChartMetric) {
        out.selectedChartMetric = saved.selectedChartMetric
      }
    }
  } catch {
    // corrupted or unavailable storage: fall back to defaults
  }
  return out
}

export function saveSettings(settings: DashSettings): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    // storage unavailable (private mode, quota) — non-fatal
  }
}

export function pollMsPresets(): Array<{ label: string; ms: number }> {
  return [
    { label: '0.5s', ms: 500 },
    { label: '1.5s', ms: 1500 },
    { label: '3s', ms: 3000 },
  ]
}
