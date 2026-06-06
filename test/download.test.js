'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const { fetchArchive, fileSha256 } = require('../lib/download')

const FIXED_BYTES = Buffer.from('hello archive')
const FIXED_SHA = crypto.createHash('sha256').update(FIXED_BYTES).digest('hex')

function makeTmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'))
}

function startServer (handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve(server)
    })
  })
}

function serverUrl (server, pathname = '/archive.bin') {
  const { port } = server.address()
  return `http://127.0.0.1:${port}${pathname}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: happy path
// ─────────────────────────────────────────────────────────────────────────────
test('happy path: downloads file, verifies sha, reports 100% progress', async () => {
  let requests = 0
  const server = await startServer((_req, res) => {
    requests++
    res.writeHead(200)
    res.end(FIXED_BYTES)
  })

  const cacheDir = makeTmpDir()
  const progressValues = []

  try {
    const dest = await fetchArchive(
      { url: serverUrl(server), sha256: FIXED_SHA, bytes: FIXED_BYTES.length },
      cacheDir,
      (pct) => progressValues.push(pct)
    )

    assert.ok(dest.startsWith(cacheDir), 'dest is inside cacheDir')
    assert.ok(fs.existsSync(dest), 'file exists')
    assert.deepEqual(fs.readFileSync(dest), FIXED_BYTES, 'content matches')
    assert.ok(progressValues.length > 0, 'progress callback called at least once')
    assert.equal(progressValues[progressValues.length - 1], 100, 'last progress value is 100')
    assert.equal(requests, 1, 'exactly one request made')
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: cache hit — second call makes zero network requests
// ─────────────────────────────────────────────────────────────────────────────
test('cache hit: second call skips the network entirely', async () => {
  let requests = 0
  const server = await startServer((_req, res) => {
    requests++
    res.writeHead(200)
    res.end(FIXED_BYTES)
  })

  const cacheDir = makeTmpDir()

  try {
    const file = { url: serverUrl(server), sha256: FIXED_SHA, bytes: FIXED_BYTES.length }

    const dest1 = await fetchArchive(file, cacheDir)
    assert.equal(requests, 1, 'first call makes one request')

    const dest2 = await fetchArchive(file, cacheDir)
    assert.equal(requests, 1, 'second call makes ZERO requests (cache hit)')
    assert.equal(dest1, dest2, 'both calls return the same path')
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: corrupted-once — bad bytes on attempt 1, good bytes on attempt 2
// ─────────────────────────────────────────────────────────────────────────────
test('corrupted-once: retries once and succeeds when second attempt is correct', async () => {
  let requests = 0
  const server = await startServer((_req, res) => {
    requests++
    res.writeHead(200)
    // First request returns wrong bytes; second returns correct bytes
    res.end(requests === 1 ? Buffer.from('wrong bytes!!') : FIXED_BYTES)
  })

  const cacheDir = makeTmpDir()

  try {
    const dest = await fetchArchive(
      { url: serverUrl(server), sha256: FIXED_SHA, bytes: FIXED_BYTES.length },
      cacheDir
    )

    assert.ok(fs.existsSync(dest), 'file exists after retry')
    assert.deepEqual(fs.readFileSync(dest), FIXED_BYTES, 'final file has correct content')
    assert.equal(requests, 2, 'exactly 2 requests were made')
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: always-wrong sha — rejects with checksum mismatch, no file remains
// ─────────────────────────────────────────────────────────────────────────────
test('always-wrong sha: rejects after 2 attempts, no file left', async () => {
  let requests = 0
  const server = await startServer((_req, res) => {
    requests++
    res.writeHead(200)
    res.end(FIXED_BYTES) // correct bytes, but caller passes bogus sha
  })

  const cacheDir = makeTmpDir()
  const BOGUS_SHA = 'deadbeef'.repeat(8)

  try {
    await assert.rejects(
      () => fetchArchive(
        { url: serverUrl(server), sha256: BOGUS_SHA, bytes: FIXED_BYTES.length },
        cacheDir
      ),
      /checksum mismatch after retry/
    )

    const dest = path.join(cacheDir, 'archive.bin')
    assert.ok(!fs.existsSync(dest), 'dest file does not exist after failure')
    assert.equal(requests, 2, 'exactly 2 requests were made')
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: HTTP 404 — rejects with HTTP 404 message, no file at dest
// ─────────────────────────────────────────────────────────────────────────────
test('HTTP 404: rejects with HTTP 404 error, no file at dest', async () => {
  let requests = 0
  const server = await startServer((_req, res) => {
    requests++
    res.writeHead(404)
    res.end('Not Found')
  })

  const cacheDir = makeTmpDir()

  try {
    await assert.rejects(
      () => fetchArchive(
        { url: serverUrl(server), sha256: FIXED_SHA, bytes: FIXED_BYTES.length },
        cacheDir
      ),
      /HTTP 404/
    )

    const dest = path.join(cacheDir, 'archive.bin')
    assert.ok(!fs.existsSync(dest), 'no file at dest after 404')
  } finally {
    server.close()
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})
