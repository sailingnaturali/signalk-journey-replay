'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { loadManifest, resolveTripUrls } = require('../lib/manifest')

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

test('corrupted cache during fallback rethrows the fetch error, not the parse error', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'manifest.json'), '{corrupt')
  await assert.rejects(() => loadManifest('http://127.0.0.1:1/manifest.json', dir), /fetch failed|ECONNREFUSED/)
})

test('resolveTripUrls resolves relative urls and passes absolutes through', () => {
  const base = 'https://host.example/data/manifest.json'
  const m = resolveTripUrls({
    trips: [
      { id: 'rel', files: { deltas: { url: 'rel.jsonl.gz', sha256: 'x' } } },
      { id: 'abs', files: { deltas: { url: 'https://cdn.example/abs.jsonl.gz', sha256: 'y' } } },
      { id: 'nofiles' }
    ]
  }, base)
  assert.strictEqual(m.trips[0].files.deltas.url, 'https://host.example/data/rel.jsonl.gz')
  assert.strictEqual(m.trips[1].files.deltas.url, 'https://cdn.example/abs.jsonl.gz')
  assert.deepStrictEqual(m.trips[2], { id: 'nofiles' })
})

test('resolveTripUrls handles files.raw too', () => {
  const m = resolveTripUrls({
    trips: [{ id: 'a', files: { deltas: { url: 'd.jsonl.gz' }, raw: { url: 'r.log.gz' } } }]
  }, 'https://h.example/m/manifest.json')
  assert.strictEqual(m.trips[0].files.deltas.url, 'https://h.example/m/d.jsonl.gz')
  assert.strictEqual(m.trips[0].files.raw.url, 'https://h.example/m/r.log.gz')
})

test('loadManifest returns resolved urls but caches raw urls', async () => {
  const body = JSON.stringify({ trips: [{ id: 'a', files: { deltas: { url: 'a.jsonl.gz', sha256: 'x' } } }] })
  const { s, url } = await serve((req, res) => res.end(body))
  const dir = tmp()
  const r = await loadManifest(url, dir)
  s.close()
  const expected = url.replace('manifest.json', 'a.jsonl.gz')
  assert.strictEqual(r.manifest.trips[0].files.deltas.url, expected)         // returned: resolved
  const cached = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.strictEqual(cached.trips[0].files.deltas.url, 'a.jsonl.gz')          // on disk: raw
})

test('loadManifest offline path resolves cache urls against the current url', async () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ trips: [{ id: 'a', files: { deltas: { url: 'a.jsonl.gz' } } }] }))
  const r = await loadManifest('http://127.0.0.1:1/sub/manifest.json', dir) // unreachable → cache
  assert.strictEqual(r.fromCache, true)
  assert.strictEqual(r.manifest.trips[0].files.deltas.url, 'http://127.0.0.1:1/sub/a.jsonl.gz')
})
