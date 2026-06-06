'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Offline-first manifest loader: network success refreshes the disk cache;
// any failure (network, HTTP status, bad JSON) falls back to the cached copy.
async function loadManifest(url, cacheDir) {
  const cacheFile = path.join(cacheDir, 'manifest.json')
  let originalErr
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const manifest = await res.json()
    fs.mkdirSync(cacheDir, { recursive: true })
    fs.writeFileSync(cacheFile, JSON.stringify(manifest, null, 2))
    return { manifest, fromCache: false }
  } catch (err) {
    originalErr = err
    if (fs.existsSync(cacheFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
        return { manifest, fromCache: true, error: String(err) }
      } catch (parseErr) {
        // Cache is corrupted; rethrow the original fetch/network error
        throw originalErr
      }
    }
    throw err
  }
}
module.exports = { loadManifest }
