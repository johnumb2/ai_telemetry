import { useId } from 'react'

export interface AreaChartProps {
  points: Array<{ t: number; v: number }>
  accent: string
  height?: number
  formatValue?: (v: number) => string
  unit?: string
}

function compactTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`
}

function niceStep(raw: number): number {
  if (raw <= 0) return 1
  const p = 10 ** Math.floor(Math.log10(raw))
  const n = raw / p
  if (n < 1.5) return p
  if (n < 3.5) return 2 * p
  if (n < 7.5) return 5 * p
  return 10 * p
}

export function AreaChart({ points, accent, height = 280, formatValue, unit = '' }: AreaChartProps) {
  const uid = useId().replace(/:/g, '')
  const W = 860
  const H = height
  const mTop = 36
  const mBottom = 28
  const mLeft = 52
  const mRight = 16
  const plotW = W - mLeft - mRight
  const plotH = H - mTop - mBottom

  if (points.length < 2) {
    return (
      <svg className="area-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="no data yet">
        <text x={W / 2} y={H / 2} fill="var(--text-mute)" fontSize="14" textAnchor="middle" fontFamily="JetBrains Mono, monospace">
          waiting for data…
        </text>
      </svg>
    )
  }

  const vs = points.map((p) => p.v)
  const dataMin = Math.min(...vs)
  const dataMax = Math.max(...vs)
  const span = dataMax - dataMin
  const base = span < 1e-9 ? 1 : span
  const yMax = Math.max(dataMax, 0) + base * 0.15
  const yMin = Math.min(0, Math.min(dataMin, 0) - base * 0.1)

  const tMin = points[0].t
  const tMax = points[points.length - 1].t
  const tSpan = Math.max(1, tMax - tMin)

  const xOf = (t: number): number => mLeft + ((t - tMin) / tSpan) * plotW
  const yOf = (v: number): number => mTop + (1 - (v - yMin) / (yMax - yMin)) * plotH

  const pathPoints = points.map((p) => ({ x: xOf(p.t), y: yOf(p.v), v: p.v }))
  const linePts = pathPoints.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const firstX = pathPoints[0].x
  const lastX = pathPoints[pathPoints.length - 1].x
  const areaPath = `M${firstX},${mTop + plotH} L${linePts.split(' ').join(' L')} L${lastX},${mTop + plotH} Z`

  // y-axis gridlines
  const yStep = niceStep((yMax - yMin) / 4)
  const gridlines: Array<{ y: number; v: number }> = []
  for (let v = Math.ceil(yMin / yStep) * yStep; v <= yMax + yStep * 0.01; v += yStep) {
    gridlines.push({ y: yOf(v), v })
    if (gridlines.length > 5) break
  }

  // x-axis time ticks (4)
  const ticks: Array<{ x: number; t: number }> = []
  for (let k = 0; k < 4; k++) {
    const t = tMin + (tSpan / 3) * k
    ticks.push({ x: xOf(t), t })
  }

  const curX = lastX
  const curY = pathPoints[pathPoints.length - 1].y
  const curV = points[points.length - 1].v
  const curLabel = (formatValue ? formatValue(curV) : curV.toLocaleString()) + unit

  return (
    <svg
      className="area-chart"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`area chart, current value ${curLabel}`}
    >
      <defs>
        <linearGradient id={`grad-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.55" />
          <stop offset="100%" stopColor={accent} stopOpacity="0.03" />
        </linearGradient>
      </defs>

      {gridlines.map((g, i) => (
        <g key={`g-${i}`}>
          <line x1={mLeft} y1={g.y} x2={mLeft + plotW} y2={g.y} stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          <text x={mLeft - 8} y={g.y + 4} fill="var(--text-mute)" fontSize="11" textAnchor="end" fontFamily="JetBrains Mono, monospace">
            {(formatValue ? formatValue(g.v) : g.v)}
          </text>
        </g>
      ))}

      {ticks.map((t, i) => (
        <text
          key={`x-${i}`}
          x={t.x}
          y={H - 6}
          fill="var(--text-mute)"
          fontSize="11"
          textAnchor="middle"
          fontFamily="JetBrains Mono, monospace"
        >
          {compactTime(t.t)}
        </text>
      ))}

      <path d={areaPath} fill={`url(#grad-${uid})`} stroke="none" className="area-fill" />
      <polyline
        points={linePts}
        fill="none"
        stroke={accent}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="area-line"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={curX} cy={curY} r="3.5" fill={accent} className="area-dot" />
      <text
        x={W - mRight}
        y={mTop - 12}
        fill="var(--text-dim)"
        fontSize="12"
        textAnchor="end"
        fontFamily="JetBrains Mono, monospace"
      >
        {curLabel}
      </text>
    </svg>
  )
}
