/**
 * NitroSense UI — pixel-accurate replica of the Acer NitroSense interface
 * All Tauri backend calls (fan / power apply) are wired through original handlers.
 */

import { useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './NitroApp.css'
import {
  applyCustomFanCurves,
  applyFanProfile,
  applyPowerProfile,
  getBackendBootstrap,
  getBackendPollSnapshot,
  saveControlSnapshot,
  type CapabilitySnapshot,
  type ControlSnapshot,
  type BootArtId,
  type CustomPowerBaseId,
  type GpuTuningState,
  type LiveControlSnapshot,
  type TelemetrySnapshot,
} from './lib/backend'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
type FanProfileId   = 'auto' | 'max' | 'custom'
type PowerProfileId = 'battery-guard' | 'balanced' | 'performance' | 'turbo' | 'custom'
type UpdateChannel  = 'stable' | 'preview'
type CurvePoint     = { temp: number; speed: number }
type CurveSet       = { cpu: CurvePoint[]; gpu: CurvePoint[] }


// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────
const POLL_MS        = 1000
const HIDDEN_POLL_MS = 5000
const FAN_TIMEOUT_MS = 15_000
const GRAPH_LEN      = 140      // number of history samples

const POWER_PLANS: { id: PowerProfileId; label: string }[] = [
  { id: 'battery-guard', label: 'Power Saver' },
  { id: 'balanced',      label: 'Balance' },
  { id: 'performance',   label: 'Balance\n[Acer Optimized]' },
  { id: 'turbo',         label: 'High-Performance' },
]

const DEFAULT_CURVES: CurveSet = {
  cpu: [{ temp: 30, speed: 2 }, { temp: 49, speed: 2 }, { temp: 65, speed: 22 }, { temp: 74, speed: 64 }, { temp: 80, speed: 100 }],
  gpu: [{ temp: 30, speed: 2 }, { temp: 49, speed: 2 }, { temp: 65, speed: 22 }, { temp: 74, speed: 64 }, { temp: 80, speed: 100 }],
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function isDesktopRuntime() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__)
}

function clamp(v: number, lo: number, hi: number) { return Math.min(hi, Math.max(lo, v)) }

function describeError(e: unknown) {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try { return JSON.stringify(e) } catch { return 'Unknown error' }
}

function waitPaint() {
  return new Promise<void>(r => {
    if (!window.requestAnimationFrame) { setTimeout(r, 0); return }
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let tid: number | null = null
  const t = new Promise<T>((_, rej) => {
    tid = window.setTimeout(() => rej(new Error(`${label} timed out`)), ms)
  })
  return Promise.race([p, t]).finally(() => { if (tid) clearTimeout(tid) })
}

function presentPos(v: number | null | undefined) { return v != null && v > 0 ? v : null }

function hasUsableTelemetry(s: TelemetrySnapshot | null | undefined) {
  return Boolean(s && (s.cpuTempC > 0 || s.gpuTempC > 0 || s.cpuFanRpm > 0 || s.gpuFanRpm > 0))
}

function fromBackendCurves(c: ControlSnapshot['fanCurves']): CurveSet {
  return {
    cpu: c.cpu.map(p => ({ temp: p.tempC, speed: p.speedPercent })),
    gpu: c.gpu.map(p => ({ temp: p.tempC, speed: p.speedPercent })),
  }
}

function toBackendCurves(c: CurveSet): ControlSnapshot['fanCurves'] {
  return {
    cpu: c.cpu.map(p => ({ tempC: p.temp, speedPercent: p.speed })),
    gpu: c.gpu.map(p => ({ tempC: p.temp, speedPercent: p.speed })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Canvas graph — matches NitroSense spike/waveform style
// ─────────────────────────────────────────────────────────────────────────────
function drawGraph(canvas: HTMLCanvasElement, tempHist: number[], loadHist: number[]) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)

  // Dark background
  ctx.fillStyle = '#0f0f0f'
  ctx.fillRect(0, 0, W, H)

  // Subtle vertical grid lines
  ctx.strokeStyle = 'rgba(255,60,0,0.07)'
  ctx.lineWidth = 1
  for (let i = 1; i < 8; i++) {
    const x = Math.round((W / 8) * i)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
  }

  const N = tempHist.length
  if (N < 2) return

  // Step per sample
  const step = W / (GRAPH_LEN - 1)

  // — Draw load % as filled area (dark orange, behind) —
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    const x = (i + (GRAPH_LEN - N)) * step
    const y = H - clamp(loadHist[i] / 100, 0, 1) * H
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.lineTo((GRAPH_LEN - 1) * step, H)
  ctx.lineTo((GRAPH_LEN - N) * step, H)
  ctx.closePath()
  const loadGrad = ctx.createLinearGradient(0, 0, 0, H)
  loadGrad.addColorStop(0, 'rgba(200,70,0,0.55)')
  loadGrad.addColorStop(1, 'rgba(100,20,0,0.2)')
  ctx.fillStyle = loadGrad
  ctx.fill()

  // — Draw temp spikes as individual vertical lines (NitroSense "spike" look) —
  // First draw dense spike lines
  for (let i = 0; i < N; i++) {
    const x = Math.round((i + (GRAPH_LEN - N)) * step)
    const normTemp = clamp((tempHist[i] - 20) / 80, 0, 1)   // 20°=0%, 100°=100%
    const spikeH = normTemp * H

    // Spike line: gradient from bottom
    const spkGrad = ctx.createLinearGradient(0, H, 0, H - spikeH)
    spkGrad.addColorStop(0, 'rgba(220,80,0,0.0)')
    spkGrad.addColorStop(0.4, 'rgba(230,100,0,0.4)')
    spkGrad.addColorStop(1, 'rgba(255,130,20,0.9)')
    ctx.strokeStyle = spkGrad
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, H)
    ctx.lineTo(x, H - spikeH)
    ctx.stroke()
  }

  // — Draw temperature as smooth line on top —
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    const x = (i + (GRAPH_LEN - N)) * step
    const normTemp = clamp((tempHist[i] - 20) / 80, 0, 1)
    const y = H - normTemp * H
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = 'rgba(255,160,40,0.85)'
  ctx.lineWidth = 1.5
  ctx.stroke()

  // thin bright highlight on top of temp line
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    const x = (i + (GRAPH_LEN - N)) * step
    const normTemp = clamp((tempHist[i] - 20) / 80, 0, 1)
    const y = H - normTemp * H
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = 'rgba(255,210,120,0.6)'
  ctx.lineWidth = 0.7
  ctx.stroke()
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan blade SVG — matches the NitroSense fan ring aesthetic
// ─────────────────────────────────────────────────────────────────────────────
function FanRingSVG({ active, fast }: { active: boolean; fast?: boolean }) {
  const cx = 65, cy = 65, R = 63, innerR = 22
  const bladeCount = 7
  const toothCount = 54    // outer teeth ring

  // Outer serrated ring — many small "tooth" segments
  const teeth: string[] = []
  for (let i = 0; i < toothCount; i++) {
    const a1 = ((i * 2 * Math.PI) / toothCount) - Math.PI / toothCount
    const a2 = ((i * 2 * Math.PI) / toothCount) + Math.PI / toothCount
    const outerR = R
    const innerT = R - (i % 2 === 0 ? 4 : 6)
    const x1 = cx + Math.cos(a1) * outerR, y1 = cy + Math.sin(a1) * outerR
    const x2 = cx + Math.cos(a2) * outerR, y2 = cy + Math.sin(a2) * outerR
    const x3 = cx + Math.cos(a2) * innerT, y3 = cy + Math.sin(a2) * innerT
    const x4 = cx + Math.cos(a1) * innerT, y4 = cy + Math.sin(a1) * innerT
    teeth.push(`M${x1},${y1} L${x2},${y2} L${x3},${y3} L${x4},${y4}Z`)
  }

  // Fan blades — swept curved shapes
  const blades: { d: string; key: number }[] = []
  for (let i = 0; i < bladeCount; i++) {
    const baseAngle = (i / bladeCount) * 2 * Math.PI
    const sweepAngle = 0.65   // radians of sweep
    const tipAngle  = baseAngle + sweepAngle
    const midAngle  = baseAngle + sweepAngle * 0.5

    const innerEdge = innerR + 2
    const outerEdge = R - 10

    const sx = cx + Math.cos(baseAngle) * innerEdge
    const sy = cy + Math.sin(baseAngle) * innerEdge
    const tx = cx + Math.cos(tipAngle) * (outerEdge * 0.8)
    const ty = cy + Math.sin(tipAngle) * (outerEdge * 0.8)
    const c1x = cx + Math.cos(midAngle) * (outerEdge * 0.55)
    const c1y = cy + Math.sin(midAngle) * (outerEdge * 0.55)
    const c2x = cx + Math.cos(tipAngle - 0.18) * (outerEdge * 0.7)
    const c2y = cy + Math.sin(tipAngle - 0.18) * (outerEdge * 0.7)

    // Wide blade (main shape)
    const wb = baseAngle - 0.18
    const wx = cx + Math.cos(wb) * innerEdge
    const wy = cy + Math.sin(wb) * innerEdge
    blades.push({
      key: i,
      d: `M${cx},${cy} L${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty} L${wx},${wy}Z`,
    })
  }

  const bladeColor   = active ? '#2a1008' : '#222'
  const bladeBorder  = active ? 'rgba(232,74,26,0.25)' : 'rgba(255,255,255,0.1)'
  const toothColor   = active ? 'rgba(200,60,10,0.5)' : 'rgba(255,255,255,0.07)'
  const toothBright  = active ? 'rgba(255,100,30,0.7)' : 'rgba(255,255,255,0.18)'

  return (
    <svg viewBox="0 0 130 130" width={130} height={130}>
      {/* Background disc */}
      <circle cx={cx} cy={cy} r={R - 1} fill="#111" />

      {/* Teeth ring */}
      {teeth.map((d, i) => (
        <path key={i} d={d} fill={i % 2 === 0 ? toothBright : toothColor} />
      ))}

      {/* Blade fill */}
      {blades.map(b => (
        <path key={b.key} d={b.d} fill={bladeColor} stroke={bladeBorder} strokeWidth="0.7" />
      ))}

      {/* Center hub */}
      <circle cx={cx} cy={cy} r={innerR}
        fill={active ? '#1a0805' : '#1a1a1a'}
        stroke={active ? 'rgba(232,74,26,0.4)' : 'rgba(255,255,255,0.08)'}
        strokeWidth="1.5" />

      {/* Center dot */}
      <circle cx={cx} cy={cy} r={5}
        fill={active ? 'rgba(232,74,26,0.7)' : '#333'} />

      {/* Outer glow ring when active */}
      {active && (
        <>
          <circle cx={cx} cy={cy} r={R - 1} fill="none"
            stroke="rgba(232,74,26,0.18)" strokeWidth="3" />
          <circle cx={cx} cy={cy} r={R + 1} fill="none"
            stroke="rgba(232,74,26,0.08)" strokeWidth="2" />
        </>
      )}
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan mode icon (small, for sidebar buttons)
// ─────────────────────────────────────────────────────────────────────────────
function FanModeIcon({ active }: { active: boolean }) {
  const cx = 14, cy = 14, R = 12
  const blades = 6
  const bladeColor = active ? '#e84a1a' : '#4a4a4a'
  const paths: string[] = []
  for (let i = 0; i < blades; i++) {
    const a  = (i / blades) * 2 * Math.PI
    const a2 = a + 0.55
    const am = a + 0.28
    const s = { x: cx + Math.cos(a) * 4, y: cy + Math.sin(a) * 4 }
    const t = { x: cx + Math.cos(a2) * 10, y: cy + Math.sin(a2) * 10 }
    const c = { x: cx + Math.cos(am) * 8, y: cy + Math.sin(am) * 8 }
    paths.push(`M${cx},${cy} L${s.x},${s.y} Q${c.x},${c.y} ${t.x},${t.y}Z`)
  }
  return (
    <svg viewBox="0 0 28 28" width={28} height={28} className="ns-mode-icon">
      <circle cx={cx} cy={cy} r={R} fill="none"
        stroke={active ? 'rgba(232,74,26,0.5)' : '#333'} strokeWidth="1.2" />
      {paths.map((d, i) => <path key={i} d={d} fill={bladeColor} opacity={0.85} />)}
      <circle cx={cx} cy={cy} r={3} fill={active ? '#e84a1a' : '#333'} />
    </svg>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Chart Row component
// ─────────────────────────────────────────────────────────────────────────────
function ChartRow({
  label, tempHist, loadHist, currentTemp, currentLoad, minT, maxT,
}: {
  label: string
  tempHist: number[]
  loadHist: number[]
  currentTemp: number | null
  currentLoad: number | null
  minT: number
  maxT: number
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef   = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const wrap   = wrapRef.current
    if (!canvas || !wrap) return
    const dpr = window.devicePixelRatio || 1
    const { width: w, height: h } = wrap.getBoundingClientRect()
    canvas.width  = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    const ctx = canvas.getContext('2d')
    ctx?.scale(dpr, dpr)
    drawGraph(canvas, tempHist, loadHist)
  }, [tempHist, loadHist])

  return (
    <div className="ns-chart-row">
      <div className="ns-chart-subheader">
        <span className="ns-chart-minmax">
          {minT > 0 ? `Min : ${minT}°  Max : ${maxT}°` : '\u00a0'}
        </span>
      </div>
      <div className="ns-chart-body">
        <div className="ns-chart-wrap" ref={wrapRef}>
          <span className="ns-chart-inline-label">{label}</span>
          <canvas className="ns-chart-canvas" ref={canvasRef} />
        </div>
        <div className="ns-chart-readouts">
          <span className="ns-chart-temp">{currentTemp != null ? `${currentTemp}°` : '--°'}</span>
          <span className="ns-chart-load">{currentLoad != null ? `${currentLoad} %` : '--'}</span>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main App
// ─────────────────────────────────────────────────────────────────────────────
export default function NitroApp() {

  // ── UI state ──────────────────────────────────────────────────────────────
  const [fanProfile,   setFanProfile]   = useState<FanProfileId>('auto')
  const [powerProfile, setPowerProfile] = useState<PowerProfileId>('battery-guard')
  const [acMode,       setAcMode]       = useState<'ac' | 'battery'>('ac')
  const [coolBoost,    setCoolBoost]    = useState(false)
  const [cpuSlider,    setCpuSlider]    = useState(50)
  const [gpuSlider,    setGpuSlider]    = useState(50)
  const [statusMsg,    setStatusMsg]    = useState('')

  // ── Backend / telemetry state ─────────────────────────────────────────────
  const [liveTelemetry,      setLiveTelemetry]      = useState<TelemetrySnapshot | null>(null)
  const [liveControls,       setLiveControls]       = useState<LiveControlSnapshot | null>(null)
  const [serviceConnected,   setServiceConnected]   = useState(false)
  const [capabilities,       setCapabilities]       = useState<CapabilitySnapshot | null>(null)

  // ── Monitoring history ────────────────────────────────────────────────────
  const [cpuTempH, setCpuTempH] = useState<number[]>([])
  const [cpuLoadH, setCpuLoadH] = useState<number[]>([])
  const [gpuTempH, setGpuTempH] = useState<number[]>([])
  const [gpuLoadH, setGpuLoadH] = useState<number[]>([])
  const [cpuMin, setCpuMin] = useState(0)
  const [cpuMax, setCpuMax] = useState(0)
  const [gpuMin, setGpuMin] = useState(0)
  const [gpuMax, setGpuMax] = useState(0)

  // ── Persistence state (kept for backend save calls) ───────────────────────
  const [customCurves, setCustomCurves]               = useState<CurveSet>(DEFAULT_CURVES)
  const [customPowerBase, setCustomPowerBase]         = useState<CustomPowerBaseId>('performance')
  const [customProcessorState, setCustomProcessorState] = useState({ min: 35, max: 88 })
  const [gpuTuning, setGpuTuning]                     = useState<GpuTuningState>({ coreClockMhz: 165, memoryClockMhz: 420, voltageOffsetMv: -35, powerLimitPercent: 114, tempLimitC: 83 })
  const [fanSyncLock, setFanSyncLock]                 = useState(false)
  const [smartCharging, setSmartCharging]             = useState(true)
  const [processorCtrl, setProcessorCtrl]             = useState(true)
  const [nvidiaTelemetry, setNvidiaTelemetry]         = useState(true)
  const [keepWarmed, setKeepWarmed]                   = useState(false)
  const [usbPower, setUsbPower]                       = useState(true)
  const [blueLightFilter, setBlueLightFilter]         = useState(false)
  const [autoRefreshBattery, setAutoRefreshBattery]   = useState(false)
  const [autoRefreshHz, setAutoRefreshHz]             = useState<number | null>(null)
  const [bootArt, setBootArt]                         = useState('ember')
  const [bootFile, setBootFile]                       = useState('custom-boot.png')
  const [updateCh, setUpdateCh]                       = useState<UpdateChannel>('stable')
  const [updateOnLaunch, setUpdateOnLaunch]           = useState(true)
  const [activeOcSlot, setActiveOcSlot]               = useState('daily')
  const [ocApplyState, setOcApplyState]               = useState<'staged' | 'live'>('live')
  const [ocLocked, setOcLocked]                       = useState(false)

  // ── Refs (don't trigger re-renders) ──────────────────────────────────────
  const svcRef       = useRef(false)
  const fanApplyRef  = useRef(false)
  const pwrApplyRef  = useRef(false)
  const ctrlCount    = useRef(0)
  const qFanRef      = useRef<FanProfileId | null>(null)
  const qPwrRef      = useRef<PowerProfileId | null>(null)
  const curvesRef    = useRef<CurveSet>(DEFAULT_CURVES)
  const telRef       = useRef<string | null>(null)
  const liveRef      = useRef<string | null>(null)
  const liveObjRef   = useRef<LiveControlSnapshot | null>(null)
  const pollRef      = useRef(false)

  // ── Derive displayed values ───────────────────────────────────────────────
  const tel          = hasUsableTelemetry(liveTelemetry) ? liveTelemetry : null
  const displayCpuT  = presentPos(tel?.cpuTempAverageC ?? tel?.cpuTempC ?? null)
  const displayGpuT  = presentPos(tel?.gpuTempC ?? null)
  const displayCpuU  = tel?.cpuUsagePercent ?? null
  const displayGpuU  = tel?.gpuUsagePercent ?? null
  const displayCpuRpm = presentPos(tel?.cpuFanRpm ?? null)
  const displayGpuRpm = presentPos(tel?.gpuFanRpm ?? null)
  const cpuFanTarget  = liveControls?.currentCpuFanSpeedPercent ?? null
  const gpuFanTarget  = liveControls?.currentGpuFanSpeedPercent ?? null

  // RPM to display in dial (live > simulated)
  const cpuRpm = displayCpuRpm ?? (fanProfile === 'max' ? 4950 : fanProfile === 'auto' ? 2173 : Math.round(cpuSlider * 48))
  const gpuRpm = displayGpuRpm ?? (fanProfile === 'max' ? 5110 : fanProfile === 'auto' ? 2542 : Math.round(gpuSlider * 52))
  const dialFast    = fanProfile === 'max' || coolBoost
  const dialActive  = fanProfile !== 'auto' || (displayCpuRpm ?? 0) > 500

  // ── Update monitoring history from live telemetry ─────────────────────────
  useEffect(() => {
    if (!tel) return
    const ct = tel.cpuTempAverageC ?? tel.cpuTempC ?? 0
    const gt = tel.gpuTempC ?? 0
    const cl = tel.cpuUsagePercent ?? 0
    const gl = tel.gpuUsagePercent ?? 0

    setCpuTempH(h => [...h, ct].slice(-GRAPH_LEN))
    setCpuLoadH(h => [...h, cl].slice(-GRAPH_LEN))
    setGpuTempH(h => [...h, gt].slice(-GRAPH_LEN))
    setGpuLoadH(h => [...h, gl].slice(-GRAPH_LEN))
    setCpuMin(p => p === 0 ? Math.round(ct) : Math.min(p, Math.round(ct)))
    setCpuMax(p => Math.max(p, Math.round(ct)))
    setGpuMin(p => p === 0 ? Math.round(gt) : Math.min(p, Math.round(gt)))
    setGpuMax(p => Math.max(p, Math.round(gt)))
  }, [tel])

  // ── Serialized state helper ───────────────────────────────────────────────
  function updateSerial<T>(ref: { current: string | null }, val: T | null, set: (v: T | null) => void) {
    const s = val == null ? null : JSON.stringify(val)
    if (ref.current === s) return
    ref.current = s; set(val)
  }

  // ── Apply control snapshot from backend ──────────────────────────────────
  function applySnap(controls: ControlSnapshot, live?: LiveControlSnapshot | null) {
    setFanProfile(controls.activeFanProfile)
    setPowerProfile(controls.activePowerProfile)
    setCustomCurves(fromBackendCurves(controls.fanCurves))
    curvesRef.current = fromBackendCurves(controls.fanCurves)
    setCustomPowerBase(controls.customPowerBase)
    setCustomProcessorState({ min: controls.customProcessorState.minPercent, max: controls.customProcessorState.maxPercent })
    setGpuTuning(controls.gpuTuning)
    setFanSyncLock(controls.fanSyncLockEnabled)
    setSmartCharging(controls.personalSettings.smartChargingEnabled)
    setProcessorCtrl(controls.personalSettings.processorStateControlEnabled)
    setNvidiaTelemetry(controls.personalSettings.nvidiaTelemetryEnabled ?? true)
    setKeepWarmed(controls.personalSettings.keepUiPrewarmed ?? false)
    setUsbPower(controls.personalSettings.usbPowerEnabled)
    setBlueLightFilter(controls.personalSettings.blueLightFilterEnabled)
    setAutoRefreshBattery(controls.personalSettings.autoRefreshRateOnBatteryEnabled)
    setAutoRefreshHz(controls.personalSettings.autoRefreshRateRestoreHz)
    setBootArt(controls.personalSettings.selectedBootArt)
    setBootFile(controls.personalSettings.customBootFilename)
    setUpdateOnLaunch(controls.personalSettings.checkForUpdatesOnLaunch)
    setActiveOcSlot(controls.activeOcSlot)
    setOcApplyState(controls.ocApplyState)
    setOcLocked(controls.ocTuningLocked)
    if (live !== undefined) {
      liveObjRef.current = live
      setLiveControls(live)
    }
  }

  // ── Persist (save) controls to backend ───────────────────────────────────
  async function persist(overrides: Partial<{
    activeFanProfile: FanProfileId
    activePowerProfile: PowerProfileId
  }> = {}) {
    try {
      await saveControlSnapshot({
        activePowerProfile:   overrides.activePowerProfile ?? powerProfile,
        activeFanProfile:     overrides.activeFanProfile   ?? fanProfile,
        customProcessorState: { minPercent: customProcessorState.min, maxPercent: customProcessorState.max },
        customPowerBase,
        gpuTuning,
        ocPresets: [],
        activeOcSlot,
        ocApplyState,
        ocTuningLocked: ocLocked,
        fanCurves:      toBackendCurves(curvesRef.current),
        fanSyncLockEnabled: fanSyncLock,
        personalSettings: {
          smartChargingEnabled:              smartCharging,
          usbPowerEnabled:                   usbPower,
          processorStateControlEnabled:      processorCtrl,
          nvidiaTelemetryEnabled:            nvidiaTelemetry,
          keepUiPrewarmed:                   keepWarmed,
          blueLightFilterEnabled:            blueLightFilter,
          autoRefreshRateOnBatteryEnabled:   autoRefreshBattery,
          autoRefreshRateRestoreHz:          autoRefreshHz,
          selectedBootArt:                   bootArt as BootArtId,
          customBootFilename:                bootFile,
          updateChannel:                     updateCh,
          checkForUpdatesOnLaunch:           updateOnLaunch,
        },
      })
    } catch { /* non-fatal */ }
  }

  // ── Bootstrap + polling ───────────────────────────────────────────────────
  useEffect(() => {
    const isTauri = isDesktopRuntime()
    let cancelled = false

    if (isTauri) {
      // Bootstrap
      void (async () => {
        try {
          const bs = await getBackendBootstrap()
          if (cancelled) return
          setCapabilities(bs.capabilities)
          setServiceConnected(bs.service.connected)
          svcRef.current = bs.service.connected
          applySnap(bs.controls, bs.liveControls)
          if (bs.telemetry) updateSerial(telRef, bs.telemetry, setLiveTelemetry)
        } catch (e) { console.error('Bootstrap failed:', describeError(e)) }
      })()

      // Poll
      let pollTimer = 0
      async function poll() {
        if (pollRef.current || ctrlCount.current > 0) return
        pollRef.current = true
        try {
          const snap = await getBackendPollSnapshot()
          if (cancelled) return
          setServiceConnected(snap.service.connected)
          svcRef.current = snap.service.connected
          updateSerial(telRef, snap.telemetry, setLiveTelemetry)
          updateSerial(liveRef, snap.liveControls, (v) => {
            liveObjRef.current = v
            setLiveControls(v)
          })
        } catch { /* ignore */ } finally { pollRef.current = false }
      }

      const schedPoll = () => {
        pollTimer = window.setTimeout(() => {
          void poll().finally(() => { if (!cancelled) schedPoll() })
        }, document.visibilityState === 'hidden' ? HIDDEN_POLL_MS : POLL_MS)
      }

      const onVis = () => { if (document.visibilityState === 'visible') { clearTimeout(pollTimer); void poll().finally(() => { if (!cancelled) schedPoll() }) } }
      document.addEventListener('visibilitychange', onVis)
      schedPoll()

      return () => { cancelled = true; clearTimeout(pollTimer); document.removeEventListener('visibilitychange', onVis) }
    } else {
      // ── Browser preview: animated simulation ──────────────────────────────
      let frame = 0
      const baseC = 47, baseG = 45

      // pre-fill initial history
      const iCT = Array.from({ length: GRAPH_LEN }, (_, i) => baseC + Math.sin(i * 0.15) * 9 + Math.random() * 5)
      const iCL = Array.from({ length: GRAPH_LEN }, (_, i) => 36 + Math.sin(i * 0.12) * 25 + Math.random() * 10)
      const iGT = Array.from({ length: GRAPH_LEN }, (_, i) => baseG + Math.sin(i * 0.10) * 7 + Math.random() * 4)
      const iGL = Array.from({ length: GRAPH_LEN }, (_, i) => 22 + Math.sin(i * 0.09) * 18 + Math.random() * 8)
      setCpuTempH(iCT); setCpuLoadH(iCL); setGpuTempH(iGT); setGpuLoadH(iGL)
      setCpuMin(36); setCpuMax(91); setGpuMin(35); setGpuMax(74)

      const tid = window.setInterval(() => {
        frame++
        const ct = baseC + Math.sin(frame * 0.08) * 10 + Math.random() * 6
        const gt = baseG + Math.sin(frame * 0.06) * 8 + Math.random() * 5
        const cl = 38 + Math.sin(frame * 0.10) * 28 + Math.random() * 12
        const gl = 24 + Math.sin(frame * 0.07) * 22 + Math.random() * 10
        const cr = 2173 + Math.round(Math.sin(frame * 0.05) * 200 + Math.random() * 60)
        const gr = 2542 + Math.round(Math.sin(frame * 0.04) * 250 + Math.random() * 80)

        setCpuTempH(h => [...h, ct].slice(-GRAPH_LEN))
        setCpuLoadH(h => [...h, cl].slice(-GRAPH_LEN))
        setGpuTempH(h => [...h, gt].slice(-GRAPH_LEN))
        setGpuLoadH(h => [...h, gl].slice(-GRAPH_LEN))
        setCpuMin(p => p === 0 ? Math.round(ct) : Math.min(p, Math.round(ct)))
        setCpuMax(p => Math.max(p, Math.round(ct)))
        setGpuMin(p => p === 0 ? Math.round(gt) : Math.min(p, Math.round(gt)))
        setGpuMax(p => Math.max(p, Math.round(gt)))

        setLiveTelemetry({
          cpuTempC: Math.round(ct), cpuTempAverageC: Math.round(ct),
          cpuTempLowestCoreC: Math.round(ct - 3), cpuTempHighestCoreC: Math.round(ct + 5),
          gpuTempC: Math.round(gt), systemTempC: Math.round((ct + gt) / 2),
          cpuUsagePercent: Math.round(cl), gpuUsagePercent: Math.round(gl),
          gpuMemoryUsagePercent: 38, gpuPowerDrawW: 65, gpuPowerLimitW: 80,
          gpuPowerDefaultLimitW: 80, gpuPowerMinLimitW: 20, gpuPowerMaxLimitW: 100,
          cpuPackagePowerW: 45, cpuPl1W: 45, cpuPl1Enabled: true, cpuPl2W: 65, cpuPl2Enabled: true,
          cpuPowerLimitLocked: false, cpuName: 'Core i7-12700H', cpuBrand: 'Intel',
          gpuName: 'RTX 3060 Laptop', gpuBrand: 'NVIDIA', systemVendor: 'Acer', systemModel: 'Nitro AN515-58',
          cpuClockMhz: 3200 + Math.round(Math.random() * 800), gpuClockMhz: 1500 + Math.round(Math.random() * 400),
          cpuFanRpm: cr, gpuFanRpm: gr, batteryPercent: 72, batteryLifeRemainingSec: null, acPluggedIn: true,
        })
      }, 1000)

      return () => clearInterval(tid)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Fan profile handler — actually calls Tauri ────────────────────────────
  async function handleFanProfile(id: FanProfileId) {
    setFanProfile(id)
    setStatusMsg(`Applying fan mode: ${id}…`)

    if (!svcRef.current) {
      await persist({ activeFanProfile: id })
      setStatusMsg(`Fan mode ${id} saved (service not connected).`)
      return
    }

    if (fanApplyRef.current) { qFanRef.current = id; return }
    fanApplyRef.current = true
    ctrlCount.current++
    try {
      await waitPaint()
      const req = id === 'custom'
        ? applyCustomFanCurves(toBackendCurves(curvesRef.current))
        : applyFanProfile(id)
      const result = await withTimeout(req, FAN_TIMEOUT_MS, `fan ${id}`)
      applySnap(result.controls)
      setStatusMsg(result.detail)
    } catch (e) {
      setFanProfile(fanProfile)
      setStatusMsg(`Fan apply failed: ${describeError(e)}`)
    } finally {
      fanApplyRef.current = false
      ctrlCount.current = Math.max(0, ctrlCount.current - 1)
      const q = qFanRef.current; qFanRef.current = null
      if (q && q !== id) void handleFanProfile(q)
    }
  }

  // ── Power profile handler — actually calls Tauri ──────────────────────────
  async function handlePowerProfile(id: PowerProfileId) {
    setPowerProfile(id)
    setStatusMsg(`Applying power plan: ${id}…`)

    const procState = id === 'battery-guard' ? { minPercent: 5, maxPercent: 45 }
      : id === 'balanced'    ? { minPercent: 35, maxPercent: 88 }
      : id === 'performance' ? { minPercent: 100, maxPercent: 100 }
      : id === 'turbo'       ? { minPercent: 100, maxPercent: 100 }
      : { minPercent: customProcessorState.min, maxPercent: customProcessorState.max }

    if (!svcRef.current) {
      await persist({ activePowerProfile: id })
      setStatusMsg(`Power plan ${id} saved (service not connected).`)
      return
    }

    if (pwrApplyRef.current) { qPwrRef.current = id; return }
    pwrApplyRef.current = true
    ctrlCount.current++
    try {
      await waitPaint()
      const result = await applyPowerProfile(id, procState, null, processorCtrl)
      applySnap(result)
      setStatusMsg(`Power plan applied: ${id}`)
    } catch (e) {
      setPowerProfile(powerProfile)
      setStatusMsg(`Power apply failed: ${describeError(e)}`)
    } finally {
      pwrApplyRef.current = false
      ctrlCount.current = Math.max(0, ctrlCount.current - 1)
      const q = qPwrRef.current; qPwrRef.current = null
      if (q && q !== id) void handlePowerProfile(q)
    }
  }

  // ── CoolBoost: maps to 'max' fan profile ─────────────────────────────────
  async function handleCoolBoost(enabled: boolean) {
    setCoolBoost(enabled)
    await handleFanProfile(enabled ? 'max' : 'auto')
  }

  // ── Window controls ───────────────────────────────────────────────────────
  async function handleMinimize() { if (isDesktopRuntime()) await getCurrentWindow().minimize() }
  async function handleClose()    { if (isDesktopRuntime()) await getCurrentWindow().close() }

  // ── Render ────────────────────────────────────────────────────────────────
  const fanSpinClass = dialFast ? 'fast' : ''

  return (
    <div className="ns-shell">

      {/* ── TITLE BAR ──────────────────────────────────────────────────────── */}
      <header className="ns-titlebar">
        {/* Acer wordmark */}
        <span className="ns-titlebar__acer">acer</span>

        {/* NITROSENSE centered */}
        <div className="ns-titlebar__center">
          <span className="ns-titlebar__wordmark">
            <span className="ns-titlebar__wordmark-nitro">NITRO</span>SENSE
          </span>
        </div>

        {/* Right icons */}
        <div className="ns-titlebar__right">
          {/* GeForce Experience placeholder */}
          <div className="ns-titlebar__gfe">
            <svg className="ns-titlebar__gfe-logo" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="3" fill="#76b900" />
              <text x="14" y="20" textAnchor="middle" fill="white" fontSize="13" fontWeight="bold">G</text>
            </svg>
            <span style={{ lineHeight: 1.1 }}>GEFORCE<br />EXPERIENCE</span>
          </div>

          {/* Keyboard icon */}
          <button className="ns-titlebar__icon-btn" title="Keyboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" strokeLinecap="round" />
            </svg>
          </button>

          {/* Sound wave icon */}
          <button className="ns-titlebar__icon-btn" title="Audio">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M2 10v4M6 7v10M10 4v16M14 7v10M18 10v4" strokeLinecap="round" />
            </svg>
          </button>

          {/* Settings gear */}
          <button className="ns-titlebar__icon-btn" title="Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" strokeLinecap="round" />
            </svg>
          </button>

          {/* Minimize */}
          <button className="ns-titlebar__icon-btn" title="Minimize" onClick={handleMinimize}>
            <svg width="14" height="2" viewBox="0 0 14 2"><rect width="14" height="2" fill="currentColor" /></svg>
          </button>

          {/* Close */}
          <button className="ns-titlebar__icon-btn ns-close" title="Close" onClick={handleClose}>
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path fill="currentColor" d="M6 4.586L1.707.293.293 1.707 4.586 6 .293 10.293l1.414 1.414L6 7.414l4.293 4.293 1.414-1.414L7.414 6l4.293-4.293L10.293.293 6 4.586z" />
            </svg>
          </button>
        </div>
      </header>

      {/* ── BODY ───────────────────────────────────────────────────────────── */}
      <div className="ns-body">

        {/* ── FAN CONTROL PANEL ──────────────────────────────────────────────*/}
        <div className="ns-fan-panel">
          <span className="ns-fan-panel__tab">Fan Control</span>

          {/* CoolBoost row top-right */}
          <div className="ns-coolboost-row">
            <span className="ns-coolboost-info" title="CoolBoost increases fan speed above the default maximum">ℹ</span>
            <span className="ns-coolboost-label">CoolBoost™</span>
            <label className="ns-toggle">
              <input
                type="checkbox"
                checked={coolBoost}
                onChange={e => void handleCoolBoost(e.target.checked)}
              />
              <span className="ns-toggle__track" />
            </label>
          </div>

          <div className="ns-fan-panel__inner">
            {/* Mode list */}
            <div className="ns-fan-modes">
              {([
                { id: 'auto',   label: 'Auto'   },
                { id: 'max',    label: 'Max'    },
                { id: 'custom', label: 'Custom' },
              ] as { id: FanProfileId; label: string }[]).map(m => (
                <button
                  key={m.id}
                  className={`ns-fan-mode-btn${fanProfile === m.id ? ' is-active' : ''}`}
                  onClick={() => void handleFanProfile(m.id)}
                >
                  <FanModeIcon active={fanProfile === m.id} />
                  {m.label}
                </button>
              ))}
            </div>

            {/* Dials */}
            <div className="ns-fan-dials-area">
              {/* CPU */}
              <div className="ns-dial-block">
                <span className="ns-dial-label left">CPU</span>
                <div className="ns-dial">
                  <div
                    className={`ns-dial__svg ${fanSpinClass}`}
                    style={{ animation: `ns-spin ${dialFast ? '1.2s' : '3.5s'} linear infinite` }}
                  >
                    <FanRingSVG active={dialActive} fast={dialFast} />
                  </div>
                  <div className="ns-dial__readout">
                    <span className="ns-dial__rpm-val">{cpuRpm.toLocaleString()}</span>
                    <span className="ns-dial__rpm-unit">RPM</span>
                  </div>
                </div>
              </div>

              <div className="ns-dial-sep" />

              {/* GPU */}
              <div className="ns-dial-block">
                <div className="ns-dial">
                  <div
                    className={`ns-dial__svg ${fanSpinClass}`}
                    style={{ animation: `ns-spin ${dialFast ? '1.2s' : '3.5s'} linear infinite` }}
                  >
                    <FanRingSVG active={dialActive} fast={dialFast} />
                  </div>
                  <div className="ns-dial__readout">
                    <span className="ns-dial__rpm-val">{gpuRpm.toLocaleString()}</span>
                    <span className="ns-dial__rpm-unit">RPM</span>
                  </div>
                </div>
                <span className="ns-dial-label right">GPU</span>
              </div>
            </div>
          </div>

          {/* Custom sliders */}
          {fanProfile === 'custom' && (
            <div className="ns-custom-sliders">
              <div className="ns-custom-row">
                <span>CPU</span>
                <input
                  type="range" min={0} max={100} value={cpuSlider}
                  className="ns-slider"
                  onChange={e => setCpuSlider(Number(e.target.value))}
                />
                <button className="ns-auto-lbl" onClick={() => void handleFanProfile('auto')}>Auto</button>
              </div>
              <div className="ns-custom-row">
                <span>GPU</span>
                <input
                  type="range" min={0} max={100} value={gpuSlider}
                  className="ns-slider"
                  onChange={e => setGpuSlider(Number(e.target.value))}
                />
                <button className="ns-auto-lbl" onClick={() => void handleFanProfile('auto')}>Auto</button>
              </div>
            </div>
          )}
        </div>

        {/* ── BOTTOM ROW ──────────────────────────────────────────────────── */}
        <div className="ns-bottom">

          {/* Power Plan */}
          <div className="ns-power-panel">
            <span className="ns-power-panel__tab">Power Plan</span>
            <div className="ns-power-panel__inner">
              <div className="ns-mode-label">Mode</div>

              <div className="ns-ac-tabs">
                <button
                  className={`ns-ac-tab${acMode === 'ac' ? ' is-active' : ''}`}
                  onClick={() => setAcMode('ac')}
                >AC</button>
                <button
                  className={`ns-ac-tab${acMode === 'battery' ? ' is-active' : ''}`}
                  onClick={() => setAcMode('battery')}
                >Battery</button>
              </div>

              <div className="ns-power-list">
                {POWER_PLANS.map(p => (
                  <button
                    key={p.id}
                    className={`ns-power-item${powerProfile === p.id ? ' is-active' : ''}`}
                    onClick={() => void handlePowerProfile(p.id)}
                  >
                    {p.label.split('\n').map((line, i) => (
                      <span key={i} style={i > 0 ? { display: 'block', fontSize: 11 } : undefined}>
                        {line}
                      </span>
                    ))}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Monitoring */}
          <div className="ns-monitoring">
            <span className="ns-monitoring__tab">Monitoring</span>
            <div className="ns-monitoring__inner">
              <div className="ns-monitoring__header">
                <span className="ns-monitoring__axis">Temperature (°C) / Loading (%)</span>
              </div>

              <ChartRow
                label="CPU"
                tempHist={cpuTempH}
                loadHist={cpuLoadH}
                currentTemp={displayCpuT}
                currentLoad={displayCpuU}
                minT={cpuMin}
                maxT={cpuMax}
              />
              <ChartRow
                label="GPU"
                tempHist={gpuTempH}
                loadHist={gpuLoadH}
                currentTemp={displayGpuT}
                currentLoad={displayGpuU}
                minT={gpuMin}
                maxT={gpuMax}
              />
            </div>
          </div>

        </div>{/* ns-bottom */}

        {/* Status bar (tiny, at very bottom) */}
        {statusMsg && (
          <div style={{ fontSize: 10, color: '#555', paddingTop: 2, paddingLeft: 4, flexShrink: 0 }}>
            {statusMsg}
          </div>
        )}
      </div>{/* ns-body */}
    </div>
  )
}
