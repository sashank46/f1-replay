// ── Metadata saved by index.html ─────────────────────────────────────────────
const meta        = JSON.parse(sessionStorage.getItem('replayMeta') || '{}')
const key         = sessionStorage.getItem('replayKey') || ''
const colors      = meta.driver_colors  || {}
const info        = meta.session_info   || {}
const statuses    = meta.track_statuses || []
const totalFrames = meta.total_frames   || 0
const trackMap    = meta.track_map      || null  // real GPS track from FastF1

// ── Fill top banner ───────────────────────────────────────────────────────────
document.getElementById('banner-event').textContent =
  `${info.event_name || 'F1 Replay'} | ${info.country || ''}`
document.getElementById('banner-round').textContent =
  `${info.year} Round ${info.round}`
document.getElementById('banner-laps').textContent =
  `${info.total_laps || '--'} Laps`

// ── Canvas setup ──────────────────────────────────────────────────────────────
const canvas = document.getElementById('track-canvas')
const ctx    = canvas.getContext('2d')

function resizeCanvas() {
  const wrap    = document.getElementById('canvas-wrap')
  canvas.width  = wrap.clientWidth
  canvas.height = wrap.clientHeight
}
resizeCanvas()
window.addEventListener('resize', () => { resizeCanvas(); computeBounds(); redraw() })

// ── Compute track bounds once from the real track map ─────────────────────────
let minX = 0, maxX = 1, minY = 0, maxY = 1

function computeBounds() {
  if (!trackMap) return
  minX = Math.min(...trackMap.x)
  maxX = Math.max(...trackMap.x)
  minY = Math.min(...trackMap.y)
  maxY = Math.max(...trackMap.y)
}
computeBounds()

// ── Convert FastF1 metres → canvas pixels ────────────────────────────────────
// FastF1 Y increases upward, canvas Y increases downward — so we flip Y
function toCanvas(x, y) {
  const pad    = 60
  const W      = canvas.width  - pad * 2
  const H      = canvas.height - pad * 2
  const rangeX = (maxX - minX) || 1
  const rangeY = (maxY - minY) || 1
  const scale  = Math.min(W / rangeX, H / rangeY)
  return {
    x: pad + (W - rangeX * scale) / 2 + (x - minX) * scale,
    y: pad + (H - rangeY * scale) / 2 + (maxY - y) * scale,
  }
}

// ── Playback state ────────────────────────────────────────────────────────────
let frames      = []
let currentIdx  = 0
let paused      = false
let speed       = 1.0
let showDRS     = true
let showLabels  = true

// Smooth animation timing
let animHandle    = null
let lastTimestamp = null
let accumTime     = 0
const DT          = 1 / 25   // 0.04s per frame at 1x speed

// ── WebSocket — receive and buffer all frames ─────────────────────────────────
showLoading('Loading race data... 0%')

// Fetch all frames at once over HTTP
fetch(`/api/frames/${key}`)
  .then(r => r.json())
  .then(data => {
    frames = data.frames
    hideLoading()
    startAnimation()
  })
  .catch(() => showLoading('Failed to load — is the server running?'))

// WebSocket only for controls (pause, speed, seek)
const ws = new WebSocket(`ws://localhost:8000/ws/replay/${key}`)
ws.onerror = () => console.log('WS control channel error')

// ── Send control messages to server ──────────────────────────────────────────
function sendAction(action, value) {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ action, value }))
}

// ── Animation loop (runs at monitor refresh rate ~60fps) ──────────────────────
function startAnimation() {
  lastTimestamp = null
  accumTime     = 0
  animHandle    = requestAnimationFrame(loop)
}

function loop(ts) {
  animHandle = requestAnimationFrame(loop)

  if (!lastTimestamp) { lastTimestamp = ts; return }

  const delta   = (ts - lastTimestamp) / 1000  // real seconds since last frame
  lastTimestamp = ts

  if (!paused && frames.length > 0) {
    accumTime += delta * speed
    // Advance race frames based on elapsed time
    while (accumTime >= DT && currentIdx < frames.length - 1) {
      currentIdx++
      accumTime -= DT
    }
  }

  redraw()
  updateHUD()
  updateLeaderboard()
  updateProgressBar()
}

// ── Draw everything ───────────────────────────────────────────────────────────
function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  drawTrack()
  if (frames.length > 0) {
    if (showDRS)    drawDRSZones(frames[currentIdx])
    drawDrivers(frames[currentIdx])
  }
}

// ── Draw track using real FastF1 GPS coordinates ──────────────────────────────
function drawTrack() {
  if (!trackMap || trackMap.x.length < 2) return

  const xs = trackMap.x
  const ys = trackMap.y

  // Thick orange outer edge
  ctx.beginPath()
  let p = toCanvas(xs[0], ys[0])
  ctx.moveTo(p.x, p.y)
  for (let i = 1; i < xs.length; i++) {
    p = toCanvas(xs[i], ys[i])
    ctx.lineTo(p.x, p.y)
  }
  ctx.closePath()
  ctx.strokeStyle = '#e87c1e'
  ctx.lineWidth   = 16
  ctx.lineJoin    = 'round'
  ctx.lineCap     = 'round'
  ctx.stroke()

  // Dark inner cutout — creates the track width illusion
  ctx.beginPath()
  p = toCanvas(xs[0], ys[0])
  ctx.moveTo(p.x, p.y)
  for (let i = 1; i < xs.length; i++) {
    p = toCanvas(xs[i], ys[i])
    ctx.lineTo(p.x, p.y)
  }
  ctx.closePath()
  ctx.strokeStyle = '#0d0d0d'
  ctx.lineWidth   = 8
  ctx.stroke()

  // Start/finish line
  drawStartLine(xs[0], ys[0], xs[1], ys[1])
}

function drawStartLine(x0, y0, x1, y1) {
  const p0  = toCanvas(x0, y0)
  const p1  = toCanvas(x1, y1)
  const ang = Math.atan2(p1.y - p0.y, p1.x - p0.x) + Math.PI / 2
  ctx.save()
  ctx.translate(p0.x, p0.y)
  ctx.rotate(ang)
  for (let i = -3; i <= 3; i++) {
    ctx.fillStyle = i % 2 === 0 ? '#ffffff' : '#111111'
    ctx.fillRect(i * 4 - 2, -10, 4, 20)
  }
  ctx.restore()
}

// ── Draw DRS zones (green ring around drivers with DRS open) ──────────────────
function drawDRSZones(frame) {
  if (!frame || !frame.drivers) return
  Object.values(frame.drivers).forEach(d => {
    if (d.drs < 10) return
    const p = toCanvas(d.x, d.y)
    // Outer glow
    ctx.beginPath()
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(0, 230, 118, 0.15)'
    ctx.fill()
    // Green ring
    ctx.beginPath()
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2)
    ctx.strokeStyle = '#00e676'
    ctx.lineWidth   = 2
    ctx.stroke()
  })
}

// ── Draw driver dots + name labels + speed ────────────────────────────────────
function drawDrivers(frame) {
  if (!frame || !frame.drivers) return

  Object.entries(frame.drivers).forEach(([code, d]) => {
    const p   = toCanvas(d.x, d.y)
    const rgb = colors[code] || [200, 200, 200]
    const col = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`

    // Colored dot
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2)
    ctx.fillStyle   = col
    ctx.fill()
    ctx.strokeStyle = '#000000'
    ctx.lineWidth   = 1.5
    ctx.stroke()

    if (!showLabels) return

    // Driver name (e.g. HAM, VER)
    ctx.font      = 'bold 10px monospace'
    ctx.fillStyle = col
    ctx.fillText(code, p.x + 8, p.y + 3)

    // Speed below name
    ctx.font      = '9px monospace'
    ctx.fillStyle = '#888888'
    ctx.fillText(`${Math.round(d.spd)} km/h`, p.x + 8, p.y + 14)
  })
}

// ── Update HUD (lap, time, safety car, weather) ───────────────────────────────
function updateHUD() {
  if (!frames.length) return
  const frame = frames[currentIdx]

  // Lap counter
  document.getElementById('lap-display').textContent =
    `Lap: ${frame.lap || '--'} / ${info.total_laps || '--'}`

  // Race clock
  document.getElementById('time-display').textContent =
    `Race Time: ${formatTime(frame.t)} (${speed}x)`

  // Safety car / VSC / red flag
  const s  = getTrackStatus(frame.t)
  const el = document.getElementById('status-banner')
  if      (s === '4') { el.textContent = '⚑ SAFETY CAR';         el.style.color = '#f5c518' }
  else if (s === '6') { el.textContent = '⚑ VIRTUAL SAFETY CAR'; el.style.color = '#f5c518' }
  else if (s === '5') { el.textContent = '⛔ RED FLAG';           el.style.color = '#e8402a' }
  else                { el.textContent = '' }

  // Weather panel
  if (frame.weather) {
    const w = frame.weather
    document.getElementById('weather').innerHTML = `
      <b style="color:#aaa">Weather</b><br>
      Track: ${w.track_temp ?? '--'}°C<br>
      Air: ${w.air_temp ?? '--'}°C<br>
      Humidity: ${w.humidity ?? '--'}%<br>
      Wind: ${w.wind_speed ?? '--'} km/h<br>
      Rain: ${w.rain ?? '--'}
    `
  }
}

// ── Track status (safety car etc.) ───────────────────────────────────────────
function getTrackStatus(t) {
  for (const s of statuses) {
    if (t >= s.start && (s.end === null || t < s.end)) return s.status
  }
  return '1'   // 1 = green flag
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
const TYRE = {
  0: { bg: '#e8402a', fg: '#fff', label: 'S' },
  1: { bg: '#f5c518', fg: '#000', label: 'M' },
  2: { bg: '#eeeeee', fg: '#000', label: 'H' },
  3: { bg: '#39b54a', fg: '#fff', label: 'I' },
  4: { bg: '#0077ff', fg: '#fff', label: 'W' },
}

function updateLeaderboard() {
  if (!frames.length) return
  const frame = frames[currentIdx]
  if (!frame.drivers) return

  const sorted = Object.entries(frame.drivers)
    .sort(([, a], [, b]) => a.pos - b.pos)

  const container = document.getElementById('lb-rows')
  container.innerHTML = ''

  sorted.forEach(([code, d]) => {
    const rgb  = colors[code] || [200, 200, 200]
    const col  = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`
    const tyre = TYRE[d.tyre] || TYRE[0]
    const row  = document.createElement('div')
    row.className = 'lb-row'
    row.innerHTML = `
      <span class="lb-pos">${d.pos}</span>
      <span class="lb-dot" style="background:${col}"></span>
      <span class="lb-name" style="color:${col}">${code}</span>
      <span class="lb-tyre" style="background:${tyre.bg};color:${tyre.fg}">${tyre.label}</span>
    `
    container.appendChild(row)
  })
}

// ── Progress bar ──────────────────────────────────────────────────────────────
function updateProgressBar() {
  if (!frames.length) return
  document.getElementById('progress-bar').style.width =
    `${(currentIdx / frames.length) * 100}%`
}

function seekTo(e) {
  const rect = document.getElementById('progress-wrap').getBoundingClientRect()
  const pct  = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  currentIdx = Math.floor(pct * (frames.length - 1))
  sendAction('seek', pct)
}

// ── Speed buttons ─────────────────────────────────────────────────────────────
function setSpeed(s) {
  speed = s
  sendAction('speed', s)
  document.querySelectorAll('.spd-btn').forEach(b => {
    b.classList.toggle('active', parseFloat(b.textContent) === s)
  })
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.code === 'Space')     { e.preventDefault(); paused = !paused; sendAction(paused ? 'pause' : 'resume') }
  if (e.key === 'ArrowRight') { currentIdx = Math.min(currentIdx + 500, frames.length - 1) }
  if (e.key === 'ArrowLeft')  { currentIdx = Math.max(currentIdx - 500, 0) }
  if (e.key === 'ArrowUp')    setSpeed(Math.min(speed * 2, 256))
  if (e.key === 'ArrowDown')  setSpeed(Math.max(speed / 2, 0.5))
  if (e.key === 'r' || e.key === 'R') { currentIdx = 0; paused = false; sendAction('restart') }
  if (e.key === 'd' || e.key === 'D') { showDRS    = !showDRS;    redraw() }
  if (e.key === 'l' || e.key === 'L') { showLabels = !showLabels; redraw() }
})

// ── Loading overlay ───────────────────────────────────────────────────────────
function showLoading(msg) {
  let el = document.getElementById('loading-overlay')
  if (!el) {
    el = document.createElement('div')
    el.id = 'loading-overlay'
    el.style.cssText = `
      position: absolute; inset: 0;
      background: rgba(13,13,13,0.93);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      gap: 16px; z-index: 100;
    `
    document.getElementById('canvas-wrap').appendChild(el)
  }
  el.innerHTML = `
    <div style="width:40px;height:40px;border:3px solid #e8402a;
      border-top-color:transparent;border-radius:50%;
      animation:spin 0.7s linear infinite"></div>
    <div style="color:#aaa;font-size:13px;font-family:monospace;
      letter-spacing:1px">${msg}</div>
    <style>@keyframes spin { to { transform: rotate(360deg) } }</style>
  `
}

function hideLoading() {
  document.getElementById('loading-overlay')?.remove()
}

// ── Time formatter ────────────────────────────────────────────────────────────
function formatTime(s) {
  const h  = Math.floor(s / 3600)
  const m  = Math.floor((s % 3600) / 60)
  const ss = Math.floor(s % 60)
  return `${h}:${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
}
