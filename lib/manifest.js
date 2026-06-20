'use strict'
const fs = require('node:fs')
const path = require('node:path')

// Resolve each trip's file urls (deltas, raw, …) against the manifest's own
// url, so a manifest may use relative paths for co-located archives. Absolute
// urls are returned unchanged (new URL(abs, base) ignores base). Non-mutating.
function resolveTripUrls(manifest, baseUrl) {
  if (!manifest || !Array.isArray(manifest.trips)) return manifest
  return {
    ...manifest,
    trips: manifest.trips.map(t => {
      if (!t.files) return t
      const files = {}
      for (const [k, f] of Object.entries(t.files)) {
        files[k] = (f && typeof f.url === 'string')
          ? { ...f, url: new URL(f.url, baseUrl).href }
          : f
      }
      return { ...t, files }
    })
  }
}

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
    return { manifest: resolveTripUrls(manifest, url), fromCache: false }
  } catch (err) {
    originalErr = err
    if (fs.existsSync(cacheFile)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
        return { manifest: resolveTripUrls(manifest, url), fromCache: true, error: String(err) }
      } catch (parseErr) {
        // Cache is corrupted; rethrow the original fetch/network error
        throw originalErr
      }
    }
    throw err
  }
}
module.exports = { loadManifest, resolveTripUrls }
