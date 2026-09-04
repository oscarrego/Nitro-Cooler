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
  applyKeyboardLighting,
  applyBacklightTimeout,
  applyStickyKeys,
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
  const N  = 0                // no toothed ring: the original uses slim blades
  const B  = 24               // slim radial fan blades
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
        <circle cx={cx} cy={cy} r={OR - 2}  fill="none" stroke="rgba(213,112,28,0.78)"  strokeWidth="1.5" filter={`url(#${id})`} />
        <circle cx={cx} cy={cy} r={OR - 7}  fill="none" stroke="rgba(255,255,255,0.10)"  strokeWidth="1" />
        <circle cx={cx} cy={cy} r={TR}      fill="none" stroke="rgba(255,255,255,0.06)"  strokeWidth="1" />
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
          fill={active ? '#747474' : '#252525'}
          stroke={active ? 'rgba(210,210,210,0.58)' : 'rgba(255,255,255,0.10)'}
          strokeWidth="0.55"
        />
      ))}

      {/* Hub */}
      <circle cx={cx} cy={cy} r={HR}
        fill={active ? '#151515' : '#161616'}
        stroke={active ? 'rgba(213,112,28,0.68)' : 'rgba(255,255,255,0.08)'}
        strokeWidth="1.5"
        filter={active ? `url(#${id})` : undefined}
      />
      <circle cx={cx} cy={cy} r={4} fill={active ? '#bd6a20' : '#2a2a2a'} filter={active ? `url(#${id})` : undefined} />
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
function ChartRow({ label, tempH, loadH, curT, curL, minT, maxT, fahrenheit }:
  { label: string; tempH: number[]; loadH: number[]; curT: number|null; curL: number|null; minT: number; maxT: number; fahrenheit: boolean }) {
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

  const showTemp = (value: number) => Math.round(fahrenheit ? value * 9 / 5 + 32 : value)

  return (
    <div className="nc-chart">
      <div className="nc-chart__mm">
        {minT > 0 ? `Min : ${showTemp(minT)}°  Max : ${showTemp(maxT)}°` : '\u00a0'}
      </div>
      <div className="nc-chart__body">
        <div className="nc-chart__wrap" ref={wrapRef}>
          <span className="nc-chart__lbl">{label}</span>
          <canvas ref={canRef} />
        </div>
        <div className="nc-chart__vals">
          <span className="nc-chart__t">{curT != null ? `${showTemp(curT)}°` : '--°'}</span>
          <span className="nc-chart__l">{curL != null ? `${curL} %` : '-- %'}</span>
        </div>
      </div>
    </div>
  )
}

function SettingSwitch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="nc-settings__row">
      <span>{label}</span>
      <span className="nc-switch">
        <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} />
        <span />
      </span>
    </label>
  )
}

// ─── Main App ──────────────────────────────────────────────────────────────────
export default function NitroApp() {

  // UI state
  const [fanProfile,   setFanProfile]   = useState<FanProfile>('auto')
  const [powerProfile, setPowerProfile] = useState<PowerProfile>('battery-guard')
  const [acMode,       setAcMode]       = useState<AcMode>('ac')
  const [coolBoost,    setCoolBoost]    = useState(true)
  const [cpuSlider,    setCpuSlider]    = useState(50)
  const [gpuSlider,    setGpuSlider]    = useState(50)
  const [cpuAuto,      setCpuAuto]      = useState(true)
  const [gpuAuto,      setGpuAuto]      = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [stickyKeys,   setStickyKeys]   = useState(false)
  const [winMenuKeys,  setWinMenuKeys]  = useState(true)
  const [fahrenheit,   setFahrenheit]   = useState(false)
  const [backlightOff, setBacklightOff] = useState(false)
  const [lightingOpen, setLightingOpen] = useState(false)
  const [lightingDynamic, setLightingDynamic] = useState(false)
  const [keyboardBrightness, setKeyboardBrightness] = useState(75)
  const [keyboardZones, setKeyboardZones] = useState([true, true, true, true])
  const [keyboardColors, setKeyboardColors] = useState(['#ff3b00', '#ff3b00', '#ff3b00', '#ff3b00'])

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
    setCoolBoost(c.personalSettings.coolBoostEnabled ?? true)
    setCpuAuto(c.personalSettings.customCpuAutoEnabled ?? true)
    setGpuAuto(c.personalSettings.customGpuAutoEnabled ?? true)
    setCpuSlider(c.personalSettings.customCpuSpeedPercent ?? 50)
    setGpuSlider(c.personalSettings.customGpuSpeedPercent ?? 50)
    setStickyKeys(c.personalSettings.stickyKeysEnabled ?? false)
    setWinMenuKeys(c.personalSettings.windowsMenuKeysEnabled ?? true)
    setFahrenheit(c.personalSettings.temperatureUnitFahrenheit ?? false)
    setBacklightOff(c.personalSettings.keyboardBacklightTimeoutEnabled ?? false)
    setLightingDynamic(c.personalSettings.keyboardLightingDynamic ?? false)
    setKeyboardBrightness(c.personalSettings.keyboardBrightnessPercent ?? 75)
    setKeyboardZones([
      c.personalSettings.keyboardZone1Enabled ?? true,
      c.personalSettings.keyboardZone2Enabled ?? true,
      c.personalSettings.keyboardZone3Enabled ?? true,
      c.personalSettings.keyboardZone4Enabled ?? true,
    ])
    setKeyboardColors([
      c.personalSettings.keyboardZone1Color ?? '#ff3b00',
      c.personalSettings.keyboardZone2Color ?? '#ff3b00',
      c.personalSettings.keyboardZone3Color ?? '#ff3b00',
      c.personalSettings.keyboardZone4Color ?? '#ff3b00',
    ])
    setOcSlot(c.activeOcSlot)
    setOcState(c.ocApplyState)
    setOcLocked(c.ocTuningLocked)
    if (live !== undefined) { liveObj.current = live; setLiveCtrl(live) }
  }

  // ── Build persist payload ─────────────────────────────────────────────────
  type SnapshotOverrides = {
    activeFanProfile?: FanProfile
    activePowerProfile?: PowerProfile
    personalSettings?: Partial<ControlSnapshot['personalSettings']>
  }

  function buildPayload(overrides: SnapshotOverrides = {}): ControlSnapshot {
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
        coolBoostEnabled: coolBoost,
        customCpuAutoEnabled: cpuAuto,
        customGpuAutoEnabled: gpuAuto,
        customCpuSpeedPercent: cpuSlider,
        customGpuSpeedPercent: gpuSlider,
        stickyKeysEnabled: stickyKeys,
        windowsMenuKeysEnabled: winMenuKeys,
        temperatureUnitFahrenheit: fahrenheit,
        keyboardBacklightTimeoutEnabled: backlightOff,
        keyboardLightingDynamic: lightingDynamic,
        keyboardBrightnessPercent: keyboardBrightness,
        keyboardZone1Enabled: keyboardZones[0],
        keyboardZone2Enabled: keyboardZones[1],
        keyboardZone3Enabled: keyboardZones[2],
        keyboardZone4Enabled: keyboardZones[3],
        keyboardZone1Color: keyboardColors[0],
        keyboardZone2Color: keyboardColors[1],
        keyboardZone3Color: keyboardColors[2],
        keyboardZone4Color: keyboardColors[3],
        ...overrides.personalSettings,
      },
    }
  }

  // Persist saves settings to disk → remembered across restarts
  const persist = useCallback(async (overrides: SnapshotOverrides = {}) => {
    try { await saveControlSnapshot(buildPayload(overrides)) } catch { /* non-fatal */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [powerProfile, fanProfile, custPState, custPBase, gpuTuning, ocSlot, ocState, ocLocked, fanSync, smartChg, usbPwr, pCtrl, nvTel, keepWarm, blFilter, arBat, arHz, bootArt, bootFile, updateCh, updOnLaunch, coolBoost, cpuAuto, gpuAuto, cpuSlider, gpuSlider, stickyKeys, winMenuKeys, fahrenheit, backlightOff, lightingDynamic, keyboardBrightness, keyboardZones, keyboardColors])

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
        } catch (e) {}`) }
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
  async function handleFan(id: FanProfile, overrideMsg?: string, personalSettings?: SnapshotOverrides['personalSettings']) {
    setFanProfile(id)

    // Always persist to disk first (works offline too)
    await persist({ activeFanProfile: id, personalSettings })

    if (!svcRef.current) {
.`)
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
    } catch (e) {
      setFanProfile(fanProfile)
}`)
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
.`)
      return
    }
    if (pwrRef.current) { qPwr.current = id; return }
    pwrRef.current = true; ctlN.current++
    try {
      await waitPaint()
      const res = await applyPowerProfile(id, ps, null, pCtrl)
      applySnap(res)
    } catch (e) {
      setPowerProfile(powerProfile)
}`)
    } finally {
      pwrRef.current = false
      ctlN.current = Math.max(0, ctlN.current - 1)
      const q = qPwr.current; qPwr.current = null
      if (q && q !== id) void handlePower(q)
    }
  }

  function buildCustomCurves(nextCpuAuto = cpuAuto, nextGpuAuto = gpuAuto, nextCpuSpeed = cpuSlider, nextGpuSpeed = gpuSlider): Curves {
    const manual = (speed: number, fallback: Pt[]) => fallback.map(point => ({ temp: point.temp, speed }))
    return {
      cpu: nextCpuAuto ? DEF_CURVES.cpu : manual(nextCpuSpeed, DEF_CURVES.cpu),
      gpu: nextGpuAuto ? DEF_CURVES.gpu : manual(nextGpuSpeed, DEF_CURVES.gpu),
    }
  }

  async function applyCustomFanSettings(next: { cpuAuto?: boolean; gpuAuto?: boolean; cpuSpeed?: number; gpuSpeed?: number }) {
    const nextCpuAuto = next.cpuAuto ?? cpuAuto
    const nextGpuAuto = next.gpuAuto ?? gpuAuto
    // Snap to nearest 10% increment
    const snap10 = (v: number) => Math.round(clamp(v, 0, 100) / 10) * 10
    const nextCpuSpeed = snap10(next.cpuSpeed ?? cpuSlider)
    const nextGpuSpeed = snap10(next.gpuSpeed ?? gpuSlider)
    const curves = buildCustomCurves(nextCpuAuto, nextGpuAuto, nextCpuSpeed, nextGpuSpeed)

    setFanProfile('custom')
    setCpuAuto(nextCpuAuto); setGpuAuto(nextGpuAuto)
    setCpuSlider(nextCpuSpeed); setGpuSlider(nextGpuSpeed)
    setCurves(curves); curvesR.current = curves
    await persist({
      activeFanProfile: 'custom',
      personalSettings: {
        customCpuAutoEnabled: nextCpuAuto,
        customGpuAutoEnabled: nextGpuAuto,
        customCpuSpeedPercent: nextCpuSpeed,
        customGpuSpeedPercent: nextGpuSpeed,
      },
    })

    if (!svcRef.current) {
.')
      return
    }

    try {
      const result = await withTo(applyCustomFanCurves(toCurves(curves)), FAN_TO, 'custom fan settings')
      applySnap(result.controls)
    } catch (error) {
}`)
    }
  }

  // CoolBoost uses the service Auto profile, which continuously adjusts both fan
  // targets from CPU/GPU temperature instead of pinning the fans to maximum.
  async function handleCoolBoost(on: boolean) {
    setCoolBoost(on)
    await handleFan('auto', on ? 'CoolBoost enabled: temperature-based fan control active.' : 'CoolBoost disabled: standard automatic fan control active.', { coolBoostEnabled: on })
  }

  async function saveAdvancedSetting(setting: SnapshotOverrides['personalSettings']) {
    await persist({ personalSettings: setting })
    // Wire hardware backends for specific settings
    if (setting?.stickyKeysEnabled !== undefined) {
      void applyStickyKeys(setting.stickyKeysEnabled).catch(() => {/* ignore if service down */})
    }
    if (setting?.keyboardBacklightTimeoutEnabled !== undefined) {
      void applyBacklightTimeout(setting.keyboardBacklightTimeoutEnabled).catch(() => {/* ignore if service down */})
    }
  }

  function saveKeyboardLighting(next: { dynamic?: boolean; brightness?: number; zones?: boolean[]; colors?: string[] }) {
    const dynamic = next.dynamic ?? lightingDynamic
    const brightness = clamp(next.brightness ?? keyboardBrightness, 0, 100)
    const zones = next.zones ?? keyboardZones
    const colors = next.colors ?? keyboardColors
    setLightingDynamic(dynamic)
    setKeyboardBrightness(brightness)
    setKeyboardZones(zones)
    setKeyboardColors(colors)
    void persist({ personalSettings: {
      keyboardLightingDynamic: dynamic,
      keyboardBrightnessPercent: brightness,
      keyboardZone1Enabled: zones[0], keyboardZone2Enabled: zones[1], keyboardZone3Enabled: zones[2], keyboardZone4Enabled: zones[3],
      keyboardZone1Color: colors[0], keyboardZone2Color: colors[1], keyboardZone3Color: colors[2], keyboardZone4Color: colors[3],
    }})
    // Also apply to hardware via service
    const zoneConfigs = zones.map((enabled, i) => {
      const hex = colors[i] ?? '#ff3b00'
      const r = parseInt(hex.slice(1, 3), 16) || 0
      const g = parseInt(hex.slice(3, 5), 16) || 0
      const b = parseInt(hex.slice(5, 7), 16) || 0
      return { enabled, r, g, b }
    })
    void applyKeyboardLighting(brightness, zoneConfigs).catch(() => {/* service may not be connected */})
  }

  // Window controls
  const doMinimize = async () => {
    try {
      await getCurrentWindow().minimize()
    } catch (error) {
      // The browser preview has no native window. In the packaged Tauri app the
      // API is available even when the legacy __TAURI_INTERNALS__ global is not.
      if (isTauri())}`)
    }
  }

  const doClose = async () => {
    try {
      await persist()
      await getCurrentWindow().close()
    } catch (error) {
      if (isTauri())}`)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const spinDur = fanProfile === 'max' ? '0.9s' : coolBoost ? '1.7s' : '5.2s'
  const isCustom = fanProfile === 'custom'

  return (
    <div className="nc-shell">

      {/* ── TITLEBAR ──────────────────────────────────────────────────────── */}
      <header className="nc-titlebar">
        <span className="nc-titlebar__acer" aria-label="Acer">acer</span>

        <div className="nc-titlebar__title">
          <span className="nc-titlebar__bold">NITRO</span>
          <span className="nc-titlebar__light">COOLER</span>
        </div>

        <div className="nc-titlebar__right">
          {/* Keyboard */}
          <button className={`nc-ibtn${lightingOpen ? ' active' : ''}`} title="Keyboard lighting" onClick={() => setLightingOpen(open => !open)} aria-expanded={lightingOpen}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
              <rect x="2" y="7" width="20" height="11" rx="2"/>
              <line x1="6" y1="11" x2="6" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="10" y1="11" x2="10" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="14" y1="11" x2="14" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="18" y1="11" x2="18" y2="11" strokeWidth="2.5" strokeLinecap="round"/>
              <line x1="8" y1="15" x2="16" y2="15" strokeWidth="2" strokeLinecap="round"/>
            </svg>
          </button>
          {/* Settings */}
          <button className={`nc-ibtn${settingsOpen ? ' active' : ''}`} title="Settings" onClick={() => setSettingsOpen(open => !open)} aria-expanded={settingsOpen}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.1 7.1 0 0 0-1.69-.98L14.5 2.42A.5.5 0 0 0 14 2h-4a.5.5 0 0 0-.49.42l-.38 2.65c-.61.25-1.18.58-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.5.5 0 0 0 .12.64l2.11 1.65c-.05.32-.08.66-.08.98s.03.66.08.98l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.51.4 1.08.73 1.69.98l.38 2.65A.5.5 0 0 0 10 22h4a.5.5 0 0 0 .49-.42l.38-2.65c.61-.25 1.18-.58 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64l-2.11-1.65zM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5z"/>
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
          {settingsOpen && (
            <section className="nc-settings" aria-label="Advanced settings">
              <h2>Advanced Settings</h2>
              <SettingSwitch label="Sticky keys" checked={stickyKeys} onChange={checked => { setStickyKeys(checked); void saveAdvancedSetting({ stickyKeysEnabled: checked }) }} />
              <SettingSwitch label="Windows and menu key" checked={winMenuKeys} onChange={checked => { setWinMenuKeys(checked); void saveAdvancedSetting({ windowsMenuKeysEnabled: checked }) }} />
              <div className="nc-settings__row nc-settings__temperature">
                <span>Temperature units</span>
                <button className={!fahrenheit ? 'on' : ''} onClick={() => { setFahrenheit(false); void saveAdvancedSetting({ temperatureUnitFahrenheit: false }) }}>°C</button>
                <button className={fahrenheit ? 'on' : ''} onClick={() => { setFahrenheit(true); void saveAdvancedSetting({ temperatureUnitFahrenheit: true }) }}>°F</button>
              </div>
              <h3>Keyboard Settings</h3>
              <SettingSwitch label="Backlight off after 30 seconds" checked={backlightOff} onChange={checked => { setBacklightOff(checked); void saveAdvancedSetting({ keyboardBacklightTimeoutEnabled: checked }) }} />
            </section>
          )}
        </div>
      </header>

      {lightingOpen && (
        <div className="nc-lighting-overlay" role="dialog" aria-modal="true" aria-label="Keyboard lighting">
          <section className="nc-lighting">
            <button className="nc-lighting__close" title="Close keyboard lighting" onClick={() => setLightingOpen(false)}>×</button>
            <div className="nc-lighting__head">
              <h2>Keyboard Lighting</h2>
              <div className="nc-lighting__brightness">
                <span>◌</span>
                <input type="range" min="0" max="100" value={keyboardBrightness} onChange={event => saveKeyboardLighting({ brightness: +event.target.value })} />
                <span>☼</span>
              </div>
            </div>
            <div className="nc-lighting__modes">
              <button className={!lightingDynamic ? 'on' : ''} onClick={() => saveKeyboardLighting({ dynamic: false })}>Static</button>
              <button disabled title="Dynamic lighting will be available in a future update">Dynamic <small>coming later</small></button>
            </div>
            <div className="nc-keyboard" style={{ '--keyboard-brightness': `${keyboardBrightness}%` } as React.CSSProperties}>
              {Array.from({ length: 48 }, (_, key) => {
                const zone = Math.min(3, Math.floor((key % 12) / 3))
                return <i key={key} className={!keyboardZones[zone] ? 'off' : ''} style={{ '--zone-color': keyboardColors[zone] } as React.CSSProperties} />
              })}
            </div>
            <div className="nc-zones">
              {keyboardZones.map((enabled, index) => (
                <div className="nc-zone" key={index}>
                  <strong>Zone {index + 1}</strong>
                  <label className="nc-zone__toggle">
                    <input type="checkbox" checked={enabled} onChange={event => {
                      const zones = [...keyboardZones]; zones[index] = event.target.checked; saveKeyboardLighting({ zones })
                    }} />
                    <span />
                  </label>
                  <input aria-label={`Zone ${index + 1} color`} type="color" value={keyboardColors[index]} disabled={!enabled || lightingDynamic} onChange={event => {
                    const colors = [...keyboardColors]; colors[index] = event.target.value; saveKeyboardLighting({ colors })
                  }} />
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

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
                <button className="nc-pm" disabled={cpuAuto}
                  onClick={() => void applyCustomFanSettings({ cpuSpeed: cpuSlider - 10 })}>−</button>
                <input type="range" min={0} max={100} step={10} value={cpuSlider}
                  className="nc-slider" disabled={cpuAuto}
                  onChange={e => setCpuSlider(Math.round(+e.target.value / 10) * 10)}
                  onPointerUp={e => void applyCustomFanSettings({ cpuSpeed: +(e.currentTarget as HTMLInputElement).value })}
                  onKeyUp={e => void applyCustomFanSettings({ cpuSpeed: +(e.currentTarget as HTMLInputElement).value })} />
                <button className="nc-pm" disabled={cpuAuto}
                  onClick={() => void applyCustomFanSettings({ cpuSpeed: cpuSlider + 10 })}>+</button>
                <span className="nc-pct">{cpuSlider}%</span>
                <button className={`nc-autobtn${cpuAuto ? ' on' : ''}`} onClick={() => void applyCustomFanSettings({ cpuAuto: !cpuAuto })}>Auto</button>
              </div>
              {/* GPU slider row */}
              <div className="nc-crow">
                <span className="nc-cname">GPU</span>
                <button className="nc-pm" disabled={gpuAuto}
                  onClick={() => void applyCustomFanSettings({ gpuSpeed: gpuSlider - 10 })}>−</button>
                <input type="range" min={0} max={100} step={10} value={gpuSlider}
                  className="nc-slider" disabled={gpuAuto}
                  onChange={e => setGpuSlider(Math.round(+e.target.value / 10) * 10)}
                  onPointerUp={e => void applyCustomFanSettings({ gpuSpeed: +(e.currentTarget as HTMLInputElement).value })}
                  onKeyUp={e => void applyCustomFanSettings({ gpuSpeed: +(e.currentTarget as HTMLInputElement).value })} />
                <button className="nc-pm" disabled={gpuAuto}
                  onClick={() => void applyCustomFanSettings({ gpuSpeed: gpuSlider + 10 })}>+</button>
                <span className="nc-pct">{gpuSlider}%</span>
                <button className={`nc-autobtn${gpuAuto ? ' on' : ''}`} onClick={() => void applyCustomFanSettings({ gpuAuto: !gpuAuto })}>Auto</button>
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
          </div>

          {/* Monitoring */}
          <div className="nc-mon">
            <span className="nc-tab">Monitoring</span>
            <div className="nc-mon__inner">
              <div className="nc-mon__hdr">
                <span className="nc-mon__axis">Temperature (°{fahrenheit ? 'F' : 'C'}) / Loading (%)</span>
              </div>
              <ChartRow
                label="CPU"
                tempH={cpuTH} loadH={cpuLH}
                curT={curCpuT != null ? Math.round(curCpuT) : null}
                curL={curCpuU != null ? Math.round(curCpuU) : null}
                minT={cpuMin} maxT={cpuMax} fahrenheit={fahrenheit}
              />
              <ChartRow
                label="GPU"
                tempH={gpuTH} loadH={gpuLH}
                curT={curGpuT != null ? Math.round(curGpuT) : null}
                curL={curGpuU != null ? Math.round(curGpuU) : null}
                minT={gpuMin} maxT={gpuMax} fahrenheit={fahrenheit}
              />
            </div>
          </div>

        </div>{/* end bottom */}
      </div>{/* end body */}
    </div>
  )
}
