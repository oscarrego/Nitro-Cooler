import {
  type ChangeEvent,
  useEffect,
  useRef,
  useState,
  useCallback,
} from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './NitroApp.css'
import {
  applyAutoRefreshRate,
  applyBlueLightFilter,
  applyBootLogo,
  applyCustomFanCurves,
  applyFanProfile,
  applyGpuTuning,
  applyPowerProfile,
  applySmartCharging,
  appendPerformanceLog,
  cancelFanSpeedCalibration,
  checkForUpdates,
  getBackendBootstrap,
  getBackendPollSnapshot,
  getLiveControlSnapshot,
  installStagedUpdate,
  saveControlSnapshot,
  setNvidiaTelemetryEnabled,
  showThermalWarningNotification,
  showUpdateNotification,
  stageUpdateDownload,
  startFanSpeedCalibration,
  type CapabilitySnapshot,
  type ControlSnapshot,
  type BootArtId,
  type CustomPowerBaseId,
  type FeatureSupport,
  type LiveControlSnapshot,
  type PerformanceLogEvent,
  type ServiceStatus,
  type TelemetrySnapshot,
  type UpdateStatus,
} from './lib/backend'

// ── Types ─────────────────────────────────────────────────────────────────────

type CurveTarget = 'cpu' | 'gpu'
type UpdateChannel = ControlSnapshot['personalSettings']['updateChannel']

type CurvePoint = { temp: number; speed: number }
type CurveSet = Record<CurveTarget, CurvePoint[]>
type FanProfileId = 'auto' | 'max' | 'custom'
type PowerProfileId = 'battery-guard' | 'balanced' | 'performance' | 'turbo' | 'custom'

type GpuTuningState = {
  coreClock: number
  memoryClock: number
  voltageOffset: number
  powerLimit: number
  tempLimit: number
}

type OcProfileSlot = {
  id: string
  label: string
  name: string
  strap: string
  settings: GpuTuningState
  isCustom?: boolean
}

type PersistControlOverrides = {
  activePowerProfile?: PowerProfileId
  activeFanProfile?: FanProfileId
  customProcessorState?: { min: number; max: number }
  customPowerBase?: CustomPowerBaseId
  customCurves?: CurveSet
  fanSyncLockEnabled?: boolean
  smartChargingEnabled?: boolean
  processorStateControlEnabled?: boolean
  nvidiaTelemetryEnabled?: boolean
  keepUiPrewarmed?: boolean
  autoRefreshRateOnBatteryEnabled?: boolean
  autoRefreshRateRestoreHz?: number | null
  blueLightFilterEnabled?: boolean
  selectedBootArt?: string
  customBootFilename?: string
  updateChannel?: UpdateChannel
  checkForUpdatesOnLaunch?: boolean
}

// ── Constants ─────────────────────────────────────────────────────────────────

const BACKEND_POLL_INTERVAL_MS = 1000
const HIDDEN_BACKEND_POLL_INTERVAL_MS = 5000
const FAN_PROFILE_APPLY_TIMEOUT_MS = 15_000

// NitroSense-style power plan names matching the screenshot exactly
const NITRO_POWER_PLANS: { id: PowerProfileId; label: string }[] = [
  { id: 'battery-guard', label: 'Power Saver' },
  { id: 'balanced',      label: 'Balance' },
  { id: 'performance',   label: 'Balance\n[Acer Optimized]' },
  { id: 'turbo',         label: 'High-Performance' },
]

const DEFAULT_GPU_OVERCLOCK: GpuTuningState = {
  coreClock: 165,
  memoryClock: 420,
  voltageOffset: -35,
  powerLimit: 114,
  tempLimit: 83,
}

const DEFAULT_CUSTOM_OC_SLOT: OcProfileSlot = {
  id: 'custom-user',
  label: 'P5',
  name: 'Custom Preset',
  strap: 'User-saved GPU tuning',
  settings: { ...DEFAULT_GPU_OVERCLOCK },
  isCustom: true,
}

const BUILT_IN_OC_SLOTS: OcProfileSlot[] = [
  { id: 'silent-uv', label: 'P1', name: 'Silent UV', strap: 'Low-noise undervolt', settings: { coreClock: 90, memoryClock: 180, voltageOffset: -60, powerLimit: 92, tempLimit: 78 } },
  { id: 'daily',     label: 'P2', name: 'Forge Daily', strap: 'Balanced everyday tune', settings: { ...DEFAULT_GPU_OVERCLOCK } },
  { id: 'creator',   label: 'P3', name: 'Creator Boost', strap: 'Long-session render preset', settings: { coreClock: 185, memoryClock: 560, voltageOffset: -10, powerLimit: 118, tempLimit: 84 } },
  { id: 'arena',     label: 'P4', name: 'Arena Max', strap: 'Aggressive gaming tune', settings: { coreClock: 220, memoryClock: 840, voltageOffset: 25, powerLimit: 122, tempLimit: 86 } },
]

// ── Helper functions ──────────────────────────────────────────────────────────

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }

function describeError(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try { return JSON.stringify(error) } catch { return 'Unknown error' }
}

function isDesktopRuntime() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function waitForNextPaint() {
  return new Promise<void>((resolve) => {
    if (typeof window.requestAnimationFrame !== 'function') { window.setTimeout(resolve, 0); return }
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string) {
  let tid: number | null = null
  const timeout = new Promise<T>((_, reject) => {
    tid = window.setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => { if (tid !== null) window.clearTimeout(tid) })
}

function presentPositive(v: number | null | undefined) { return (v != null && v > 0) ? v : null }

function hasUsableTelemetry(s: TelemetrySnapshot | null | undefined) {
  if (!s) return false
  return Boolean(s.cpuTempC > 0 || s.gpuTempC > 0 || s.cpuUsagePercent > 0 || s.gpuUsagePercent > 0 || s.cpuFanRpm > 0 || s.gpuFanRpm > 0)
}

function normalizeCurvePoints(points: CurvePoint[]) {
  const sorted = points.map(p => ({ temp: Math.round(clamp(p.temp, 30, 90)), speed: Math.round(clamp(p.speed, 0, 100)) })).sort((a, b) => a.temp - b.temp)
  let lastTemp = 28, lastSpeed = 0
  return sorted.map((p, i) => {
    const minTemp = i === 0 ? 30 : lastTemp + 2
    const maxTemp = 90 - (sorted.length - i - 1) * 2
    const n = { temp: clamp(p.temp, minTemp, maxTemp), speed: clamp(p.speed, lastSpeed, 100) }
    lastTemp = n.temp; lastSpeed = n.speed; return n
  })
}

function duplicateCurveSet(c: CurveSet): CurveSet {
  return { cpu: normalizeCurvePoints(c.cpu), gpu: normalizeCurvePoints(c.gpu) }
}

function fromBackendCurveSet(c: ControlSnapshot['fanCurves']): CurveSet {
  return duplicateCurveSet({ cpu: c.cpu.map(p => ({ temp: p.tempC, speed: p.speedPercent })), gpu: c.gpu.map(p => ({ temp: p.tempC, speed: p.speedPercent })) })
}

function toBackendCurveSet(c: CurveSet): ControlSnapshot['fanCurves'] {
  const n = duplicateCurveSet(c)
  return { cpu: n.cpu.map(p => ({ tempC: p.temp, speedPercent: p.speed })), gpu: n.gpu.map(p => ({ tempC: p.temp, speedPercent: p.speed })) }
}

function fromBackendGpuTuning(t: ControlSnapshot['gpuTuning']): GpuTuningState {
  return { coreClock: t.coreClockMhz, memoryClock: t.memoryClockMhz, voltageOffset: t.voltageOffsetMv, powerLimit: t.powerLimitPercent, tempLimit: t.tempLimitC }
}

function toBackendGpuTuning(t: GpuTuningState): ControlSnapshot['gpuTuning'] {
  return { coreClockMhz: t.coreClock, memoryClockMhz: t.memoryClock, voltageOffsetMv: t.voltageOffset, powerLimitPercent: t.powerLimit, tempLimitC: t.tempLimit }
}

function getProcessorStateForProfile(id: PowerProfileId, custom: { min: number; max: number }) {
  switch (id) {
    case 'battery-guard': return { min: 5, max: 45 }
    case 'balanced':      return { min: 35, max: 88 }
    case 'performance':   return { min: 100, max: 100 }
    case 'turbo':         return { min: 100, max: 100 }
    default:              return custom
  }
}

// ── Monitoring graph helpers ──────────────────────────────────────────────────

const GRAPH_HISTORY = 120  // samples

function drawMonitoringGraph(
  canvas: HTMLCanvasElement,
  tempHistory: number[],
  loadHistory: number[],
) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const W = canvas.width
  const H = canvas.height
  const N = GRAPH_HISTORY

  ctx.clearRect(0, 0, W, H)

  // Background fill
  ctx.fillStyle = '#0d0d0d'
  ctx.fillRect(0, 0, W, H)

  // Subtle horizontal grid lines
  ctx.strokeStyle = 'rgba(255,80,0,0.06)'
  ctx.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const y = Math.round((H / 4) * i)
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
  }

  // Vertical grid lines
  for (let i = 1; i < 6; i++) {
    const x = Math.round((W / 6) * i)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
  }

  function drawSeries(history: number[], maxVal: number, fillColor: string, strokeColor: string) {
    if (history.length < 2) return
    const step = W / (N - 1)

    ctx!.beginPath()
    history.forEach((v, i) => {
      const x = i * step
      const y = H - (v / maxVal) * H
      if (i === 0) ctx!.moveTo(x, y); else ctx!.lineTo(x, y)
    })

    // Fill under the curve
    const grad = ctx!.createLinearGradient(0, 0, 0, H)
    grad.addColorStop(0, fillColor)
    grad.addColorStop(1, 'transparent')
    ctx!.lineTo(W, H); ctx!.lineTo(0, H); ctx!.closePath()
    ctx!.fillStyle = grad
    ctx!.fill()

    // Stroke line
    ctx!.beginPath()
    history.forEach((v, i) => {
      const x = i * step
      const y = H - (v / maxVal) * H
      if (i === 0) ctx!.moveTo(x, y); else ctx!.lineTo(x, y)
    })
    ctx!.strokeStyle = strokeColor
    ctx!.lineWidth = 1.5
    ctx!.stroke()
  }

  // Load % (orange, drawn first = behind)
  drawSeries(loadHistory, 100, 'rgba(220,90,0,0.18)', 'rgba(220,90,0,0.75)')
  // Temp (brighter red-orange, on top)
  drawSeries(tempHistory, 120, 'rgba(240,60,0,0.22)', 'rgba(240,80,20,0.9)')
}

// ── Fan blade SVG ─────────────────────────────────────────────────────────────

function FanBladeSVG({ size = 110, active = false }: { size?: number; active?: boolean }) {
  // 8-blade fan matching the NitroSense aesthetic
  const cx = size / 2
  const r  = size / 2

  // Generate 8 blade paths
  const blades = Array.from({ length: 8 }, (_, i) => {
    const angle = (i * 45 * Math.PI) / 180
    const cos = Math.cos(angle)
    const sin = Math.sin(angle)
    // Blade: a thin elongated teardrop shape, rotated
    const bLen = r * 0.82
    const bW   = r * 0.16
    const x1 = cx + cos * bLen
    const y1 = cx + sin * bLen
    const cx1 = cx + cos * bLen * 0.5 + sin * bW
    const cy1 = cx + sin * bLen * 0.5 - cos * bW
    const cx2 = cx + cos * bLen * 0.8 - sin * bW * 0.5
    const cy2 = cx + sin * bLen * 0.8 + cos * bW * 0.5
    return `M ${cx} ${cx} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x1} ${y1}`
  })

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      style={{ display: 'block' }}
    >
      {/* Outer ring */}
      <circle cx={cx} cy={cx} r={r - 2} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="1.5" />
      {/* Inner hub */}
      <circle cx={cx} cy={cx} r={r * 0.12} fill={active ? 'rgba(232,74,26,0.6)' : 'rgba(255,255,255,0.1)'} />
      {/* Blades */}
      {blades.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={active ? 'rgba(232,74,26,0.55)' : 'rgba(255,255,255,0.18)'} strokeWidth="6" strokeLinecap="round" />
      ))}
    </svg>
  )
}

// ── Fan Mode Icon SVG (for sidebar buttons) ───────────────────────────────────

function FanModeIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" fill="none" className="ns-fan-icon">
      <circle cx="11" cy="11" r="10" stroke={active ? '#e84a1a' : '#555'} strokeWidth="1.2" />
      <circle cx="11" cy="11" r="2.5" fill={active ? '#e84a1a' : '#555'} />
      {[0, 60, 120, 180, 240, 300].map((deg, i) => {
        const rad = (deg * Math.PI) / 180
        const x1 = 11 + Math.cos(rad) * 3
        const y1 = 11 + Math.sin(rad) * 3
        const x2 = 11 + Math.cos(rad) * 8
        const y2 = 11 + Math.sin(rad) * 8
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={active ? '#e84a1a' : '#555'} strokeWidth="2.2" strokeLinecap="round" />
      })}
    </svg>
  )
}

// ── CoolBoost toggle ──────────────────────────────────────────────────────────

function CoolBoostToggle({ enabled, onChange }: { enabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="ns-coolboost">
      <div className="ns-coolboost__row">
        <span className="ns-coolboost__info">ℹ</span>
        <span className="ns-coolboost__label">CoolBoost™</span>
        <label className="ns-toggle">
          <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked)} />
          <span className="ns-toggle__slider" />
        </label>
      </div>
    </div>
  )
}

// ── Monitoring chart row ──────────────────────────────────────────────────────

interface ChartRowProps {
  label: string
  tempHistory: number[]
  loadHistory: number[]
  currentTemp: number | null
  currentLoad: number | null
  minTemp: number
  maxTemp: number
}

function ChartRow({ label, tempHistory, loadHistory, currentTemp, currentLoad, minTemp, maxTemp }: ChartRowProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef   = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap   = wrapRef.current
    if (!canvas || !wrap) return

    // Match physical pixels
    const rect = wrap.getBoundingClientRect()
    const dpr  = window.devicePixelRatio || 1
    canvas.width  = rect.width  * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')
    if (ctx) ctx.scale(dpr, dpr)

    drawMonitoringGraph(canvas, tempHistory, loadHistory)
  }, [tempHistory, loadHistory])

  return (
    <div className="ns-chart-row">
      <div className="ns-chart-header">
        <span className="ns-chart-title">{label}</span>
        <span className="ns-chart-minmax">
          {minTemp > 0 ? `Min: ${minTemp}°  Max: ${maxTemp}°` : ''}
        </span>
      </div>
      <div className="ns-chart-body">
        <div className="ns-chart-canvas-wrap" ref={wrapRef}>
          <canvas className="ns-chart-canvas" ref={canvasRef} />
        </div>
        <div className="ns-chart-readouts">
          <span className="ns-chart-readout-temp">
            {currentTemp != null ? `${currentTemp}°` : '--°'}
          </span>
          <span className="ns-chart-readout-load">
            {currentLoad != null ? `${currentLoad} %` : '-- %'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── Main App ──────────────────────────────────────────────────────────────────

export default function NitroApp() {
  // ── Core state ─────────────────────────────────────────────────────────────
  const [activeFanProfile, setActiveFanProfile]   = useState<FanProfileId>('auto')
  const [activePowerProfile, setActivePowerProfile] = useState<PowerProfileId>('turbo')
  const [acMode, setAcMode]                        = useState<'ac' | 'battery'>('ac')
  const [coolBoostEnabled, setCoolBoostEnabled]    = useState(false)
  const [serviceConnected, setServiceConnected]    = useState(false)
  const [liveTelemetry, setLiveTelemetry]          = useState<TelemetrySnapshot | null>(null)
  const [liveControlSnapshot, setLiveControlSnapshot] = useState<LiveControlSnapshot | null>(null)
  const [customCpuSpeed, setCustomCpuSpeed]         = useState(50)
  const [customGpuSpeed, setCustomGpuSpeed]         = useState(50)

  // Persistence state (minimal — kept for backend compat)
  const [smartChargingEnabled, setSmartChargingEnabled]         = useState(true)
  const [processorStateControlEnabled, setProcessorStateControlEnabled] = useState(true)
  const [nvidiaTelemetryEnabled, setNvidiaTelemetryEnabledState] = useState(true)
  const [keepUiPrewarmed, setKeepUiPrewarmed]                   = useState(false)
  const [usbPowerEnabled, setUsbPowerEnabled]                   = useState(true)
  const [blueLightFilterEnabled, setBlueLightFilterEnabled]     = useState(false)
  const [autoRefreshRateOnBatteryEnabled, setAutoRefreshRateOnBatteryEnabled] = useState(false)
  const [autoRefreshRateRestoreHz, setAutoRefreshRateRestoreHz] = useState<number | null>(null)
  const [selectedBootArt, setSelectedBootArt]                   = useState('ember')
  const [customBootFilename, setCustomBootFilename]             = useState('custom-boot.png')
  const [updateChannel, setUpdateChannel]                       = useState<UpdateChannel>('stable')
  const [checkForUpdatesOnLaunch, setCheckForUpdatesOnLaunch]  = useState(true)
  const [customPowerBase, setCustomPowerBase]                   = useState<CustomPowerBaseId>('performance')
  const [customProcessorState, setCustomProcessorState]         = useState({ min: 35, max: 88 })
  const [gpuOverclock, setGpuOverclock]                         = useState<GpuTuningState>(DEFAULT_GPU_OVERCLOCK)
  const [customOcSlot, setCustomOcSlot]                         = useState<OcProfileSlot>(DEFAULT_CUSTOM_OC_SLOT)
  const [activeOcSlot, setActiveOcSlot]                         = useState('daily')
  const [ocApplyState, setOcApplyState]                         = useState<'staged' | 'live'>('live')
  const [ocTuningLocked, setOcTuningLocked]                     = useState(false)
  const [customCurves, setCustomCurves]                         = useState<CurveSet>(() => duplicateCurveSet({ cpu: [{ temp: 30, speed: 2 }, { temp: 49, speed: 2 }, { temp: 65, speed: 22 }, { temp: 74, speed: 64 }, { temp: 80, speed: 100 }], gpu: [{ temp: 30, speed: 2 }, { temp: 49, speed: 2 }, { temp: 65, speed: 22 }, { temp: 74, speed: 64 }, { temp: 80, speed: 100 }] }))
  const [fanSyncLockEnabled, setFanSyncLockEnabled]             = useState(false)
  const [backendCapabilities, setBackendCapabilities]           = useState<CapabilitySnapshot | null>(null)

  // ── Monitoring history ─────────────────────────────────────────────────────
  const [cpuTempHistory, setCpuTempHistory] = useState<number[]>([])
  const [cpuLoadHistory, setCpuLoadHistory] = useState<number[]>([])
  const [gpuTempHistory, setGpuTempHistory] = useState<number[]>([])
  const [gpuLoadHistory, setGpuLoadHistory] = useState<number[]>([])
  const [cpuMinTemp, setCpuMinTemp] = useState(0)
  const [cpuMaxTemp, setCpuMaxTemp] = useState(0)
  const [gpuMinTemp, setGpuMinTemp] = useState(0)
  const [gpuMaxTemp, setGpuMaxTemp] = useState(0)

  // ── Refs ───────────────────────────────────────────────────────────────────
  const backendPollInFlightRef          = useRef(false)
  const controlApplyInFlightRef         = useRef(0)
  const fanProfileApplyInFlightRef      = useRef(false)
  const powerProfileApplyInFlightRef    = useRef(false)
  const queuedFanProfileRef             = useRef<FanProfileId | null>(null)
  const queuedPowerProfileRef           = useRef<PowerProfileId | null>(null)
  const serviceConnectedRef             = useRef(false)
  const processorStateControlEnabledRef = useRef(true)
  const smartChargingEnabledRef         = useRef(true)
  const nvidiaTelemetryEnabledRef       = useRef(true)
  const keepUiPrewarmedRef              = useRef(false)
  const blueLightFilterEnabledRef       = useRef(false)
  const autoRefreshRateOnBatteryEnabledRef = useRef(false)
  const autoRefreshRateRestoreHzRef     = useRef<number | null>(null)
  const customCurvesRef                 = useRef<CurveSet>(customCurves)
  const customProcessorStateRef         = useRef(customProcessorState)
  const customPowerBaseRef              = useRef<CustomPowerBaseId>('performance')
  const telemetrySnapshotRef            = useRef<string | null>(null)
  const liveControlSnapshotStateRef     = useRef<string | null>(null)
  const liveControlSnapshotRef          = useRef<LiveControlSnapshot | null>(null)
  const fanProfileApplyPendingRef       = useRef(false)
  const customPowerApplyTimerRef        = useRef<number | null>(null)
  const customPowerApplyRevisionRef     = useRef(0)
  const persistStagedControlsRef        = useRef<(overrides?: PersistControlOverrides) => Promise<void>>(async () => {})
  const performanceLogSessionIdRef      = useRef(`ns-${Date.now().toString(36)}`)
  const performanceLogQueueRef          = useRef<PerformanceLogEvent[]>([])
  const performanceLogFlushTimerRef     = useRef<number | null>(null)
  const performanceLogFlushInFlightRef  = useRef(false)
  const performanceLogEventCountRef     = useRef(0)
  const performanceLogPathRef           = useRef<string | null>(null)
  const flushPerformanceLogRef          = useRef<() => Promise<void>>(async () => {})
  const runUpdateCheckRef               = useRef<((manual: boolean, channelOverride?: UpdateChannel) => Promise<UpdateStatus>) | null>(null)
  const autoUpdateCheckTriggeredRef     = useRef(false)
  const quietAutoThermalNotificationKeyRef = useRef<string | null>(null)
  const updateNotificationKeyRef        = useRef<string | null>(null)

  // ── Derived display values ─────────────────────────────────────────────────
  const activeTelemetry = hasUsableTelemetry(liveTelemetry) ? liveTelemetry : null
  const displayedCpuTemp    = presentPositive(activeTelemetry?.cpuTempAverageC ?? activeTelemetry?.cpuTempC ?? null)
  const displayedGpuTemp    = presentPositive(activeTelemetry?.gpuTempC ?? null)
  const displayedCpuUsage   = activeTelemetry?.cpuUsagePercent ?? null
  const displayedGpuUsage   = activeTelemetry?.gpuUsagePercent ?? null
  const displayedCpuFanRpm  = presentPositive(activeTelemetry?.cpuFanRpm ?? null)
  const displayedGpuFanRpm  = presentPositive(activeTelemetry?.gpuFanRpm ?? null)
  const displayedCpuFanTarget = liveControlSnapshot?.currentCpuFanSpeedPercent ?? null
  const displayedGpuFanTarget = liveControlSnapshot?.currentGpuFanSpeedPercent ?? null

  // ── Update monitoring history ──────────────────────────────────────────────
  useEffect(() => {
    if (!activeTelemetry) return

    const cpuTemp = activeTelemetry.cpuTempAverageC ?? activeTelemetry.cpuTempC ?? 0
    const gpuTemp = activeTelemetry.gpuTempC ?? 0
    const cpuLoad = activeTelemetry.cpuUsagePercent ?? 0
    const gpuLoad = activeTelemetry.gpuUsagePercent ?? 0

    setCpuTempHistory(prev => { const n = [...prev, cpuTemp].slice(-GRAPH_HISTORY); return n })
    setCpuLoadHistory(prev => { const n = [...prev, cpuLoad].slice(-GRAPH_HISTORY); return n })
    setGpuTempHistory(prev => { const n = [...prev, gpuTemp].slice(-GRAPH_HISTORY); return n })
    setGpuLoadHistory(prev => { const n = [...prev, gpuLoad].slice(-GRAPH_HISTORY); return n })

    setCpuMinTemp(prev => prev === 0 ? cpuTemp : Math.min(prev, cpuTemp))
    setCpuMaxTemp(prev => Math.max(prev, cpuTemp))
    setGpuMinTemp(prev => prev === 0 ? gpuTemp : Math.min(prev, gpuTemp))
    setGpuMaxTemp(prev => Math.max(prev, gpuTemp))
  }, [activeTelemetry])

  // ── Simulated data for browser preview (no Tauri) ─────────────────────────
  useEffect(() => {
    if (isDesktopRuntime()) return

    // Fill initial history with simulated data
    const baseCpuTemp = 47, baseGpuTemp = 45
    const initial = {
      cpuTemp: Array.from({ length: GRAPH_HISTORY }, (_, i) => baseCpuTemp + Math.sin(i * 0.15) * 8 + Math.random() * 4),
      cpuLoad: Array.from({ length: GRAPH_HISTORY }, (_, i) => 38 + Math.sin(i * 0.12) * 20 + Math.random() * 8),
      gpuTemp: Array.from({ length: GRAPH_HISTORY }, (_, i) => baseGpuTemp + Math.sin(i * 0.1) * 6 + Math.random() * 3),
      gpuLoad: Array.from({ length: GRAPH_HISTORY }, (_, i) => 22 + Math.sin(i * 0.08) * 15 + Math.random() * 6),
    }
    setCpuTempHistory(initial.cpuTemp)
    setCpuLoadHistory(initial.cpuLoad)
    setGpuTempHistory(initial.gpuTemp)
    setGpuLoadHistory(initial.gpuLoad)
    setCpuMinTemp(36); setCpuMaxTemp(91); setGpuMinTemp(35); setGpuMaxTemp(74)

    // Animate live telemetry simulation
    let frame = 0
    const timer = window.setInterval(() => {
      frame++
      const cpuTemp = baseCpuTemp + Math.sin(frame * 0.08) * 10 + Math.random() * 5
      const gpuTemp = baseGpuTemp + Math.sin(frame * 0.06) * 7 + Math.random() * 4
      const cpuLoad = 42 + Math.sin(frame * 0.1) * 22 + Math.random() * 10
      const gpuLoad = 25 + Math.sin(frame * 0.07) * 18 + Math.random() * 8
      const cpuRpm  = 2173 + Math.round(Math.sin(frame * 0.05) * 180 + Math.random() * 60)
      const gpuRpm  = 2542 + Math.round(Math.sin(frame * 0.04) * 220 + Math.random() * 80)

      setCpuTempHistory(prev => [...prev, cpuTemp].slice(-GRAPH_HISTORY))
      setCpuLoadHistory(prev => [...prev, cpuLoad].slice(-GRAPH_HISTORY))
      setGpuTempHistory(prev => [...prev, gpuTemp].slice(-GRAPH_HISTORY))
      setGpuLoadHistory(prev => [...prev, gpuLoad].slice(-GRAPH_HISTORY))

      setCpuMinTemp(prev => prev === 0 ? Math.round(cpuTemp) : prev)
      setCpuMaxTemp(prev => Math.max(prev, Math.round(cpuTemp)))
      setGpuMinTemp(prev => prev === 0 ? Math.round(gpuTemp) : prev)
      setGpuMaxTemp(prev => Math.max(prev, Math.round(gpuTemp)))

      setLiveTelemetry({
        cpuTempC: Math.round(cpuTemp),
        cpuTempAverageC: Math.round(cpuTemp),
        cpuTempLowestCoreC: Math.round(cpuTemp - 3),
        cpuTempHighestCoreC: Math.round(cpuTemp + 4),
        gpuTempC: Math.round(gpuTemp),
        systemTempC: Math.round((cpuTemp + gpuTemp) / 2),
        cpuUsagePercent: Math.round(cpuLoad),
        gpuUsagePercent: Math.round(gpuLoad),
        gpuMemoryUsagePercent: 38,
        gpuPowerDrawW: 65,
        gpuPowerLimitW: 80,
        gpuPowerDefaultLimitW: 80,
        gpuPowerMinLimitW: 20,
        gpuPowerMaxLimitW: 100,
        cpuPackagePowerW: 45,
        cpuPl1W: 45,
        cpuPl1Enabled: true,
        cpuPl2W: 65,
        cpuPl2Enabled: true,
        cpuPowerLimitLocked: false,
        cpuName: 'Core i7-12700H',
        cpuBrand: 'Intel',
        gpuName: 'RTX 3060 Laptop',
        gpuBrand: 'NVIDIA',
        systemVendor: 'Acer',
        systemModel: 'Nitro AN515-58',
        cpuClockMhz: 3200 + Math.round(Math.random() * 800),
        gpuClockMhz: 1500 + Math.round(Math.random() * 400),
        cpuFanRpm: cpuRpm,
        gpuFanRpm: gpuRpm,
        batteryPercent: 72,
        batteryLifeRemainingSec: null,
        acPluggedIn: true,
      })
    }, 1000)

    return () => window.clearInterval(timer)
  }, [])

  // ── Serialized state update helper ────────────────────────────────────────
  function updateSerializedState<T>(ref: { current: string | null }, value: T | null, setter: (next: T | null) => void) {
    const s = value == null ? null : JSON.stringify(value)
    if (ref.current === s) return
    ref.current = s; setter(value)
  }

  // ── Persistence helpers ───────────────────────────────────────────────────
  async function buildAndSaveSnapshot(overrides?: PersistControlOverrides) {
    const ocProfileSlots = [...BUILT_IN_OC_SLOTS, customOcSlot]
    const snapshot: ControlSnapshot = {
      activePowerProfile: overrides?.activePowerProfile ?? activePowerProfile,
      activeFanProfile:   overrides?.activeFanProfile ?? activeFanProfile,
      customProcessorState: {
        minPercent: (overrides?.customProcessorState ?? customProcessorStateRef.current).min,
        maxPercent: (overrides?.customProcessorState ?? customProcessorStateRef.current).max,
      },
      customPowerBase: overrides?.customPowerBase ?? customPowerBaseRef.current,
      gpuTuning: toBackendGpuTuning(gpuOverclock),
      ocPresets: ocProfileSlots.map(s => ({ id: s.id, label: s.label, name: s.name, strap: s.strap, settings: toBackendGpuTuning(s.settings), isCustom: Boolean(s.isCustom) })),
      activeOcSlot,
      ocApplyState,
      ocTuningLocked,
      fanCurves: toBackendCurveSet(overrides?.customCurves ?? customCurvesRef.current),
      fanSyncLockEnabled: overrides?.fanSyncLockEnabled ?? fanSyncLockEnabled,
      personalSettings: {
        smartChargingEnabled: overrides?.smartChargingEnabled ?? smartChargingEnabledRef.current,
        usbPowerEnabled,
        processorStateControlEnabled: overrides?.processorStateControlEnabled ?? processorStateControlEnabledRef.current,
        nvidiaTelemetryEnabled: overrides?.nvidiaTelemetryEnabled ?? nvidiaTelemetryEnabledRef.current,
        keepUiPrewarmed: overrides?.keepUiPrewarmed ?? keepUiPrewarmedRef.current,
        blueLightFilterEnabled: overrides?.blueLightFilterEnabled ?? blueLightFilterEnabledRef.current,
        autoRefreshRateOnBatteryEnabled: overrides?.autoRefreshRateOnBatteryEnabled ?? autoRefreshRateOnBatteryEnabledRef.current,
        autoRefreshRateRestoreHz: overrides?.autoRefreshRateRestoreHz ?? autoRefreshRateRestoreHzRef.current,
        selectedBootArt: (overrides?.selectedBootArt ?? selectedBootArt) as BootArtId,
        customBootFilename: overrides?.customBootFilename ?? customBootFilename,
        updateChannel: overrides?.updateChannel ?? updateChannel,
        checkForUpdatesOnLaunch: overrides?.checkForUpdatesOnLaunch ?? checkForUpdatesOnLaunch,
      },
    }
    try { await saveControlSnapshot(snapshot) } catch { /* non-fatal */ }
  }
  persistStagedControlsRef.current = buildAndSaveSnapshot

  // ── Apply all control snapshot from backend ───────────────────────────────
  function applyControlSnapshot(controls: ControlSnapshot, liveControls?: LiveControlSnapshot | null) {
    setActivePowerProfile(controls.activePowerProfile)
    setActiveFanProfile(controls.activeFanProfile)
    setCustomProcessorState({ min: controls.customProcessorState.minPercent, max: controls.customProcessorState.maxPercent })
    customProcessorStateRef.current = { min: controls.customProcessorState.minPercent, max: controls.customProcessorState.maxPercent }
    setCustomPowerBase(controls.customPowerBase)
    customPowerBaseRef.current = controls.customPowerBase
    setGpuOverclock(fromBackendGpuTuning(controls.gpuTuning))
    setCustomCurves(fromBackendCurveSet(controls.fanCurves))
    customCurvesRef.current = fromBackendCurveSet(controls.fanCurves)
    setFanSyncLockEnabled(controls.fanSyncLockEnabled)
    smartChargingEnabledRef.current = controls.personalSettings.smartChargingEnabled
    setSmartChargingEnabled(controls.personalSettings.smartChargingEnabled)
    processorStateControlEnabledRef.current = controls.personalSettings.processorStateControlEnabled
    setProcessorStateControlEnabled(controls.personalSettings.processorStateControlEnabled)
    nvidiaTelemetryEnabledRef.current = controls.personalSettings.nvidiaTelemetryEnabled ?? true
    setNvidiaTelemetryEnabledState(controls.personalSettings.nvidiaTelemetryEnabled ?? true)
    keepUiPrewarmedRef.current = controls.personalSettings.keepUiPrewarmed ?? false
    setKeepUiPrewarmed(controls.personalSettings.keepUiPrewarmed ?? false)
    setUsbPowerEnabled(controls.personalSettings.usbPowerEnabled)
    blueLightFilterEnabledRef.current = controls.personalSettings.blueLightFilterEnabled
    setBlueLightFilterEnabled(controls.personalSettings.blueLightFilterEnabled)
    autoRefreshRateOnBatteryEnabledRef.current = controls.personalSettings.autoRefreshRateOnBatteryEnabled
    setAutoRefreshRateOnBatteryEnabled(controls.personalSettings.autoRefreshRateOnBatteryEnabled)
    autoRefreshRateRestoreHzRef.current = controls.personalSettings.autoRefreshRateRestoreHz
    setAutoRefreshRateRestoreHz(controls.personalSettings.autoRefreshRateRestoreHz)
    setSelectedBootArt(controls.personalSettings.selectedBootArt)
    setCustomBootFilename(controls.personalSettings.customBootFilename)
    setCheckForUpdatesOnLaunch(controls.personalSettings.checkForUpdatesOnLaunch)
    setActiveOcSlot(controls.activeOcSlot)
    setOcApplyState(controls.ocApplyState)
    setOcTuningLocked(controls.ocTuningLocked)
    const customSlot = controls.ocPresets.find(p => p.isCustom)
    if (customSlot) setCustomOcSlot({ id: customSlot.id, label: customSlot.label, name: customSlot.name, strap: customSlot.strap, settings: fromBackendGpuTuning(customSlot.settings), isCustom: true })
    if (liveControls) {
      liveControlSnapshotRef.current = liveControls
      setLiveControlSnapshot(liveControls)
    }
  }

  // ── Backend bootstrap ─────────────────────────────────────────────────────
  useEffect(() => {
    const tauriInternals = (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
    if (!tauriInternals) return

    let cancelled = false

    async function bootstrap() {
      try {
        const bs = await getBackendBootstrap()
        if (cancelled) return
        setBackendCapabilities(bs.capabilities)
        setServiceConnected(bs.service.connected)
        serviceConnectedRef.current = bs.service.connected
        applyControlSnapshot(bs.controls, bs.liveControls)
        if (bs.telemetry) {
          updateSerializedState(telemetrySnapshotRef, bs.telemetry, setLiveTelemetry)
        }
      } catch { /* ignore */ }
    }

    void bootstrap()

    async function poll() {
      if (backendPollInFlightRef.current || controlApplyInFlightRef.current > 0) return
      backendPollInFlightRef.current = true
      try {
        const snap = await getBackendPollSnapshot()
        if (cancelled) return
        setServiceConnected(snap.service.connected)
        serviceConnectedRef.current = snap.service.connected
        updateSerializedState(telemetrySnapshotRef, snap.telemetry, setLiveTelemetry)
        updateSerializedState(liveControlSnapshotStateRef, snap.liveControls, (next) => {
          liveControlSnapshotRef.current = next
          setLiveControlSnapshot(next)
        })
      } catch { /* ignore */ } finally { backendPollInFlightRef.current = false }
    }

    let pollTimer = 0
    function scheduleNextPoll() {
      pollTimer = window.setTimeout(() => {
        void poll().finally(() => { if (!cancelled) scheduleNextPoll() })
      }, document.visibilityState === 'hidden' ? HIDDEN_BACKEND_POLL_INTERVAL_MS : BACKEND_POLL_INTERVAL_MS)
    }
    scheduleNextPoll()

    return () => { cancelled = true; window.clearTimeout(pollTimer) }
  }, [])

  // ── Fan Profile handler ───────────────────────────────────────────────────
  async function handleFanProfile(profileId: FanProfileId) {
    setActiveFanProfile(profileId)
    if (!serviceConnectedRef.current) {
      await buildAndSaveSnapshot({ activeFanProfile: profileId })
      return
    }
    if (fanProfileApplyInFlightRef.current) {
      queuedFanProfileRef.current = profileId
      return
    }
    fanProfileApplyInFlightRef.current = true
    controlApplyInFlightRef.current++
    try {
      await waitForNextPaint()
      const req = profileId === 'custom'
        ? applyCustomFanCurves(toBackendCurveSet(customCurvesRef.current))
        : applyFanProfile(profileId)
      const result = await withTimeout(req, FAN_PROFILE_APPLY_TIMEOUT_MS, `${profileId} fan apply`)
      applyControlSnapshot(result.controls)
    } catch { setActiveFanProfile(activeFanProfile) }
    finally {
      fanProfileApplyInFlightRef.current = false
      controlApplyInFlightRef.current = Math.max(0, controlApplyInFlightRef.current - 1)
      const queued = queuedFanProfileRef.current
      queuedFanProfileRef.current = null
      if (queued && queued !== profileId) void handleFanProfile(queued)
    }
  }

  // ── Power Profile handler ─────────────────────────────────────────────────
  async function handlePowerProfile(profileId: PowerProfileId) {
    setActivePowerProfile(profileId)
    const processorState = getProcessorStateForProfile(profileId, customProcessorStateRef.current)
    if (!serviceConnectedRef.current) {
      await buildAndSaveSnapshot({ activePowerProfile: profileId })
      return
    }
    if (powerProfileApplyInFlightRef.current) {
      queuedPowerProfileRef.current = profileId
      return
    }
    powerProfileApplyInFlightRef.current = true
    controlApplyInFlightRef.current++
    try {
      await waitForNextPaint()
      const result = await applyPowerProfile(profileId, { minPercent: processorState.min, maxPercent: processorState.max }, null, processorStateControlEnabledRef.current)
      applyControlSnapshot(result)
    } catch { /* ignore */ }
    finally {
      powerProfileApplyInFlightRef.current = false
      controlApplyInFlightRef.current = Math.max(0, controlApplyInFlightRef.current - 1)
      const queued = queuedPowerProfileRef.current
      queuedPowerProfileRef.current = null
      if (queued && queued !== profileId) void handlePowerProfile(queued)
    }
  }

  // ── CoolBoost (maps to fan profile: enable = max, disable = auto) ─────────
  async function handleCoolBoost(enabled: boolean) {
    setCoolBoostEnabled(enabled)
    await handleFanProfile(enabled ? 'max' : 'auto')
  }

  // ── Window controls ───────────────────────────────────────────────────────
  async function handleMinimize() {
    if (isDesktopRuntime()) await getCurrentWindow().minimize()
  }

  async function handleClose() {
    if (isDesktopRuntime()) await getCurrentWindow().close()
  }

  // ── Fan speed % for custom slider display ─────────────────────────────────
  const cpuFanPercent = displayedCpuFanTarget ?? (activeFanProfile === 'max' ? 100 : activeFanProfile === 'auto' ? 45 : customCpuSpeed)
  const gpuFanPercent = displayedGpuFanTarget ?? (activeFanProfile === 'max' ? 100 : activeFanProfile === 'auto' ? 45 : customGpuSpeed)

  // Fan dial spin speed
  const fanSpinClass = activeFanProfile === 'max' ? 'is-fast' : activeFanProfile === 'auto' ? '' : (customCpuSpeed > 70 ? 'is-fast' : '')

  // RPM values
  const cpuRpm = displayedCpuFanRpm ?? (activeFanProfile === 'max' ? 4950 : activeFanProfile === 'auto' ? 2173 : Math.round(customCpuSpeed * 45))
  const gpuRpm = displayedGpuFanRpm ?? (activeFanProfile === 'max' ? 5110 : activeFanProfile === 'auto' ? 2542 : Math.round(customGpuSpeed * 50))

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="ns-shell">
      {/* ── Title Bar ─────────────────────────────────────────────────────── */}
      <header className="ns-titlebar">
        <span className="ns-titlebar__acer">
          <span className="ns-titlebar__logo-dot" />
          acer
        </span>

        <div className="ns-titlebar__wordmark">
          NITRO<span>SENSE</span>
        </div>

        <div className="ns-titlebar__actions">
          {/* Settings icon */}
          <button className="ns-titlebar__icon-btn" title="Settings" aria-label="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          <span className="ns-titlebar__win-sep" />

          {/* Minimize */}
          <button className="ns-titlebar__icon-btn" title="Minimize" aria-label="Minimize" onClick={handleMinimize}>
            <svg width="12" height="2" viewBox="0 0 12 2" fill="currentColor">
              <rect width="12" height="2" />
            </svg>
          </button>

          {/* Close */}
          <button className="ns-titlebar__icon-btn close" title="Close" aria-label="Close" onClick={handleClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
              <path d="M6 4.586L1.707.293.293 1.707 4.586 6 .293 10.293l1.414 1.414L6 7.414l4.293 4.293 1.414-1.414L7.414 6l4.293-4.293L10.293.293 6 4.586z" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div className="ns-body">

        {/* ── Fan Control ─────────────────────────────────────────────────── */}
        <div className="ns-fan-section">
          <span className="ns-fan-section__label">Fan Control</span>

          {/* Mode buttons */}
          <div className="ns-fan-modes">
            {([
              { id: 'auto',   label: 'Auto' },
              { id: 'max',    label: 'Max' },
              { id: 'custom', label: 'Custom' },
            ] as { id: FanProfileId; label: string }[]).map(mode => (
              <button
                key={mode.id}
                className={`ns-fan-mode-btn${activeFanProfile === mode.id ? ' is-active' : ''}`}
                onClick={() => void handleFanProfile(mode.id)}
                aria-pressed={activeFanProfile === mode.id}
              >
                <FanModeIcon active={activeFanProfile === mode.id} />
                {mode.label}
              </button>
            ))}
          </div>

          {/* Custom sliders (only shown in custom mode) */}
          {activeFanProfile === 'custom' && (
            <div className="ns-custom-sliders">
              <div className="ns-custom-slider-row">
                <span>CPU</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={customCpuSpeed}
                  className="ns-custom-slider"
                  onChange={e => setCustomCpuSpeed(Number(e.target.value))}
                />
                <button className="ns-auto-btn" onClick={() => void handleFanProfile('auto')}>Auto</button>
              </div>
              <div className="ns-custom-slider-row">
                <span>GPU</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={customGpuSpeed}
                  className="ns-custom-slider"
                  onChange={e => setCustomGpuSpeed(Number(e.target.value))}
                />
                <button className="ns-auto-btn" onClick={() => void handleFanProfile('auto')}>Auto</button>
              </div>
            </div>
          )}

          {/* Fan dials */}
          <div className="ns-fan-dials">
            {/* CPU fan */}
            <div className="ns-dial-group">
              <span className="ns-dial-label">CPU</span>
              <div className="ns-dial">
                <div className="ns-dial__blade-ring">
                  <div className={`ns-dial__blades ${fanSpinClass}`}>
                    <FanBladeSVG size={110} active={activeFanProfile !== 'auto' || cpuRpm > 0} />
                  </div>
                </div>
                <div className="ns-dial__inner">
                  <span className="ns-dial__rpm">{cpuRpm > 0 ? cpuRpm.toLocaleString() : '--'}</span>
                  <span className="ns-dial__unit">RPM</span>
                </div>
              </div>
            </div>

            <div className="ns-fan-divider" />

            {/* GPU fan */}
            <div className="ns-dial-group">
              <div className="ns-dial">
                <div className="ns-dial__blade-ring">
                  <div className={`ns-dial__blades ${fanSpinClass}`}>
                    <FanBladeSVG size={110} active={activeFanProfile !== 'auto' || gpuRpm > 0} />
                  </div>
                </div>
                <div className="ns-dial__inner">
                  <span className="ns-dial__rpm">{gpuRpm > 0 ? gpuRpm.toLocaleString() : '--'}</span>
                  <span className="ns-dial__unit">RPM</span>
                </div>
              </div>
              <span className="ns-dial-label">GPU</span>
            </div>
          </div>

          {/* CoolBoost */}
          <CoolBoostToggle
            enabled={coolBoostEnabled}
            onChange={handleCoolBoost}
          />
        </div>

        {/* ── Bottom row ──────────────────────────────────────────────────── */}
        <div className="ns-bottom">

          {/* Power Plan panel */}
          <div className="ns-power-panel">
            <div className="ns-power-panel__title">Power Plan</div>
            <div className="ns-power-panel__mode-label">Mode</div>

            {/* AC / Battery tabs */}
            <div className="ns-ac-tabs">
              <button
                className={`ns-ac-tab${acMode === 'ac' ? ' is-active' : ''}`}
                onClick={() => setAcMode('ac')}
              >
                AC
              </button>
              <button
                className={`ns-ac-tab${acMode === 'battery' ? ' is-active' : ''}`}
                onClick={() => setAcMode('battery')}
              >
                Battery
              </button>
            </div>

            {/* Power plan list */}
            <div className="ns-power-list">
              {NITRO_POWER_PLANS.map(plan => (
                <button
                  key={plan.id}
                  className={`ns-power-item${activePowerProfile === plan.id ? ' is-active' : ''}`}
                  onClick={() => void handlePowerProfile(plan.id)}
                  aria-pressed={activePowerProfile === plan.id}
                >
                  {plan.label.split('\n').map((line, i) => (
                    <span key={i} style={i > 0 ? { display: 'block', fontSize: 11, opacity: 0.8 } : undefined}>{line}</span>
                  ))}
                </button>
              ))}
            </div>
          </div>

          {/* Monitoring panel */}
          <div className="ns-monitoring">
            <div className="ns-monitoring__title">Monitoring</div>
            <div className="ns-monitoring__subheader">
              <span className="ns-monitoring__axis-label">Temperature (°C) / Loading (%)</span>
            </div>

            <ChartRow
              label="CPU"
              tempHistory={cpuTempHistory}
              loadHistory={cpuLoadHistory}
              currentTemp={displayedCpuTemp}
              currentLoad={displayedCpuUsage}
              minTemp={cpuMinTemp}
              maxTemp={cpuMaxTemp}
            />

            <ChartRow
              label="GPU"
              tempHistory={gpuTempHistory}
              loadHistory={gpuLoadHistory}
              currentTemp={displayedGpuTemp}
              currentLoad={displayedGpuUsage}
              minTemp={gpuMinTemp}
              maxTemp={gpuMaxTemp}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
