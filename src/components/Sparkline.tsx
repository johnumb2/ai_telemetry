export interface SparklineProps {
  points: Array<{ t: number; v: number }>
  accent: string
  height?: number
  width?: number
  strokeWidth?: number
  /** unique id prefix so the gradient def is unique per instance */
  idPrefix?: string
}

export function Sparkline({ points, accent, height = 60, width = 100, strokeWidth = 1.5, idPrefix = 'sp' }: SparklineProps) {
  if (points.length < 2) return <></>

  const vs = points.map((p) => p.v)
  const min = Math.min(...vs)
  const max = Math.max(...vs)
  const pad = max - min < 1e-9 ? 1 : (max - min) * 0.12
  const lo = min - pad
  const hi = max + pad

  const xOf = (i: number): number => (i / (points.length - 1)) * width
  const yOf = (v: number): number => {
    const f = (v - lo) / (hi - lo)
    return (1 - f) * (height - strokeWidth) + strokeWidth / 2
  }

  const linePts = points.map((p, i) => `${xOf(i).toFixed(2)},${yOf(p.v).toFixed(2)}`).join(' ')
  const areaPath = `M0,${height} L${linePts.split(' ').join(' L')} L${width},${height} Z`

  const gradId = `spark-${idPrefix}`

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block' }}
      preserveAspectRatio="none"
      role="img"
      aria-hidden="true"
      focusable={false}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={accent} stopOpacity="0.5" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <polyline
        points={linePts}
        fill="none"
        stroke={accent}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
