// canopy — record a clip, convert it to WAV, ask the server what is in it.

const MAX_SECONDS = 15
const TARGET_RATE = 16000
const ORB_BAR_HEIGHTS = [34, 70, 100, 52, 100, 70, 34]
const METER_BARS = 15
const NUMBERS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']

const el = {
  stage: document.getElementById('stage'),
  orb: document.getElementById('orb'),
  orbBars: document.getElementById('orbBars'),
  orbLabel: document.getElementById('orbLabel'),
  meter: document.getElementById('meter'),
  thinking: document.getElementById('thinking'),
  results: document.getElementById('results'),
  resultsHeading: document.getElementById('resultsHeading'),
  cards: document.getElementById('cards'),
  empty: document.getElementById('empty'),
  failure: document.getElementById('failure'),
  failureLine: document.getElementById('failureLine'),
  footpath: document.querySelector('.footpath'),
  uploadLink: document.getElementById('uploadLink'),
  fileInput: document.getElementById('fileInput'),
}

let audioCtx = null
let recorder = null
let stream = null
let analyser = null
let meterFrame = 0
let tick = 0
let cap = 0
let chunks = []
let startedAt = 0
let meterBars = []
let starting = false

// --- views ---------------------------------------------------------------

function show(view) {
  const onStage = view === 'idle' || view === 'listening' || view === 'blocked'
  el.stage.hidden = !onStage
  el.thinking.hidden = view !== 'thinking'
  el.results.hidden = view !== 'results'
  el.empty.hidden = view !== 'empty'
  el.failure.hidden = view !== 'error'
  // With the microphone blocked, uploading is the only way in — keep the link.
  el.footpath.classList.toggle('is-hidden', !(view === 'idle' || view === 'listening' || view === 'blocked'))

  el.orb.classList.toggle('is-live', view === 'listening')
  el.meter.classList.toggle('is-live', view === 'listening')
  el.orb.setAttribute('aria-label', view === 'listening' ? 'Stop' : 'Tap to listen')

  if (view === 'idle') {
    el.orbLabel.textContent = 'Tap to listen'
    el.orb.disabled = false
  }
  if (view === 'listening') el.orb.disabled = false
}

function toIdle() {
  el.cards.replaceChildren()
  show('idle')
}

function toError(message) {
  el.failureLine.textContent = message || "That didn't go through."
  show('error')
}

// No microphone: the button is replaced, and the line says where to fix it.
function toBlocked() {
  el.orb.remove()
  el.stage.querySelector('.stage-foot')?.remove()
  const line = document.createElement('p')
  line.className = 'blocked'
  line.textContent = 'The microphone is blocked. Safari settings control it.'
  el.stage.append(line)
  show('blocked')
}

// --- recording -----------------------------------------------------------

function context() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    audioCtx = new Ctor()
  }
  if (audioCtx.state === 'suspended') audioCtx.resume()
  return audioCtx
}

async function start() {
  if (starting) return
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toBlocked()
    return
  }

  // Granting permission can take a moment; a second tap must not open a second stream.
  starting = true
  el.orb.disabled = true
  try {
    // Echo cancellation, noise suppression and gain control are tuned for speech
    // and will gate out quiet insects and distant calls. Ask for the raw input.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
  } catch (err) {
    console.error('Microphone unavailable:', err)
    toBlocked()
    return
  } finally {
    starting = false
    el.orb.disabled = false
  }

  const ctx = context()
  analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.7
  ctx.createMediaStreamSource(stream).connect(analyser)

  chunks = []
  recorder = new MediaRecorder(stream)
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size) chunks.push(event.data)
  }
  recorder.onstop = finish
  recorder.start()

  startedAt = Date.now()
  show('listening')
  el.orbLabel.textContent = '0s'
  tick = setInterval(() => {
    const seconds = Math.min(MAX_SECONDS, Math.floor((Date.now() - startedAt) / 1000))
    el.orbLabel.textContent = `${seconds}s`
  }, 200)
  cap = setTimeout(stop, MAX_SECONDS * 1000)
  runMeter()
}

function stop() {
  if (recorder && recorder.state === 'recording') recorder.stop()
}

function finish() {
  clearInterval(tick)
  clearTimeout(cap)
  cancelAnimationFrame(meterFrame)
  restMeter()

  stream?.getTracks().forEach((track) => track.stop())
  stream = null
  analyser = null
  recorder = null

  const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' })
  chunks = []

  if (!blob.size) {
    toError('That recording came out empty.')
    return
  }
  handle(blob)
}

async function handle(blob) {
  show('thinking')
  try {
    const wav = await toWav(blob)
    render(await identify(wav))
  } catch (err) {
    console.error(err)
    toError(err.message)
  }
}

// --- the level meter -----------------------------------------------------

function buildBars() {
  el.orbBars.replaceChildren(
    ...ORB_BAR_HEIGHTS.map((height) => {
      const bar = document.createElement('i')
      bar.style.setProperty('--h', `${height}%`)
      return bar
    }),
  )
  meterBars = Array.from({ length: METER_BARS }, () => document.createElement('i'))
  el.meter.replaceChildren(...meterBars)
}

function runMeter() {
  const bins = new Uint8Array(analyser.frequencyBinCount)
  // Bars are spaced logarithmically: most of a forest sits low, so an even
  // split would leave the right-hand half of the meter permanently flat.
  const top = Math.min(bins.length - 1, 64)
  const edges = Array.from({ length: METER_BARS + 1 }, (_, i) =>
    Math.max(1, Math.round(top ** (i / METER_BARS))),
  )

  const frame = () => {
    if (!analyser) return
    analyser.getByteFrequencyData(bins)
    for (let i = 0; i < METER_BARS; i++) {
      const from = edges[i]
      const to = Math.max(from + 1, edges[i + 1])
      let sum = 0
      for (let bin = from; bin < to; bin++) sum += bins[bin]
      const level = sum / (to - from) / 255
      meterBars[i].style.transform = `scaleY(${(0.08 + level * 1.5).toFixed(3)})`
    }
    meterFrame = requestAnimationFrame(frame)
  }

  meterFrame = requestAnimationFrame(frame)
}

function restMeter() {
  meterBars.forEach((bar) => { bar.style.transform = 'scaleY(0.08)' })
}

// --- audio: anything in, 16 kHz mono WAV out -----------------------------

async function toWav(blob) {
  const bytes = await blob.arrayBuffer()

  let decoded
  try {
    decoded = await decode(context(), bytes)
  } catch (err) {
    console.error('Could not decode the audio:', err)
    throw new Error('That audio could not be read.')
  }

  const mono = downmix(decoded)
  // Longer than the cap? Take the first fifteen seconds rather than refuse it.
  const capped = mono.subarray(0, Math.min(mono.length, Math.floor(decoded.sampleRate * MAX_SECONDS)))
  const samples = resample(capped, decoded.sampleRate, TARGET_RATE)

  if (!samples.length) throw new Error('That clip had no audio in it.')
  return encodeWav(samples, TARGET_RATE)
}

// Safari has had both the promise and the callback form; accept either.
function decode(ctx, bytes) {
  return new Promise((resolve, reject) => {
    const maybe = ctx.decodeAudioData(bytes, resolve, reject)
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject)
  })
}

function downmix(buffer) {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0)

  const out = new Float32Array(buffer.length)
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c)
    for (let i = 0; i < channel.length; i++) out[i] += channel[i]
  }
  for (let i = 0; i < out.length; i++) out[i] /= buffer.numberOfChannels
  return out
}

function resample(input, from, to) {
  if (from === to) return Float32Array.from(input)

  const ratio = from / to

  if (ratio < 1) {
    // Upsampling: interpolate between neighbours.
    const length = Math.floor(input.length / ratio)
    const out = new Float32Array(length)
    for (let i = 0; i < length; i++) {
      const position = i * ratio
      const low = Math.floor(position)
      const high = Math.min(input.length - 1, low + 1)
      const fraction = position - low
      out[i] = input[low] * (1 - fraction) + input[high] * fraction
    }
    return out
  }

  // Downsampling: average each window, which also takes the edge off aliasing.
  const length = Math.floor(input.length / ratio)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = end > start ? sum / (end - start) : 0
  }
  return out
}

// 44-byte RIFF header, then 16-bit little-endian PCM.
function encodeWav(samples, rate) {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)          // chunk size
  view.setUint16(20, 1, true)           // PCM
  view.setUint16(22, 1, true)           // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)    // byte rate
  view.setUint16(32, 2, true)           // block align
  view.setUint16(34, 16, true)          // bits per sample
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }

  return buffer
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// --- the server ----------------------------------------------------------

async function identify(wav) {
  let response
  try {
    response = await fetch('/api/identify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: toBase64(wav), mimeType: 'audio/wav' }),
    })
  } catch (err) {
    console.error('Request failed:', err)
    throw new Error('No connection.')
  }

  let payload = null
  try {
    payload = await response.json()
  } catch (err) {
    console.error('Response was not JSON:', err)
  }

  if (!response.ok) throw new Error(payload?.error || "That didn't go through.")

  // Only a 200 carrying a real array may go on to the nothing-found state. A broken
  // body is a failed request, and saying "nothing could be identified" would be a
  // claim about the recording that nothing here supports.
  if (!Array.isArray(payload?.detections)) {
    console.error('A 200 response had no detections array:', payload)
    throw new Error("That didn't go through.")
  }

  return payload.detections
}

// --- results -------------------------------------------------------------

function render(detections) {
  if (!detections.length) {
    show('empty')
    return
  }

  const count = detections.length
  el.resultsHeading.textContent = `${NUMBERS[count] ?? count} ${count === 1 ? 'sound' : 'sounds'}`
  el.cards.replaceChildren(...detections.map(card))
  show('results')
  window.scrollTo(0, 0)
}

function card(detection) {
  const article = document.createElement('article')
  article.className = 'card'

  const photo = https(detection.image)
  if (photo) article.append(plate(detection, photo))

  const name = document.createElement('h2')
  name.className = 'card-name'
  name.textContent = detection.commonName
  article.append(name)

  if (detection.scientificName) {
    const sci = document.createElement('p')
    sci.className = 'card-sci'
    sci.textContent = detection.scientificName
    article.append(sci)
  }

  const pills = document.createElement('div')
  pills.className = 'pills'
  pills.append(pill(capitalise(detection.confidence), `pill-${detection.confidence}`))
  if (detection.soundType) pills.append(pill(detection.soundType, 'pill-sound'))
  article.append(pills)

  if (detection.note) {
    const note = document.createElement('p')
    note.className = 'card-note'
    note.textContent = detection.note
    article.append(note)
  }

  return article
}

function plate(detection, photo) {
  const figure = document.createElement('figure')
  figure.className = 'plate'

  const print = document.createElement('div')
  print.className = 'print'

  const img = document.createElement('img')
  img.src = photo
  img.alt = detection.imageAlt || detection.commonName || ''
  img.loading = 'lazy'
  img.decoding = 'async'
  // A photograph that fails to load takes the whole print with it.
  img.addEventListener('error', () => figure.remove())
  print.append(img)
  figure.append(print)

  const caption = document.createElement('figcaption')
  caption.className = 'plate-caption'

  if (detection.scientificName) {
    const sci = document.createElement('em')
    sci.textContent = detection.scientificName
    caption.append(sci)
  }

  const page = https(detection.wikipediaUrl)
  if (page) {
    const link = document.createElement('a')
    link.href = page
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = 'Wikipedia'
    caption.append(link)
  }

  if (caption.childNodes.length) figure.append(caption)
  return figure
}

function pill(text, variant) {
  const span = document.createElement('span')
  span.className = `pill ${variant}`
  span.textContent = text
  return span
}

const capitalise = (word = '') => word.charAt(0).toUpperCase() + word.slice(1)

// Everything rendered here came from a model, so nothing but https gets through.
function https(value) {
  if (typeof value !== 'string') return null
  try {
    return new URL(value).protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

// --- wiring --------------------------------------------------------------

el.orb.addEventListener('click', () => {
  if (recorder && recorder.state === 'recording') stop()
  else start()
})

el.uploadLink.addEventListener('click', () => el.fileInput.click())

el.fileInput.addEventListener('change', () => {
  const file = el.fileInput.files?.[0]
  el.fileInput.value = ''
  if (file) handle(file)
})

document.getElementById('againResults').addEventListener('click', toIdle)
document.getElementById('againEmpty').addEventListener('click', toIdle)
document.getElementById('againError').addEventListener('click', toIdle)

buildBars()
restMeter()
show('idle')
