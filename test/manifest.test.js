'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { loadManifest } = require('../lib/manifest')

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'jr-m-')) }
function serve(handler) {
  return new Promise(resolve => {
    const s = http.createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve({ s, url: `http://127.0.0.1:${s.address().port}/manifest.json` }))
  })
}

test('fetches and caches the manifest', async () => {
  const body = JSON.stringify({ manifestVersion: 1, trips: [{ id: 'a' }] })
  const { s, url } = await serve((req, res) => res.end(body))
  const dir = tmp()
  const r = await loadManifest(url, dir)
  s.close()
  assert.strictEqual(r.fromCache, false)
  assert.strictEqual(r.manifest.trips[0].id, 'a')
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')))
})

test('falls back to cache when fetch fails; throws when no cache either', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ trips: [{ id: 'cached' }] }))
  const r = await loadManifest('http://127.0.0.1:1/manifest.json', dir)
  assert.strictEqual(r.fromCache, true)
  assert.strictEqual(r.manifest.trips[0].id, 'cached')

  await assert.rejects(() => loadManifest('http://127.0.0.1:1/manifest.json', tmp()))
})

test('HTTP error status falls back to cache', async () => {
  const { s, url } = await serve((req, res) => { res.statusCode = 500; res.end('boom') })
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ trips: [] }))
  const r = await loadManifest(url, dir)
  s.close()
  assert.strictEqual(r.fromCache, true)
})
