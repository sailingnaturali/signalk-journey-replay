'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { replay } = require('../lib/replayer')

const T0 = Date.parse('2026-08-02T16:00:00Z')
function fixture(lines) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jr-')), 'trip.jsonl.gz')
  fs.writeFileSync(p, zlib.gzipSync(lines.join('\n') + '\n'))
  return p
}
function delta(offsetSec, context, pathName, value) {
  return JSON.stringify({
    ...(context ? { context } : {}),
    updates: [{ timestamp: new Date(T0 + offsetSec * 1000).toISOString(), values: [{ path: pathName, value }] }]
  })
}
const META = JSON.stringify({ journeyDataVersion: 1, id: 't', title: 'T', self: 'vessels.urn:test' })

function harness(file, opts = {}) {
  const emitted = []
  const sleeps = []
  const NOW = 1800000000000
  return {
    emitted, sleeps, NOW,
    run: () => replay({
      filePath: file, emit: d => emitted.push(d),
      now: () => NOW, sleep: ms => { sleeps.push(ms); return Promise.resolve() },
      ...opts
    })
  }
}

test('rebase: timestamps shifted so trip starts now; pacing = original gaps', async () => {
  const f = fixture([META, delta(0, 'vessels.urn:test', 'navigation.speedOverGround', 3),
                     delta(2, 'vessels.urn:test', 'navigation.speedOverGround', 3.1)])
  const h = harness(f)
  const { stats, meta } = await h.run()
  assert.strictEqual(meta.id, 't')
  assert.strictEqual(stats.emitted, 2)
  assert.strictEqual(h.emitted[0].updates[0].timestamp, new Date(h.NOW).toISOString())
  assert.strictEqual(h.emitted[1].updates[0].timestamp, new Date(h.NOW + 2000).toISOString())
  assert.deepStrictEqual(h.sleeps.filter(ms => ms > 0), [2000])
})

test('speed divides pacing but not rebased spacing of timestamps', async () => {
  const f = fixture([META, delta(0, null, 'a.b', 1), delta(10, null, 'a.b', 2)])
  const h = harness(f, { speed: 10 })
  await h.run()
  assert.deepStrictEqual(h.sleeps.filter(ms => ms > 0), [1000])
  assert.strictEqual(h.emitted[1].updates[0].timestamp, new Date(h.NOW + 10000).toISOString())
})

test('recorded self context is stripped; other contexts pass through', async () => {
  const f = fixture([META, delta(0, 'vessels.urn:test', 'a.b', 1),
                     delta(1, 'vessels.urn:other', 'a.b', 2), delta(2, null, 'a.b', 3)])
  const h = harness(f)
  await h.run()
  assert.strictEqual('context' in h.emitted[0], false)
  assert.strictEqual(h.emitted[1].context, 'vessels.urn:other')
  assert.strictEqual('context' in h.emitted[2], false)
})

test('original mode keeps timestamps, still paces', async () => {
  const f = fixture([META, delta(0, null, 'a.b', 1), delta(3, null, 'a.b', 2)])
  const h = harness(f, { timestampMode: 'original' })
  await h.run()
  assert.strictEqual(h.emitted[0].updates[0].timestamp, new Date(T0).toISOString())
  assert.deepStrictEqual(h.sleeps.filter(ms => ms > 0), [3000])
})

test('original mode emits fresh update objects, not source references', async () => {
  const f = fixture([META, delta(0, null, 'a.b', 1)])
  const h = harness(f, { timestampMode: 'original' })
  await h.run()
  const origTimestamp = h.emitted[0].updates[0].timestamp
  h.emitted[0].updates[0].timestamp = 'MUTATED'

  // Re-run on same file and verify emitted updates are fresh
  const h2 = harness(f, { timestampMode: 'original' })
  await h2.run()
  assert.strictEqual(h2.emitted[0].updates[0].timestamp, origTimestamp)
  assert.notStrictEqual(h2.emitted[0].updates, h.emitted[0].updates)
})

test('source attribution: $source prefixed with journey-replay.; source object removed', async () => {
  // Update with $source only
  const withDollarSource = JSON.stringify({
    updates: [{
      timestamp: new Date(T0).toISOString(),
      $source: 'gps.dongle',
      values: [{ path: 'navigation.speedOverGround', value: 3 }]
    }]
  })
  // Update with source object (no $source)
  const withSourceObj = JSON.stringify({
    updates: [{
      timestamp: new Date(T0 + 1000).toISOString(),
      source: { label: 'n2k', src: '3' },
      values: [{ path: 'navigation.headingTrue', value: 1.2 }]
    }]
  })
  // Update with neither
  const withNeither = JSON.stringify({
    updates: [{
      timestamp: new Date(T0 + 2000).toISOString(),
      values: [{ path: 'environment.depth.belowKeel', value: 15 }]
    }]
  })
  const f = fixture([META, withDollarSource, withSourceObj, withNeither])
  const h = harness(f)
  await h.run()
  assert.strictEqual(h.emitted.length, 3)

  const u0 = h.emitted[0].updates[0]
  assert.strictEqual(u0.$source, 'journey-replay.gps.dongle')
  assert.ok(!('source' in u0), 'source object must be absent when $source present')

  const u1 = h.emitted[1].updates[0]
  assert.strictEqual(u1.$source, 'journey-replay.n2k')
  assert.ok(!('source' in u1), 'source object must be removed')

  const u2 = h.emitted[2].updates[0]
  assert.strictEqual(u2.$source, 'journey-replay.unknown')
  assert.ok(!('source' in u2), 'source object must be absent')
})

test('malformed lines counted, replay continues; abort stops promptly', async () => {
  const f = fixture([META, delta(0, null, 'a.b', 1), '{nope', delta(1, null, 'a.b', 2)])
  const h = harness(f)
  const { stats } = await h.run()
  assert.strictEqual(stats.malformed, 1)
  assert.strictEqual(stats.emitted, 2)

  const ac = new AbortController()
  const f2 = fixture([META, delta(0, null, 'a.b', 1), delta(1, null, 'a.b', 2)])
  const h2 = harness(f2, { signal: ac.signal, sleep: ms => { ac.abort(); return Promise.resolve() } })
  const r2 = await h2.run()
  assert.strictEqual(r2.stats.emitted, 1)
})
