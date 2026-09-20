// POST { audio: "<base64 WAV>", mimeType: "audio/wav" } -> { detections: [...] }
//
// Gemini listens to the clip, iNaturalist decides whether the species is real,
// Wikipedia supplies a photograph. A detection that fails iNaturalist is dropped;
// a detection without a photograph survives.

export const MODEL = 'gemini-2.5-flash'

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`
const INAT_URL = 'https://api.inaturalist.org/v1/taxa'
const WIKI_URL = 'https://en.wikipedia.org/api/rest_v1/page/summary'

const GEMINI_TIMEOUT_MS = 45000
const LOOKUP_TIMEOUT_MS = 8000
const MAX_AUDIO_BASE64_BYTES = 12 * 1024 * 1024
const IMAGE_WIDTH = 800

const PROMPT = [
  'This recording was made in a lowland rainforest in Costa Rica.',
  'Identify every distinct sound you can hear, not just the loudest one.',
  'Include birds, mammals, amphibians and insects, and also non-animal sounds such as rain, wind,',
  'thunder or human noise, using the appropriate category for each.',
  'Give a scientific name only when you are identifying a specific species; otherwise leave it empty.',
  'Do not pad the list with guesses — if you cannot tell, return fewer detections, or none at all.',
  'Order the detections by how prominent they are in the recording.',
].join(' ')

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      commonName: { type: 'STRING' },
      scientificName: { type: 'STRING' },
      category: { type: 'STRING', enum: ['animal', 'weather', 'human', 'unknown'] },
      soundType: { type: 'STRING' },
      confidence: { type: 'STRING', enum: ['confident', 'likely', 'possible'] },
      note: { type: 'STRING' },
    },
    required: ['commonName', 'scientificName', 'category', 'soundType', 'confidence', 'note'],
    propertyOrdering: ['commonName', 'scientificName', 'category', 'soundType', 'confidence', 'note'],
  },
}

// Categories that are not organisms and so cannot be checked against iNaturalist.
const UNCHECKED_CATEGORIES = new Set(['weather', 'human', 'unknown'])

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Use POST.' })
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('GEMINI_API_KEY is not set.')
    return res.status(500).json({ error: 'The server is missing its API key.' })
  }

  let body
  try {
    body = await readJsonBody(req)
  } catch (err) {
    console.error('Could not parse request body:', err)
    return res.status(400).json({ error: 'That request was not readable.' })
  }

  const audio = body?.audio
  const mimeType = body?.mimeType || 'audio/wav'

  if (typeof audio !== 'string' || audio.length === 0) {
    return res.status(400).json({ error: 'No audio was sent.' })
  }
  if (audio.length > MAX_AUDIO_BASE64_BYTES) {
    return res.status(413).json({ error: 'That clip is too long.' })
  }

  let detections
  try {
    detections = await askGemini(audio, mimeType)
  } catch (err) {
    console.error('Gemini step failed:', err)
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 502
    return res.status(status).json({
      error: err.clientMessage || 'The listener could not be reached.',
    })
  }

  if (!Array.isArray(detections) || detections.length === 0) {
    return res.status(200).json({ detections: [] })
  }

  let validated
  try {
    validated = await Promise.all(detections.map(validate))
  } catch (err) {
    console.error('Validation step failed:', err)
    return res.status(502).json({ error: 'Species names could not be checked.' })
  }

  const surviving = validated.filter(Boolean)

  let enriched
  try {
    enriched = await Promise.all(surviving.map(addPhoto))
  } catch (err) {
    // A photo is never worth failing the request over.
    console.error('Photo step failed, returning detections without photos:', err)
    enriched = surviving
  }

  return res.status(200).json({ detections: enriched })
}

// --- A. Gemini -------------------------------------------------------------

async function askGemini(audioBase64, mimeType) {
  const response = await fetchWithTimeout(
    GEMINI_URL,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: PROMPT },
              { inline_data: { mime_type: mimeType, data: audioBase64 } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          response_mime_type: 'application/json',
          response_schema: RESPONSE_SCHEMA,
        },
      }),
    },
    GEMINI_TIMEOUT_MS,
  )

  if (!response.ok) {
    const raw = await response.text()
    console.error(`Gemini returned ${response.status} ${response.statusText}. Full body:\n${raw}`)
    const err = new Error(`Gemini ${response.status}`)
    err.status = response.status === 429 ? 429 : 502
    err.clientMessage =
      response.status === 429
        ? 'The listener is busy right now.'
        : 'The listener could not make sense of that clip.'
    throw err
  }

  const payload = await response.json()

  const blocked = payload?.promptFeedback?.blockReason
  if (blocked) {
    console.error('Gemini blocked the prompt:', JSON.stringify(payload.promptFeedback))
    const err = new Error('blocked')
    err.status = 502
    err.clientMessage = 'That clip could not be processed.'
    throw err
  }

  const text = (payload?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text)
    .filter(Boolean)
    .join('')

  if (!text.trim()) {
    console.error('Gemini returned no text. Full body:\n', JSON.stringify(payload))
    return []
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    console.error('Gemini returned unparseable JSON:\n', text)
    const wrapped = new Error('bad json')
    wrapped.status = 502
    wrapped.clientMessage = 'The listener returned something unreadable.'
    throw wrapped
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.detections) ? parsed.detections : []

  return list.map(normalise).filter((d) => d.commonName)
}

function normalise(raw) {
  const category = ['animal', 'weather', 'human', 'unknown'].includes(raw?.category)
    ? raw.category
    : 'unknown'
  const confidence = ['confident', 'likely', 'possible'].includes(raw?.confidence)
    ? raw.confidence
    : 'possible'

  return {
    commonName: str(raw?.commonName),
    scientificName: str(raw?.scientificName),
    category,
    soundType: str(raw?.soundType),
    confidence,
    note: str(raw?.note),
  }
}

const str = (value) => (typeof value === 'string' ? value.trim() : '')

// --- B. iNaturalist --------------------------------------------------------

// Resolves to the detection (enriched with taxon data) if it is real, or null if it is not.
async function validate(detection) {
  if (!detection.scientificName) {
    // Rain is not in iNaturalist, and neither is an unidentified rustle.
    return UNCHECKED_CATEGORIES.has(detection.category) ? detection : null
  }

  const query = encodeURIComponent(detection.scientificName)
  const url = `${INAT_URL}?q=${query}&rank=species,subspecies&per_page=5`

  let results
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, LOOKUP_TIMEOUT_MS)
    if (!response.ok) {
      console.error(`iNaturalist returned ${response.status} for "${detection.scientificName}".`)
      return null
    }
    const payload = await response.json()
    results = Array.isArray(payload?.results) ? payload.results : []
  } catch (err) {
    console.error(`iNaturalist lookup failed for "${detection.scientificName}":`, err)
    return null
  }

  const wanted = detection.scientificName.trim().toLowerCase()
  // Exact binomial only. A genus match or a near miss is an invented name.
  const taxon = results.find((t) => typeof t?.name === 'string' && t.name.trim().toLowerCase() === wanted)

  if (!taxon) {
    console.log(`Dropped "${detection.commonName}" — iNaturalist has no species named "${detection.scientificName}".`)
    return null
  }

  return {
    ...detection,
    taxonId: taxon.id,
    inatCommonName: str(taxon.preferred_common_name),
  }
}

// --- C. Wikipedia ----------------------------------------------------------

async function addPhoto(detection) {
  if (!detection.scientificName) return detection

  const summary =
    (await wikipediaSummary(detection.scientificName)) ||
    (detection.commonName ? await wikipediaSummary(detection.commonName) : null)

  if (!summary) return detection

  const image = summary.title ? (await largerImage(summary.title)) || summary.image : summary.image

  return {
    ...detection,
    image,
    imageAlt: detection.commonName || detection.scientificName,
    wikipediaUrl: summary.page,
  }
}

async function wikipediaSummary(title) {
  const url = `${WIKI_URL}/${encodeURIComponent(title.replace(/\s+/g, ' ').trim())}`

  let payload
  try {
    const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, LOOKUP_TIMEOUT_MS)
    if (response.status === 404) return null
    if (!response.ok) {
      console.error(`Wikipedia returned ${response.status} for "${title}".`)
      return null
    }
    payload = await response.json()
  } catch (err) {
    console.error(`Wikipedia lookup failed for "${title}":`, err)
    return null
  }

  if (payload?.type === 'disambiguation') return null

  const page = payload?.content_urls?.desktop?.page || null
  const image = payload?.thumbnail?.source || null

  if (!page && !image) return null
  return { page, image, title: str(payload?.titles?.canonical) || str(payload?.title) }
}

// The summary endpoint hands back a ~320px thumbnail, which is soft on a retina phone.
// Editing the width in that URL by hand fails — Wikimedia only serves widths it has
// already rendered — so ask the API for a wider one and let it pick a size it has.
async function largerImage(title) {
  const url =
    'https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2' +
    `&prop=pageimages&piprop=thumbnail&pithumbsize=${IMAGE_WIDTH}&redirects=1&titles=${encodeURIComponent(title)}`

  try {
    const response = await fetchWithTimeout(url, { headers: { accept: 'application/json' } }, LOOKUP_TIMEOUT_MS)
    if (!response.ok) return null
    const payload = await response.json()
    return payload?.query?.pages?.[0]?.thumbnail?.source || null
  } catch (err) {
    console.error(`Wikipedia image lookup failed for "${title}":`, err)
    return null
  }
}

// --- plumbing --------------------------------------------------------------

async function fetchWithTimeout(url, options = {}, timeoutMs = LOOKUP_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'user-agent': 'canopy/1.0 (rainforest sound identification)', ...(options.headers || {}) },
    })
  } finally {
    clearTimeout(timer)
  }
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body
  if (typeof req.body === 'string') return JSON.parse(req.body)

  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}
