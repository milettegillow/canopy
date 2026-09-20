# canopy

Record fifteen seconds of rainforest, and find out what is in it. Tap the button, hold the phone up,
tap again — the clip is converted to 16 kHz mono WAV in the browser, sent to a single serverless
function, and passed to Gemini, which is asked to name every distinct sound it can hear: birds,
mammals, amphibians, insects, and rain, wind or human noise too. Every scientific name that comes
back is then checked against iNaturalist and dropped unless a real species matches it exactly, so an
invented binomial never reaches the screen — if nothing survives, canopy says it could not tell
rather than guessing. What remains is illustrated with a photograph from Wikipedia, taped into the
page like a print in a scrapbook. It is built as plain HTML, CSS and JavaScript with no framework
and no build step, and it is meant to be used one-handed, outdoors, on a phone.

## Setup

canopy needs a Gemini API key. Get one from [Google AI Studio](https://aistudio.google.com/apikey).

Locally, put it in `.env.local` at the repo root (git-ignored):

```
GEMINI_API_KEY=your-key-here
```

For a deployment, add the same variable under the project's Environment Variables in Vercel.

The iNaturalist and Wikipedia lookups are public and need no key.

## Running it locally

```sh
npm install
npx vercel dev
```

Then open http://localhost:3000. `vercel dev` is what serves `/api/identify` — a plain static server
will load the page but every recording will fail, because the function will not be there.

Safari and Chrome both require a secure context for the microphone. `localhost` counts as one; a
bare LAN address like `192.168.1.x` does not, so to test on a phone on the same network, use
`npx vercel dev` together with a tunnel, or just deploy it.

## The foliage

The background leaves live in `public/foliage` as WebP. They started as PNGs; `scripts/optimise-images.js`
resized and converted them, taking the six of them from 2.3 MB to 365 KB, and the PNGs were deleted.
To redo it after dropping new PNGs in that folder:

```sh
npm run optimise-images
```

That script is the only reason `sharp` is a dependency, and it is a dev dependency — nothing at
runtime uses it.

## A note on `vercel.json`

Vercel treats a `public` directory as the output root by default, which would serve the foliage and
nothing else. `vercel.json` pins `outputDirectory` to `.` so the repo root is served and the leaves
stay at `/public/foliage/…`. If the background ever comes up blank on a fresh deploy, that setting
is the first thing to check.

## The model

The Gemini model name is a single constant at the top of `api/identify.js`:

```js
export const MODEL = 'gemini-2.5-flash'
```

Changing that line is the whole swap.
