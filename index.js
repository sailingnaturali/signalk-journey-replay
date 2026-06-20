'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { loadManifest } = require('./lib/manifest')
const { fetchArchive } = require('./lib/download')
const { replay } = require('./lib/replayer')
const { availableTripsMessage } = require('./lib/trips')

const DEFAULT_MANIFEST = 'https://sailingnaturali.github.io/journey-data/manifest.json'
const STATUS_INTERVAL_MS = 5000

module.exports = function (app) {
  const plugin = {
    id: 'signalk-journey-replay',
    name: 'Journey Replay',
    description: 'Replay published voyage data (journey-data archives) with timestamps rebased to now'
  }
  let abort = null

  const cacheDir = () => app.getDataDirPath()

  function cachedTripIds() {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(cacheDir(), 'manifest.json'), 'utf8'))
      return m.trips.map(t => t.id)
    } catch { return [] }
  }

  plugin.schema = () => {
    const ids = cachedTripIds()
    const tripId = { type: 'string', title: 'Trip', description: 'List populates after first start with a reachable manifest' }
    if (ids.length) tripId.enum = ids
    return {
      type: 'object',
      properties: {
        manifestUrl: { type: 'string', title: 'Manifest URL', default: DEFAULT_MANIFEST },
        tripId,
        speed: { type: 'number', title: 'Speed multiplier', default: 1, enum: [1, 10, 60] },
        loop: { type: 'boolean', title: 'Loop when finished', default: false },
        timestampMode: { type: 'string', title: 'Timestamps', default: 'rebase', enum: ['rebase', 'original'] }
      }
    }
  }

  plugin.start = (config) => {
    abort = new AbortController()
    const signal = abort.signal
    run(config || {}, signal).catch(e => {
      if (!signal.aborted) app.setPluginError(String((e && e.message) || e))
    })
  }

  plugin.stop = () => {
    if (abort) abort.abort()
    abort = null
  }

  async function run(config, signal) {
    const { manifest, fromCache } = await loadManifest(config.manifestUrl || DEFAULT_MANIFEST, cacheDir())
    const trip = manifest.trips.find(t => t.id === config.tripId)
    if (!trip) {
      app.setPluginError(availableTripsMessage(manifest.trips.map(t => t.id), config.tripId))
      return
    }
    app.setPluginStatus(`downloading ${trip.id}…`)
    const file = await fetchArchive(
      trip.files.deltas,
      path.join(cacheDir(), trip.id),
      pct => app.setPluginStatus(`downloading ${trip.id} (${pct}%)`)
    )
    if (signal.aborted) return

    const speed = config.speed || 1
    let lastStatus = 0

    // Abort-aware sleep: if the signal fires while sleeping, resolve immediately
    // and clear the timer. This prevents a 60-s gap from holding the process open
    // after stop() is called. We pass it into replay() so replayer.js stays untouched.
    function abortSleep(ms) {
      return new Promise(resolve => {
        const t = setTimeout(resolve, ms)
        signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
      })
    }

    do {
      const { stats } = await replay({
        filePath: file,
        speed,
        timestampMode: config.timestampMode || 'rebase',
        signal,
        sleep: abortSleep,
        emit: d => app.handleMessage(plugin.id, d),
        status: ({ elapsed }) => {
          const t = Date.now()
          if (t - lastStatus < STATUS_INTERVAL_MS) return
          lastStatus = t
          const hh = String(Math.floor(elapsed / 3600000)).padStart(2, '0')
          const mm = String(Math.floor((elapsed / 60000) % 60)).padStart(2, '0')
          app.setPluginStatus(`Replaying ${trip.title}, T+${hh}:${mm} @ ${speed}×` +
            (trip.video ? ` — ${trip.video}` : '') +
            (fromCache ? ' (cached manifest)' : ''))
        }
      })
      if (!signal.aborted) {
        app.setPluginStatus(`finished ${trip.title}: ${stats.emitted} deltas` +
          (stats.malformed ? `, ${stats.malformed} malformed` : '') +
          (config.loop ? ' — looping' : ''))
      }
    } while (config.loop && !signal.aborted)
  }

  return plugin
}
