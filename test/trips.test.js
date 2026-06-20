'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const { availableTripsMessage } = require('../lib/trips')

test('lists ids and names the missing selection', () => {
  const msg = availableTripsMessage(['a', 'b'], 'zzz')
  assert.match(msg, /trip not found: zzz/)
  assert.match(msg, /available: a, b/)
})

test('no selection yields a neutral head', () => {
  assert.match(availableTripsMessage(['a'], undefined), /no trip selected/)
})

test('empty manifest is stated plainly', () => {
  assert.match(availableTripsMessage([], 'x'), /manifest has no trips/)
})

test('caps long lists at 10 ids with a +N more suffix', () => {
  const ids = Array.from({ length: 13 }, (_, i) => 'id' + i)
  const msg = availableTripsMessage(ids, undefined)
  assert.match(msg, /\(\+3 more\)/)
  assert.ok(!msg.includes('id10'), 'should not list the 11th id')
})
