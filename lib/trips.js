'use strict'
// Status/error line shown when no trip (or an unknown trip) is selected. Lists
// the ids the user can type or pick. Pure, so it's unit-tested in isolation.
function availableTripsMessage(ids, selected) {
  const head = selected ? `trip not found: ${selected}` : 'no trip selected'
  if (!ids.length) return `${head} — manifest has no trips`
  const shown = ids.slice(0, 10)
  const list = shown.join(', ') + (ids.length > shown.length ? `, …(+${ids.length - shown.length} more)` : '')
  return `${head} — available: ${list} (type one as Trip, or reopen config for the dropdown)`
}
module.exports = { availableTripsMessage }
