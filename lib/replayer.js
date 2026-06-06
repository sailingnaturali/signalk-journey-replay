'use strict'
const fs = require('node:fs')
const zlib = require('node:zlib')
const readline = require('node:readline')

// Streams a journey-data delta JSONL archive and re-emits each delta.
// All side-effects are injected (emit/now/sleep/status/signal) so the core is
// unit-testable without timers. Pacing follows original inter-delta gaps
// divided by `speed`. `rebase` mode (default) shifts all timestamps so the
// trip starts at now(); `original` keeps recorded timestamps. The recorded
// vessel (meta.self) is mapped to the consuming server's self by dropping
// the context; all other contexts (AIS targets) pass through unchanged.
async function replay(opts) {
  const speed = opts.speed || 1
  const mode = opts.timestampMode || 'rebase'
  const now = opts.now || Date.now
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)))
  const stats = { emitted: 0, malformed: 0 }
  let meta = null
  let firstTs = null
  let offset = 0
  let prevTs = null

  const rl = readline.createInterface({
    input: fs.createReadStream(opts.filePath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity
  })
  for await (const line of rl) {
    if (opts.signal && opts.signal.aborted) break
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { stats.malformed++; continue }
    if (obj.journeyDataVersion) { meta = obj; continue }
    if (!Array.isArray(obj.updates) || obj.updates.length === 0) { stats.malformed++; continue }
    const ts = Date.parse(obj.updates[0].timestamp)
    if (!Number.isFinite(ts)) { stats.malformed++; continue }
    if (firstTs === null) { firstTs = ts; prevTs = ts; offset = now() - ts }
    const wait = (ts - prevTs) / speed
    if (wait > 0) await sleep(wait)
    if (opts.signal && opts.signal.aborted) break
    prevTs = ts
    opts.emit(rewrite(obj, meta, offset, mode))
    stats.emitted++
    if (opts.status) opts.status({ meta, elapsed: ts - firstTs, stats: { ...stats } })
  }
  rl.close()
  return { meta, stats }
}

function rewrite(delta, meta, offset, mode) {
  const out = { ...delta }
  if (meta && meta.self && out.context === meta.self) delete out.context
  out.updates = delta.updates.map(u => mode === 'rebase' ? { ...u, timestamp: new Date(Date.parse(u.timestamp) + offset).toISOString() } : { ...u })
  return out
}
module.exports = { replay }
