'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const http = require('node:http')
const crypto = require('node:crypto')

// ─── helpers ──────────────────────────────────────────────────────────────────

function fakeApp(dataDir) {
  const messages = []
  const statuses = []
  const errors = []
  return {
    messages, statuses, errors,
    handleMessage: (id, delta) => messages.push({ id, delta }),
    setPluginStatus: s => statuses.push(s),
    setPluginError: e => errors.push(e),
    getDataDirPath: () => dataDir,
    debug: () => {}, error: () => {}
  }
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jr-idx-')) }

/** Poll fn every 25ms until it returns truthy, or throw after timeoutMs. */
function until(fn, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    function check() {
      if (fn()) return resolve()
      if (Date.now() > deadline) return reject(new Error(`until() timed out after ${timeoutMs}ms`))
      setTimeout(check, 25)
    }
    check()
  })
}

// Build a gzipped fixture JSONL archive.
// Returns { buf, sha256, bytes } — buf is the gzipped Buffer.
const T0 = Date.parse('2026-08-02T16:00:00Z')
const META_LINE = JSON.stringify({ journeyDataVersion: 1, id: 't1', title: 'Test Trip', self: 'vessels.urn:test' })

function buildArchive(gapSec = 1) {
  function delta(offsetSec) {
    return JSON.stringify({
      context: 'vessels.urn:test',
      updates: [{ timestamp: new Date(T0 + offsetSec * 1000).toISOString(), values: [{ path: 'navigation.speedOverGround', value: 3 }] }]
    })
  }
  const lines = [
    META_LINE,
    delta(0),
    delta(gapSec),
    delta(gapSec * 2)
  ]
  const buf = zlib.gzipSync(lines.join('\n') + '\n')
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  return { buf, sha256, bytes: buf.length }
}

// Start a local http server serving manifest + one gzipped archive.
// Returns { server, baseUrl, manifestUrl, archiveSha256 }
function startServer(archiveBuf, archiveSha256, archiveBytes) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (req.url === '/manifest.json') {
        const manifest = JSON.stringify({
          manifestVersion: 1,
          trips: [{
            id: 't1',
            title: 'Test Trip',
            video: 'https://youtube.com/x',
            files: {
              deltas: {
                url: `http://127.0.0.1:${server.address().port}/t1.jsonl.gz`,
                sha256: archiveSha256,
                bytes: archiveBytes
              }
            }
          }]
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(manifest)
      } else if (req.url === '/t1.jsonl.gz') {
        res.writeHead(200, { 'Content-Type': 'application/gzip' })
        res.end(archiveBuf)
      } else {
        res.writeHead(404); res.end('not found')
      }
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      const baseUrl = `http://127.0.0.1:${port}`
      resolve({ server, baseUrl, manifestUrl: `${baseUrl}/manifest.json` })
    })
  })
}

// ─── tests ────────────────────────────────────────────────────────────────────

test('shape: plugin has correct id, schema function, and schema properties with default', () => {
  const dataDir = tmp()
  const app = fakeApp(dataDir)
  const plugin = require('../index')(app)

  assert.strictEqual(plugin.id, 'signalk-journey-replay')
  assert.strictEqual(typeof plugin.schema, 'function')

  const schema = plugin.schema()
  assert.ok(schema && typeof schema === 'object', 'schema() returns an object')
  const props = schema.properties
  assert.ok(props, 'schema has .properties')
  assert.ok('manifestUrl' in props, 'has manifestUrl')
  assert.ok('tripId' in props, 'has tripId')
  assert.ok('speed' in props, 'has speed')
  assert.ok('loop' in props, 'has loop')
  assert.ok('timestampMode' in props, 'has timestampMode')
  assert.strictEqual(props.manifestUrl.default, 'https://sailingnaturali.github.io/journey-data/manifest.json')
})

test('happy path: start downloads, replays 3 deltas, status messages, stop', async () => {
  const { buf, sha256, bytes } = buildArchive(1) // 1s gaps → real-time fast at speed=1000
  const { server, manifestUrl } = await startServer(buf, sha256, bytes)
  const dataDir = tmp()
  const app = fakeApp(dataDir)
  const plugin = require('../index')(app)

  try {
    plugin.start({ manifestUrl, tripId: 't1', speed: 1000 })

    // Wait for 3 messages
    await until(() => app.messages.length >= 3)

    // Every message id is plugin id
    for (const m of app.messages) {
      assert.strictEqual(m.id, 'signalk-journey-replay')
    }

    // No delta should have context 'vessels.urn:test' (self context stripped)
    for (const m of app.messages) {
      assert.ok(!('context' in m.delta) || m.delta.context !== 'vessels.urn:test',
        'self context should be stripped')
    }

    // Status should include a 'downloading t1' entry
    assert.ok(app.statuses.some(s => s.startsWith('downloading t1')),
      `expected a status starting with 'downloading t1', got: ${JSON.stringify(app.statuses)}`)

    // Wait for a 'finished' status
    await until(() => app.statuses.some(s => s.includes('finished')))
    const finishedStatus = app.statuses.find(s => s.includes('finished'))
    assert.ok(finishedStatus.includes('3 deltas'),
      `expected finished status to mention '3 deltas', got: ${finishedStatus}`)

    plugin.stop()
  } finally {
    server.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('unknown trip: setPluginError with trip not found message', async () => {
  const { buf, sha256, bytes } = buildArchive(1)
  const { server, manifestUrl } = await startServer(buf, sha256, bytes)
  const dataDir = tmp()
  const app = fakeApp(dataDir)
  const plugin = require('../index')(app)

  try {
    plugin.start({ manifestUrl, tripId: 'nope' })
    await until(() => app.errors.length > 0)
    assert.match(app.errors[0], /trip not found: nope/)
    plugin.stop()
  } finally {
    server.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('stop mid-replay: aborts cleanly, no further messages, no hang', async () => {
  // 60s gaps at speed=1 means real sleeps of 60s — stop() must abort the sleep
  const { buf, sha256, bytes } = buildArchive(60)
  const { server, manifestUrl } = await startServer(buf, sha256, bytes)
  const dataDir = tmp()
  const app = fakeApp(dataDir)
  const plugin = require('../index')(app)

  try {
    plugin.start({ manifestUrl, tripId: 't1', speed: 1 })
    // Wait for the first message (no sleep before the first delta)
    await until(() => app.messages.length >= 1, 5000)
    const countAfterFirst = app.messages.length

    plugin.stop()

    // After stopping, no more messages should appear (the 60s sleep is aborted)
    await new Promise(r => setTimeout(r, 150))
    assert.strictEqual(app.messages.length, countAfterFirst, 'no messages after stop')
  } finally {
    server.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('schema after start: tripId.enum includes t1 from cached manifest', async () => {
  const { buf, sha256, bytes } = buildArchive(1)
  const { server, manifestUrl } = await startServer(buf, sha256, bytes)
  const dataDir = tmp()
  const app = fakeApp(dataDir)
  const plugin = require('../index')(app)

  try {
    plugin.start({ manifestUrl, tripId: 't1', speed: 1000 })
    // Wait for finish so manifest is definitely cached
    await until(() => app.statuses.some(s => s.includes('finished')), 5000)
    plugin.stop()

    // Now schema should reflect the cached manifest
    const schema = plugin.schema()
    const tripIdProp = schema.properties.tripId
    assert.ok(Array.isArray(tripIdProp.enum), 'tripId.enum should be an array')
    assert.ok(tripIdProp.enum.includes('t1'), `tripId.enum should include 't1', got: ${JSON.stringify(tripIdProp.enum)}`)
  } finally {
    server.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
