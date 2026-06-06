'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { Transform, Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

function fileSha256 (p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

// Download `file` ({url, sha256, bytes}) into cacheDir with verification.
// Cache hit (existing file with matching sha) skips the network entirely.
// Retries ANY failure (network error or checksum mismatch) once; cleans up
// partial/bad files before each retry and after final failure.
async function fetchArchive (file, cacheDir, onProgress) {
  fs.mkdirSync(cacheDir, { recursive: true })
  const dest = path.join(cacheDir, path.basename(new URL(file.url).pathname))
  if (fs.existsSync(dest) && fileSha256(dest) === file.sha256) return dest
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await downloadTo(file.url, dest, file.bytes, onProgress)
    } catch (err) {
      fs.rmSync(dest, { force: true })
      lastErr = err
      continue
    }
    if (fileSha256(dest) === file.sha256) return dest
    fs.rmSync(dest, { force: true })
    lastErr = new Error(`checksum mismatch after retry: ${file.url}`)
  }
  throw lastErr || new Error(`download failed after retry: ${file.url}`)
}

async function downloadTo (url, dest, totalBytes, onProgress) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  let got = 0
  const counter = new Transform({
    transform (chunk, enc, cb) {
      got += chunk.length
      if (onProgress && totalBytes) onProgress(Math.min(100, Math.round(100 * got / totalBytes)))
      cb(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(dest))
}

module.exports = { fetchArchive, fileSha256 }
