/**
 * NITRO COOLER — Production UI
 * • Fan/power changes persist to disk via saveControlSnapshot
 * • Settings survive app close and restore on next launch via bootstrap
 * • Custom fan mode shows horizontal sliders with +/- controls
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import './NitroApp.css'
import {
  applyCustomFanCurves,
  applyFanProfile,
  applyPowerProfile,
  getBackendBootstrap,
  getBackendPollSnapshot,
  saveControlSnapshot,
  type BootArtId,
  type ControlSnapshot,
  type CustomPowerBaseId,
  type GpuTuningState,
  type LiveControlSnapshot,
  type TelemetrySnapshot,
} from './lib/backend'

// ─── Types ────────────────────────────────────────────────────────────────────
type FanProfile   = 'auto' | 'max' | 'custom'
type PowerProfile = 'battery-guard' | 'balanced' | 'performance' | 'turbo' | 'custom'
type AcMode       = 'ac' | 'battery'
type UpdateCh     = 'stable' | 'preview'
type Pt           = { temp: number; speed: number }
type Curves       = { cpu: Pt[]; gpu: Pt[] }

// ─── Constants ─────────────────────────────────────────────────────────────────
const POLL_MS  = 1000
const HIDPOLL  = 5000
const FAN_TO   = 15_000
const GLEN     = 140

const PLANS: { id: PowerProfile; label: string }[] = [
  { id: 'battery-guard', label: 'Power Saver' },
  { id: 'balanced',      label: 'Balance' },
  { id: 'performance',   label: 'Balance\n[Acer Optimized]' },
  { id: 'turbo',         label: 'High-Performance' },
]

const DEF_CURVES: Curves = {
  cpu: [{ temp:30,speed:2},{temp:49,speed:2},{temp:65,speed:22},{temp:74,speed:64},{temp:80,speed:100}],
  gpu: [{ temp:30,speed:2},{temp:49,speed:2},{temp:65,speed:22},{temp:74,speed:64},{temp:80,speed:100}],
}

// ─── Helpers ───────────────────────────────────────────────────────────────────
const isTauri = () => Boolean((window as any).__TAURI_INTERNALS__)
const clamp   = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const errMsg  = (e: unknown) => e instanceof Error ? e.message : String(e)

function waitPaint() {
  return new Promise<void>(res => {
    if (!window.requestAnimationFrame) { setTimeout(res, 0); return }
    requestAnimationFrame(() => requestAnimationFrame(() => res()))
  })
}

function withTo<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: number | null = null
  const to = new Promise<T>((_, rej) => { t = window.setTimeout(() => rej(new Error(`${label} timeout`)), ms) })
  return Promise.race([p, to]).finally(() => { if (t) clearTimeout(t) })
}

function hasData(s: TelemetrySnapshot | null | undefined) {
  return Boolean(s && (s.cpuTempC > 0 || s.cpuFanRpm > 0))
}

function fromCurves(c: ControlSnapshot['fanCurves']): Curves {
  return {
    cpu: c.cpu.map(p => ({ temp: p.tempC, speed: p.speedPercent })),
    gpu: c.gpu.map(p => ({ temp: p.tempC, speed: p.speedPercent })),
  }
}

function toCurves(c: Curves): ControlSnapshot['fanCurves'] {
  return {
    cpu: c.cpu.map(p => ({ tempC: p.temp, speedPercent: p.speed })),
    gpu: c.gpu.map(p => ({ tempC: p.temp, speedPercent: p.speed })),
  }
}

// ─── Fan Ring SVG ──────────────────────────────────────────────────────────────
function FanRing({ active, size = 138 }: { active: boolean; size?: number }) {
  const cx = size / 2, cy = size / 2
  const OR = size / 2 - 2    // outer
  const TR = OR - 11          // tooth inner
  const BR = OR - 14          // blade reach
  const HR = size * 0.10      // hub
  const N  = 58               // teeth
  const B  = 6                // blades
  const id = `fg${active ? 'a' : 'i'}${size}`

  // Teeth — arc segments
  const teeth: string[] = []
  const tf = 0.66
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2
    const a1 = a0 + (tf / N) * Math.PI * 2
    const x0o = cx + OR * Math.cos(a0), y0o = cy + OR * Math.sin(a0)
    const x1o = cx + OR * Math.cos(a1), y1o = cy + OR * Math.sin(a1)
    const x1i = cx + TR * Math.cos(a1), y1i = cy + TR * Math.sin(a1)
    const x0i = cx + TR * Math.cos(a0), y0i = cy + TR * Math.sin(a0)
    const la = tf / N > 0.5 ? 1 : 0
    teeth.push(`M${x0o},${y0o} A${OR},${OR} 0 ${la} 1 ${x1o},${y1o} L${x1i},${y1i} A${TR},${TR} 0 ${la} 0 ${x0i},${y0i}Z`)
  }

  // Blades — swept curved shapes
  const blades: string[] = []
  for (let i = 0; i < B; i++) {
    const base  = (i / B) * Math.PI * 2
    const sweep = 0.73
    const tip   = base + sweep
    const sx = cx + (HR + 2) * Math.cos(base), sy = cy + (HR + 2) * Math.sin(base)
    const tx = cx + (BR - 3) * Math.cos(tip),  ty = cy + (BR - 3) * Math.sin(tip)
    const m1 = base + sweep * 0.35, m2 = base + sweep * 0.70
    const c1x = cx + BR * 0.52 * Math.cos(m1), c1y = cy + BR * 0.52 * Math.sin(m1)
    const c2x = cx + BR * 0.83 * Math.cos(m2), c2y = cy + BR * 0.83 * Math.sin(m2)
    const te  = base - 0.14
    const tex = cx + (HR + 2) * Math.cos(te), tey = cy + (HR + 2) * Math.sin(te)
    const q1x = cx + BR * 0.44 * Math.cos(m1 - 0.08), q1y = cy + BR * 0.44 * Math.sin(m1 - 0.08)
    blades.push(`M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty} Q${q1x},${q1y} ${tex},${tey}Z`)
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} style={{ display: 'block' }}>
      <defs>
        <filter id={id} x="-25%" y="-25%" width="150%" height="150%">
          <feGaussianBlur stdDeviation={active ? '2.5' : '0'} result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        {active && (
          <radialGradient id={`rg${size}`} cx="50%" cy="50%" r="50%">
            <stop offset="0%"   stopColor="rgba(255,90,20,0.15)" />
            <stop offset="65%"  stopColor="rgba(200,55,0,0.07)" />
            <stop offset="100%" stopColor="rgba(0,0,0,0)" />
          </radialGradient>
        )}
      </defs>

      {/* Disc background */}
      <circle cx={cx} cy={cy} r={OR - 1} fill="#0d0d0d" />

      {/* Radial glow fill */}
      {active && <circle cx={cx} cy={cy} r={OR - 1} fill={`url(#rg${size})`} />}

      {/* Outer glow rings */}
      {active ? <>
        <circle cx={cx} cy={cy} r={OR - 2}  fill="none" stroke="rgba(225,75,10,0.6)"  strokeWidth="2.5" filter={`url(#${id})`} />
        <circle cx={cx} cy={cy} r={OR - 7}  fill="none" stroke="rgba(180,50,0,0.25)"  strokeWidth="5" />
        <circle cx={cx} cy={cy} r={TR}      fill="none" stroke="rgba(140,38,0,0.18)"  strokeWidth="3" />
      </> : <>
        <circle cx={cx} cy={cy} r={OR - 2} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1.5" />
      </>}

      {/* Teeth */}
      {teeth.map((d, i) => (
        <path key={i} d={d}
          fill={active
            ? (i % 2 === 0 ? 'rgba(255,105,25,0.88)' : 'rgba(205,65,10,0.68)')
            : (i % 2 === 0 ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.07)')}
          filter={active ? `url(#${id})` : undefined}
        />
      ))}

      {/* Blades */}
      {blades.map((d, i) => (
        <path key={i} d={d}
          fill={active ? '#2b0e04' : '#1c1c1c'}
          stroke={active ? 'rgba(255,90,20,0.38)' : 'rgba(255,255,255,0.07)'}
          strokeWidth="0.8"
        />
      ))}

      {/* Hub */}
      <circle cx={cx} cy={cy} r={HR}
        fill={active ? '#190905' : '#161616'}
        stroke={active ? 'rgba(255,80,20,0.58)' : 'rgba(255,255,255,0.08)'}
        strokeWidth="1.5"
        filter={active ? `url(#${id})` : undefined}
      />
      <circle cx={cx} cy={cy} r={4} fill={active ? '#e84a1a' : '#2a2a2a'} filter={active ? `url(#${id})` : undefined} />
    </svg>
  )
}

// ─── Fan Mode Icon ─────────────────────────────────────────────────────────────
function FanIcon({ on }: { on: boolean }) {
  const cx = 14, cy = 14
  const blades: string[] = []
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2
    const a2 = a + 0.54, am = a + 0.28
    const sx = cx + 4 * Math.cos(a),  sy = cy + 4 * Math.sin(a)
    const tx = cx + 10 * Math.cos(a2), ty = cy + 10 * Math.sin(a2)
    const qx = cx + 8 * Math.cos(am), qy = cy + 8 * Math.sin(am)
    blades.push(`M${cx},${cy} L${sx},${sy} Q${qx},${qy} ${tx},${ty}Z`)
  }
  const col = on ? '#e84a1a' : '#555'
  return (
    <svg viewBox="0 0 28 28" width={28} height={28} className="nc-ficon">
      <circle cx={cx} cy={cy} r={12} fill="none" stroke={on ? 'rgba(232,74,26,0.55)' : '#2e2e2e'} strokeWidth="1.2" />
      {blades.map((d, i) => <path key={i} d={d} fill={col} opacity={0.9} />)}
      <circle cx={cx} cy={cy} r={3} fill={col} />
    </svg>
  )
}

// ─── Monitoring Graph ──────────────────────────────────────────────────────────
// Draws NitroSense-style dense vertical-bar + smooth temp line
function drawChart(canvas: HTMLCanvasElement, tempH: number[], loadH: number[]) {
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const W = canvas.width, H = canvas.height

  ctx.fillStyle = '#090909'
  ctx.fillRect(0, 0, W, H)

  // Grid
  ctx.strokeStyle = 'rgba(200,50,0,0.06)'
  ctx.lineWidth = 1
  for (let i = 1; i < 8; i++) {
    const x = Math.round((W * i) / 8)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
  }

  const N    = tempH.length
  if (N < 2) return
  const step = W / GLEN

  // Phase 1 — load bars (dark fill from bottom)
  for (let i = 0; i < N; i++) {
    const x  = Math.round((i + GLEN - N) * step)
    const lv = loadH[i] ?? 0
    if (lv <= 0) continue
    const lh = Math.round(clamp(lv / 100, 0, 1) * H * 0.72)
    if (lh < 1) continue
    const g = ctx.createLinearGradient(0, H, 0, H - lh)
    g.addColorStop(0,   'rgba(100,28,0,0.5)')
    g.addColorStop(0.5, 'rgba(165,55,0,0.65)')
    g.addColorStop(1,   'rgba(210,78,10,0.72)')
    ctx.fillStyle = g
    ctx.fillRect(x, H - lh, Math.max(1, Math.round(step * 0.76)), lh)
  }

  // Phase 2 — temp spikes (bright vertical lines)
  for (let i = 0; i < N; i++) {
    const x  = Math.round((i + GLEN - N) * step)
    const tv = tempH[i] ?? 0
    if (tv <= 20) continue
    const th = Math.round(clamp((tv - 20) / 80, 0, 1) * H)
    if (th < 1) continue
    const g = ctx.createLinearGradient(0, H, 0, H - th)
    g.addColorStop(0,   'rgba(120,35,0,0.0)')
    g.addColorStop(0.4, 'rgba(200,70,5,0.55)')
    g.addColorStop(0.8, 'rgba(245,115,15,0.88)')
    g.addColorStop(1,   'rgba(255,165,45,1)')
    ctx.strokeStyle = g
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, H - th); ctx.stroke()
  }

  // Phase 3 — smooth temperature line
  ctx.beginPath()
  for (let i = 0; i < N; i++) {
    const x = (i + GLEN - N) * step
    const y = H - clamp((tempH[i] - 20) / 80, 0, 1) * H
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
  }
  ctx.strokeStyle = 'rgba(255,165,55,0.78)'
  ctx.lineWidth   = 1.5
  ctx.stroke()
}

// ─── Chart Row Component ───────────────────────────────────────────────────────
function ChartRow({ label, tempH, loadH, curT, curL, minT, maxT }:
  { label: string; tempH: number[]; loadH: number[]; curT: number|null; curL: number|null; minT: number; maxT: number }) {
  const canRef  = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const cv = canRef.current, wr = wrapRef.current
    if (!cv || !wr) return
    const dpr = window.devicePixelRatio || 1
    const { width: w, height: h } = wr.getBoundingClientRect()
    cv.width  = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')
    ctx?.scale(dpr, dpr)
    drawChart(cv, tempH, loadH)
  }, [tempH, loadH])

  return (
    <div className="nc-chart">
      <div className="nc-chart__mm">
        {minT > 0 ? `Min : ${minT}°  Max : ${maxT}°` : '\u00a0'}
      </div>
      <div className="nc-chart__body">
        <div className="nc-chart__wrap" ref={wrapRef}>
          <span className="nc-chart__lbl">{label}</span>
          <canvas ref={canRef} />
        </div>
        <div className="nc-chart__vals">
          <span className="nc-chart__t">{curT != null ? `${curT}°` : '--°'}</span>
          <span className="nc-chart__l">{curL != null ? `${curL} %` : '-- %'}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Main App ──────────────────────────────────────────────────────────────────
export default function NitroApp() {

  // UI state
  const [fanProfile,   setFanProfile]   = useState<FanProfile>('auto')
  const [powerProfile, setPowerProfile] = useState<PowerProfile>('battery-guard')
  const [acMode,       setAcMode]       = useState<AcMode>('ac')
  const [coolBoost,    setCoolBoost]    = useState(false)
  const [cpuSlider,    setCpuSlider]    = useState(50)
  const [gpuSlider,    setGpuSlider]    = useState(50)
  const [statusMsg,    setStatusMsg]    = useState('')

  // Backend state
  const [liveTel,  setLiveTel]  = useState<TelemetrySnapshot | null>(null)
  const [, setLiveCtrl] = useState<LiveControlSnapshot | null>(null)

  // Monitoring history
  const [cpuTH, setCpuTH] = useState<number[]>([])
  const [cpuLH, setCpuLH] = useState<number[]>([])
  const [gpuTH, setGpuTH] = useState<number[]>([])
  const [gpuLH, setGpuLH] = useState<number[]>([])
  const [cpuMin, setCpuMin] = useState(0)
  const [cpuMax, setCpuMax] = useState(0)
  const [gpuMin, setGpuMin] = useState(0)
  const [gpuMax, setGpuMax] = useState(0)

  // Persistence state (held for saveControlSnapshot)
  const [, setCurves]      = useState<Curves>(DEF_CURVES)
  const [custPBase,   setCustPBase]   = useState<CustomPowerBaseId>('performance')
  const [custPState,  setCustPState]  = useState({ min: 35, max: 88 })
  const [gpuTuning,   setGpuTuning]   = useState<GpuTuningState>({ coreClockMhz:165, memoryClockMhz:420, voltageOffsetMv:-35, powerLimitPercent:114, tempLimitC:83 })
  const [fanSync,     setFanSync]     = useState(false)
  const [smartChg,    setSmartChg]    = useState(true)
  const [pCtrl,       setPCtrl]       = useState(true)
  const [nvTel,       setNvTel]       = useState(true)
  const [keepWarm,    setKeepWarm]    = useState(false)
  const [usbPwr,      setUsbPwr]      = useState(true)
  const [blFilter,    setBlFilter]    = useState(false)
  const [arBat,       setArBat]       = useState(false)
  const [arHz,        setArHz]        = useState<number | null>(null)
  const [bootArt,     setBootArt]     = useState('ember')
  const [bootFile,    setBootFile]    = useState('custom-boot.png')
  const [updateCh]                    = useState<UpdateCh>('stable')
  const [updOnLaunch, setUpdOnLaunch] = useState(true)
  const [ocSlot,      setOcSlot]      = useState('daily')
  const [ocState,     setOcState]     = useState<'staged'|'live'>('live')
  const [ocLocked,    setOcLocked]    = useState(false)

  // Refs
  const svcRef   = useRef(false)
  const fanRef   = useRef(false)
  const pwrRef   = useRef(false)
  const ctlN     = useRef(0)
  const qFan     = useRef<FanProfile | null>(null)
  const qPwr     = useRef<PowerProfile | null>(null)
  const curvesR  = useRef<Curves>(DEF_CURVES)
  const telSnap  = useRef<string | null>(null)
  const liveSnap = useRef<string | null>(null)
  const liveObj  = useRef<LiveControlSnapshot | null>(null)
  const polling  = useRef(false)

  // Derived display values
  const tel       = hasData(liveTel) ? liveTel : null
  const curCpuT   = tel ? (tel.cpuTempAverageC ?? tel.cpuTempC ?? null) : null
  const curGpuT   = tel?.gpuTempC ?? null
  const curCpuU   = tel?.cpuUsagePercent ?? null
  const curGpuU   = tel?.gpuUsagePercent ?? null
  const cpuFanRpm = (tel?.cpuFanRpm ?? 0) > 0 ? tel!.cpuFanRpm : null
  const gpuFanRpm = (tel?.gpuFanRpm ?? 0) > 0 ? tel!.gpuFanRpm : null

  // Fan RPM for display (live preferred, else simulated)
  const cpuRpm = cpuFanRpm ?? (fanProfile === 'max' ? 4950 : fanProfile === 'auto' ? 2173 : Math.round(cpuSlider * 48 + 200))
  const gpuRpm = gpuFanRpm ?? (fanProfile === 'max' ? 5110 : fanProfile === 'auto' ? 2542 : Math.round(gpuSlider * 52 + 220))
  const dialFast   = fanProfile === 'max' || coolBoost
  const dialActive = fanProfile !== 'auto' || (cpuFanRpm ?? 0) > 500

  // ── Update monitoring history ─────────────────────────────────────────────
  useEffect(() => {
    if (!tel) return
    const ct = tel.cpuTempAverageC ?? tel.cpuTempC ?? 0
    const gt = tel.gpuTempC ?? 0
    const cl = tel.cpuUsagePercent ?? 0
    const gl = tel.gpuUsagePercent ?? 0
    setCpuTH(h => [...h, ct].slice(-GLEN))
    setCpuLH(h => [...h, cl].slice(-GLEN))
    setGpuTH(h => [...h, gt].slice(-GLEN))
    setGpuLH(h => [...h, gl].slice(-GLEN))
    setCpuMin(p => p === 0 ? Math.round(ct) : Math.min(p, Math.round(ct)))
    setCpuMax(p => Math.max(p, Math.round(ct)))
    setGpuMin(p => p === 0 ? Math.round(gt) : Math.min(p, Math.round(gt)))
    setGpuMax(p => Math.max(p, Math.round(gt)))
  }, [tel])

  // ── Serialized update helper ──────────────────────────────────────────────
  function serial<T>(ref: { current: string|null }, val: T|null, set: (v: T|null)=>void) {
    const s = val == null ? null : JSON.stringify(val)
    if (ref.current === s) return
    ref.current = s; set(val)
  }

  // ── Apply control snapshot from backend ───────────────────────────────────
  function applySnap(c: ControlSnapshot, live?: LiveControlSnapshot|null) {
    setFanProfile(c.activeFanProfile)
    setPowerProfile(c.activePowerProfile)
    const cv = fromCurves(c.fanCurves)
    setCurves(cv); curvesR.current = cv
    setCustPBase(c.customPowerBase)
    setCustPState({ min: c.customProcessorState.minPercent, max: c.customProcessorState.maxPercent })
    setGpuTuning(c.gpuTuning)
    setFanSync(c.fanSyncLockEnabled)
    setSmartChg(c.personalSettings.smartChargingEnabled)
    setPCtrl(c.personalSettings.processorStateControlEnabled)
    setNvTel(c.personalSettings.nvidiaTelemetryEnabled ?? true)
    setKeepWarm(c.personalSettings.keepUiPrewarmed ?? false)
    setUsbPwr(c.personalSettings.usbPowerEnabled)
    setBlFilter(c.personalSettings.blueLightFilterEnabled)
    setArBat(c.personalSettings.autoRefreshRateOnBatteryEnabled)
    setArHz(c.personalSettings.autoRefreshRateRestoreHz)
    setBootArt(c.personalSettings.selectedBootArt)
    setBootFile(c.personalSettings.customBootFilename)
    setUpdOnLaunch(c.personalSettings.checkForUpdatesOnLaunch)
    setOcSlot(c.activeOcSlot)
    setOcState(c.ocApplyState)
    setOcLocked(c.ocTuningLocked)
    if (live !== undefined) { liveObj.current = live; setLiveCtrl(live) }
  }

  // ── Build persist payload ─────────────────────────────────────────────────
  function buildPayload(overrides: { activeFanProfile?: FanProfile; activePowerProfile?: PowerProfile } = {}): ControlSnapshot {
    return {
      activePowerProfile:   overrides.activePowerProfile ?? powerProfile,
      activeFanProfile:     overrides.activeFanProfile   ?? fanProfile,
      customProcessorState: { minPercent: custPState.min, maxPercent: custPState.max },
      customPowerBase: custPBase,
      gpuTuning,
      ocPresets: [],
      activeOcSlot: ocSlot,
      ocApplyState: ocState,
      ocTuningLocked: ocLocked,
      fanCurves: toCurves(curvesR.current),
      fanSyncLockEnabled: fanSync,
      personalSettings: {
        smartChargingEnabled: smartChg,
        usbPowerEnabled: usbPwr,
        processorStateControlEnabled: pCtrl,
        nvidiaTelemetryEnabled: nvTel,
        keepUiPrewarmed: keepWarm,
        blueLightFilterEnabled: blFilter,
        autoRefreshRateOnBatteryEnabled: arBat,
        autoRefreshRateRestoreHz: arHz,
        selectedBootArt: bootArt as BootArtId,
        customBootFilename: bootFile,
        updateChannel: updateCh,
        checkForUpdatesOnLaunch: updOnLaunch,
      },
    }
  }

  // Persist saves settings to disk → remembered across restarts
  const persist = useCallback(async (overrides: { activeFanProfile?: FanProfile; activePowerProfile?: PowerProfile } = {}) => {
    try { await saveControlSnapshot(buildPayload(overrides)) } catch { /* non-fatal */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [powerProfile, fanProfile, custPState, custPBase, gpuTuning, ocSlot, ocState, ocLocked, fanSync, smartChg, usbPwr, pCtrl, nvTel, keepWarm, blFilter, arBat, arHz, bootArt, bootFile, updateCh, updOnLaunch])

  // ── Bootstrap + polling ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    if (isTauri()) {
      // Load saved settings on startup
      void (async () => {
        try {
          const bs = await getBackendBootstrap()
          if (cancelled) return
          svcRef.current = bs.service.connected
          applySnap(bs.controls, bs.liveControls)
          if (bs.telemetry) serial(telSnap, bs.telemetry, setLiveTel)
          setStatusMsg(bs.service.connected ? 'Service connected.' : 'Service not connected.')
        } catch (e) { setStatusMsg(`Init failed: ${errMsg(e)}`) }
      })()

      // Poll live data
      let t = 0
      async function poll() {
        if (polling.current || ctlN.current > 0) return
        polling.current = true
        try {
          const snap = await getBackendPollSnapshot()
          if (cancelled) return
          svcRef.current = snap.service.connected
          serial(telSnap, snap.telemetry, setLiveTel)
          serial(liveSnap, snap.liveControls, v => { liveObj.current = v; setLiveCtrl(v) })
        } catch { } finally { polling.current = false }
      }

      const sched = () => {
        t = window.setTimeout(() => void poll().finally(() => { if (!cancelled) sched() }),
          document.visibilityState === 'hidden' ? HIDPOLL : POLL_MS)
      }
      const onVis = () => { if (document.visibilityState === 'visible') { clearTimeout(t); void poll().finally(() => { if (!cancelled) sched() }) } }
      document.addEventListener('visibilitychange', onVis)
      sched()
      return () => { cancelled = true; clearTimeout(t); document.removeEventListener('visibilitychange', onVis) }

    } else {
      // ── Browser preview simulation ──────────────────────────────────────
      let f = 0
      const bc = 47, bg = 45
      const initCT = Array.from({ length: GLEN }, (_, i) => bc + Math.sin(i * 0.15) * 10 + Math.random() * 5)
      const initCL = Array.from({ length: GLEN }, (_, i) => 40 + Math.sin(i * 0.11) * 28 + Math.random() * 12)
      const initGT = Array.from({ length: GLEN }, (_, i) => bg + Math.sin(i * 0.10) * 8 + Math.random() * 4)
      const initGL = Array.from({ length: GLEN }, (_, i) => 22 + Math.sin(i * 0.09) * 20 + Math.random() * 8)
      setCpuTH(initCT); setCpuLH(initCL); setGpuTH(initGT); setGpuLH(initGL)
      setCpuMin(36); setCpuMax(91); setGpuMin(35); setGpuMax(74)
      setStatusMsg('Preview mode — service not connected.')

      const tid = window.setInterval(() => {
        f++
        const ct = bc + Math.sin(f * 0.08) * 11 + Math.random() * 6
        const gt = bg + Math.sin(f * 0.06) * 9 + Math.random() * 5
        const cl = 40 + Math.sin(f * 0.10) * 30 + Math.random() * 14
        const gl = 24 + Math.sin(f * 0.07) * 22 + Math.random() * 10
        const cr = 2173 + Math.round(Math.sin(f * 0.05) * 200 + Math.random() * 80)
        const gr = 2542 + Math.round(Math.sin(f * 0.04) * 260 + Math.random() * 90)
        setCpuTH(h => [...h, ct].slice(-GLEN))
        setCpuLH(h => [...h, cl].slice(-GLEN))
        setGpuTH(h => [...h, gt].slice(-GLEN))
        setGpuLH(h => [...h, gl].slice(-GLEN))
        setCpuMin(p => p === 0 ? Math.round(ct) : Math.min(p, Math.round(ct)))
        setCpuMax(p => Math.max(p, Math.round(ct)))
        setGpuMin(p => p === 0 ? Math.round(gt) : Math.min(p, Math.round(gt)))
        setGpuMax(p => Math.max(p, Math.round(gt)))
        setLiveTel({
          cpuTempC: Math.round(ct), cpuTempAverageC: Math.round(ct),
          cpuTempLowestCoreC: Math.round(ct-3), cpuTempHighestCoreC: Math.round(ct+5),
          gpuTempC: Math.round(gt), systemTempC: Math.round((ct+gt)/2),
          cpuUsagePercent: Math.round(cl), gpuUsagePercent: Math.round(gl),
          gpuMemoryUsagePercent: 38, gpuPowerDrawW: 65, gpuPowerLimitW: 80,
          gpuPowerDefaultLimitW: 80, gpuPowerMinLimitW: 20, gpuPowerMaxLimitW: 100,
          cpuPackagePowerW: 45, cpuPl1W: 45, cpuPl1Enabled: true, cpuPl2W: 65, cpuPl2Enabled: true,
          cpuPowerLimitLocked: false, cpuName: 'Core i7-12700H', cpuBrand: 'Intel',
          gpuName: 'RTX 3060 Laptop', gpuBrand: 'NVIDIA', systemVendor: 'Acer', systemModel: 'Nitro AN515-58',
          cpuClockMhz: 3200 + Math.round(Math.random()*800), gpuClockMhz: 1500 + Math.round(Math.random()*400),
          cpuFanRpm: cr, gpuFanRpm: gr,
          batteryPercent: 72, batteryLifeRemainingSec: null, acPluggedIn: true,
        })
      }, 1000)

      return () => clearInterval(tid)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Save settings when app is closed / refreshed ─────────────────────────
  // This ensures "max mode" or any setting chosen before closing is remembered
  useEffect(() => {
    const save = () => { void persist() }
    window.addEventListener('beforeunload', save)
    return () => window.removeEventListener('beforeunload', save)
  }, [persist])

  // ── Fan profile apply ─────────────────────────────────────────────────────
  async function handleFan(id: FanProfile, overrideMsg?: string) {
    setFanProfile(id)
    setStatusMsg(overrideMsg ?? `Applying fan mode: ${id}…`)

    // Always persist to disk first (works offline too)
    await persist({ activeFanProfile: id })

    if (!svcRef.current) {
      setStatusMsg(`Fan mode ${id} saved (service not connected).`)
      return
    }
    if (fanRef.current) { qFan.current = id; return }
    fanRef.current = true; ctlN.current++
    try {
      await waitPaint()
      const req = id === 'custom'
        ? applyCustomFanCurves(toCurves(curvesR.current))
        : applyFanProfile(id)
      const res = await withTo(req, FAN_TO, `fan ${id}`)
      applySnap(res.controls)
      setStatusMsg(res.detail)
    } catch (e) {
      setFanProfile(fanProfile)
      setStatusMsg(`Fan apply failed: ${errMsg(e)}`)
    } finally {
      fanRef.current = false
      ctlN.current = Math.max(0, ctlN.current - 1)
      const q = qFan.current; qFan.current = null
      if (q && q !== id) void handleFan(q)
    }
  }

  // ── Power profile apply ───────────────────────────────────────────────────
  async function handlePower(id: PowerProfile) {
    setPowerProfile(id)
    const ps = id === 'battery-guard' ? { minPercent:5,  maxPercent:45  }
             : id === 'balanced'      ? { minPercent:35, maxPercent:88  }
             : id === 'performance'   ? { minPercent:100,maxPercent:100 }
             : id === 'turbo'         ? { minPercent:100,maxPercent:100 }
             : { minPercent:custPState.min, maxPercent:custPState.max }

    await persist({ activePowerProfile: id })

    if (!svcRef.current) {
      setStatusMsg(`Power plan ${id} saved (service not connected).`)
      return
    }
    if (pwrRef.current) { qPwr.current = id; return }
    pwrRef.current = true; ctlN.current++
    try {
      await waitPaint()
      const res = await applyPowerProfile(id, ps, null, pCtrl)
      applySnap(res)
      setStatusMsg(`Power plan applied: ${id}`)
    } catch (e) {
      setPowerProfile(powerProfile)
      setStatusMsg(`Power apply failed: ${errMsg(e)}`)
    } finally {
      pwrRef.current = false
      ctlN.current = Math.max(0, ctlN.current - 1)
      const q = qPwr.current; qPwr.current = null
      if (q && q !== id) void handlePower(q)
    }
  }

  // CoolBoost
  async function handleCoolBoost(on: boolean) {
    setCoolBoost(on)
    await handleFan(on ? 'max' : 'auto')
  }

  // Window controls
  const doMinimize = async () => {
    try {
      await getCurrentWindow().minimize()
    } catch (error) {
      // The browser preview has no native window. In the packaged Tauri app the
      // API is available even when the legacy __TAURI_INTERNALS__ global is not.
      if (isTauri()) setStatusMsg(`Could not minimize: ${errMsg(error)}`)
    }
  }

  const doClose = async () => {
    try {
      await persist()
      await getCurrentWindow().close()
    } catch (error) {
      if (isTauri()) setStatusMsg(`Could not close: ${errMsg(error)}`)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const spinDur = dialFast ? '1.0s' : '3.5s'
  const isCustom = fanProfile === 'custom'

  return (
    <div className="nc-shell">

      {/* ── TITLEBAR ──────────────────────────────────────────────────────── */}
      <header className="nc-titlebar">
        <span className="nc-titlebar__acer">acer</span>

        <div className="nc-titlebar__title">
          <span className="nc-titlebar__bold">NITRO</span>
          <span className="nc-titlebar__light">COOLER</span>
        </div>

        <div className="nc-titlebar__right">
          {/* GeForce Experience */}
          <div className="nc-gfe">
            <div className="nc-gfe__dot">G</div>
            <span className="nc-gfe__txt">GEFORCE<br/>EXPERIENCE</span>
          </div>
          {/* Keyboard */}
          <button className="nc-ibtn" title="Keyboard">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <rect x="2" y="7" width="20" height="11" rx="2"/>
              <line x1="6" y1="11" x2="6" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="10" y1="11" x2="10" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="14" y1="11" x2="14" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="18" y1="11" x2="18" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="8" y1="15" x2="16" y2="15" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
          {/* Audio */}
          <button className="nc-ibtn" title="Audio">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <line x1="2"  y1="10" x2="2"  y2="14" strokeLinecap="round"/>
              <line x1="5"  y1="7"  x2="5"  y2="17" strokeLinecap="round"/>
              <line x1="8"  y1="4"  x2="8"  y2="20" strokeLinecap="round"/>
              <line x1="11" y1="8"  x2="11" y2="16" strokeLinecap="round"/>
              <line x1="14" y1="5"  x2="14" y2="19" strokeLinecap="round"/>
              <line x1="17" y1="9"  x2="17" y2="15" strokeLinecap="round"/>
              <line x1="20" y1="11" x2="20" y2="13" strokeLinecap="round"/>
            </svg>
          </button>
          {/* Settings */}
          <button className="nc-ibtn" title="Settings">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <circle cx="12" cy="12" r="3"/>
              <path strokeLinecap="round" d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
            </svg>
          </button>
          {/* Minimize */}
          <button className="nc-ibtn" title="Minimize" onClick={doMinimize}>
            <svg width="14" height="2" viewBox="0 0 14 2"><rect width="14" height="2" fill="currentColor"/></svg>
          </button>
          {/* Close */}
          <button className="nc-ibtn close" title="Close" onClick={doClose}>
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path fill="currentColor" d="M6 4.586L1.707.293.293 1.707 4.586 6 .293 10.293l1.414 1.414L6 7.414l4.293 4.293 1.414-1.414L7.414 6l4.293-4.293L10.293.293z"/>
            </svg>
          </button>
        </div>
      </header>

      {/* ── BODY ──────────────────────────────────────────────────────────── */}
      <div className="nc-body">

        {/* ── FAN CONTROL PANEL ───────────────────────────────────────────── */}
        <div className={`nc-fan${isCustom ? ' expanded' : ''}`}>
          <span className="nc-tab">Fan Control</span>

          {/* CoolBoost toggle */}
          <div className="nc-cb">
            <span className="nc-cb__info">ℹ</span>
            <span className="nc-cb__label">CoolBoost™</span>
            <label className="nc-toggle">
              <input type="checkbox" checked={coolBoost} onChange={e => void handleCoolBoost(e.target.checked)} />
              <span className="nc-toggle__t" />
            </label>
          </div>

          {/* Fan mode buttons */}
          <div className="nc-modes">
            {([
              { id: 'auto',   label: 'Auto'   },
              { id: 'max',    label: 'Max'    },
              { id: 'custom', label: 'Custom' },
            ] as { id: FanProfile; label: string }[]).map(m => (
              <button
                key={m.id}
                className={`nc-mbtn${fanProfile === m.id ? ' on' : ''}`}
                onClick={() => void handleFan(m.id)}
              >
                <FanIcon on={fanProfile === m.id} />
                {m.label}
              </button>
            ))}
          </div>

          {/* Vertical divider */}
          <div className="nc-vdiv" />

          {/* Fan dials */}
          <div className="nc-dials">
            {/* CPU */}
            <div className="nc-dgrp">
              <span className="nc-dlabel left">CPU</span>
              <div className="nc-dial">
                <div className={`nc-spin${dialFast ? ' fast' : ''}`} style={{ animationDuration: spinDur }}>
                  <FanRing active={dialActive} size={138} />
                </div>
                <div className="nc-readout">
                  <span className="nc-rpm">{cpuRpm.toLocaleString()}</span>
                  <span className="nc-runit">RPM</span>
                </div>
              </div>
            </div>

            <div className="nc-dsep" />

            {/* GPU */}
            <div className="nc-dgrp">
              <div className="nc-dial">
                <div className={`nc-spin${dialFast ? ' fast' : ''}`} style={{ animationDuration: spinDur }}>
                  <FanRing active={dialActive} size={138} />
                </div>
                <div className="nc-readout">
                  <span className="nc-rpm">{gpuRpm.toLocaleString()}</span>
                  <span className="nc-runit">RPM</span>
                </div>
              </div>
              <span className="nc-dlabel right">GPU</span>
            </div>
          </div>

          {/* ── Custom fan sliders (appear when Custom is selected) ── */}
          {isCustom && (
            <div className="nc-custom">
              {/* CPU slider row */}
              <div className="nc-crow">
                <span className="nc-cname">CPU</span>
                <button className="nc-pm"
                  onClick={() => setCpuSlider(v => Math.max(0, v - 5))}>−</button>
                <input type="range" min={0} max={100} value={cpuSlider}
                  className="nc-slider"
                  onChange={e => setCpuSlider(+e.target.value)} />
                <button className="nc-pm"
                  onClick={() => setCpuSlider(v => Math.min(100, v + 5))}>+</button>
                <span className="nc-pct">{cpuSlider}%</span>
                <button className="nc-autobtn" onClick={() => void handleFan('auto')}>Auto</button>
              </div>
              {/* GPU slider row */}
              <div className="nc-crow">
                <span className="nc-cname">GPU</span>
                <button className="nc-pm"
                  onClick={() => setGpuSlider(v => Math.max(0, v - 5))}>−</button>
                <input type="range" min={0} max={100} value={gpuSlider}
                  className="nc-slider"
                  onChange={e => setGpuSlider(+e.target.value)} />
                <button className="nc-pm"
                  onClick={() => setGpuSlider(v => Math.min(100, v + 5))}>+</button>
                <span className="nc-pct">{gpuSlider}%</span>
                <button className="nc-autobtn" onClick={() => void handleFan('auto')}>Auto</button>
              </div>
            </div>
          )}
        </div>{/* end fan panel */}

        {/* ── BOTTOM ROW ────────────────────────────────────────────────── */}
        <div className="nc-bottom">

          {/* Power Plan */}
          <div className="nc-pplan">
            <span className="nc-tab">Power Plan</span>
            <div className="nc-pplan__inner">
              <div className="nc-mlbl">Mode</div>
              <div className="nc-actabs">
                <button className={`nc-actab${acMode === 'ac' ? ' on' : ''}`} onClick={() => setAcMode('ac')}>AC</button>
                <button className={`nc-actab${acMode === 'battery' ? ' on' : ''}`} onClick={() => setAcMode('battery')}>Battery</button>
              </div>
              <div className="nc-pitems">
                {PLANS.map(p => (
                  <button
                    key={p.id}
                    className={`nc-pitem${powerProfile === p.id ? ' on' : ''}`}
                    onClick={() => void handlePower(p.id)}
                  >
                    {p.label.split('\n').map((ln, i) => (
                      <span key={i} style={i > 0 ? { display:'block', fontSize:11 } : undefined}>{ln}</span>
                    ))}
                  </button>
                ))}
              </div>
            </div>
            {statusMsg && <div className="nc-status">{statusMsg}</div>}
          </div>

          {/* Monitoring */}
          <div className="nc-mon">
            <span className="nc-tab">Monitoring</span>
            <div className="nc-mon__inner">
              <div className="nc-mon__hdr">
                <span className="nc-mon__axis">Temperature (°C) / Loading (%)</span>
              </div>
              <ChartRow
                label="CPU"
                tempH={cpuTH} loadH={cpuLH}
                curT={curCpuT != null ? Math.round(curCpuT) : null}
                curL={curCpuU != null ? Math.round(curCpuU) : null}
                minT={cpuMin} maxT={cpuMax}
              />
              <ChartRow
                label="GPU"
                tempH={gpuTH} loadH={gpuLH}
                curT={curGpuT != null ? Math.round(curGpuT) : null}
                curL={curGpuU != null ? Math.round(curGpuU) : null}
                minT={gpuMin} maxT={gpuMax}
              />
            </div>
          </div>

        </div>{/* end bottom */}
      </div>{/* end body */}
    </div>
  )
}
