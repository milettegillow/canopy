// Converts every PNG in public/foliage to WebP.
// Run with: npm run optimise-images
import { readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const FOLIAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'foliage')
const LONGEST_EDGE = 900
const QUALITY = 82

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`

const files = (await readdir(FOLIAGE)).filter((f) => f.toLowerCase().endsWith('.png')).sort()

if (files.length === 0) {
  console.log('No PNGs in public/foliage — nothing to do.')
  process.exit(0)
}

let before = 0
let after = 0

for (const file of files) {
  const source = path.join(FOLIAGE, file)
  const target = path.join(FOLIAGE, `${path.basename(file, path.extname(file))}.webp`)

  const sourceBytes = (await stat(source)).size

  await sharp(source)
    .resize({
      width: LONGEST_EDGE,
      height: LONGEST_EDGE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: QUALITY, alphaQuality: 100 })
    .toFile(target)

  const targetBytes = (await stat(target)).size
  before += sourceBytes
  after += targetBytes

  const saved = ((1 - targetBytes / sourceBytes) * 100).toFixed(0)
  console.log(`${file.padEnd(14)} ${kb(sourceBytes).padStart(10)} -> ${kb(targetBytes).padStart(9)}  (-${saved}%)`)
}

console.log('')
console.log(`${files.length} files`)
console.log(`before  ${kb(before)}`)
console.log(`after   ${kb(after)}`)
console.log(`saved   ${kb(before - after)} (${((1 - after / before) * 100).toFixed(0)}%)`)

// The PNGs are the source of truth until this point; only the WebP files ship.
for (const file of files) await unlink(path.join(FOLIAGE, file))
console.log(`\nRemoved ${files.length} source PNGs.`)
