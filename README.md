# signalk-journey-replay

Replay real published voyage data on any SignalK server. Trips come from a
manifest — the default points to Sailing Naturali's journeys at
`https://sailingnaturali.github.io/journey-data/manifest.json` (data repo:
[sailingnaturali/journey-data](https://github.com/sailingnaturali/journey-data)).
Each trip downloads once, verifies the sha256, caches to disk, and replays
its SignalK deltas through the server as if the voyage were happening now.
The recorded vessel becomes `self` on your server; any other vessels in the
archive (AIS targets) appear as themselves.

## Install

SignalK App Store: search **journey replay** → install →
restart server → enable in Plugin Config.

npm package: `@sailingnaturali/signalk-journey-replay`

## Configuration

| Key | Default | Notes |
|-----|---------|-------|
| `manifestUrl` | `https://sailingnaturali.github.io/journey-data/manifest.json` | Point at any conforming manifest to replay your own journeys. |
| `tripId` | — | Select a trip from the dropdown. **First-use quirk:** the list populates from the cached manifest, so enable the plugin once with a network connection, then reopen the config to see the trip list. |
| `speed` | `1` | Pacing divisor: `1` = real-time, `10` = 10× faster, `60` = 60× faster. Inter-delta gaps are divided by this value. Enum: `1`, `10`, `60`. |
| `loop` | `false` | Restart the trip automatically when it finishes. |
| `timestampMode` | `rebase` | `rebase` shifts all timestamps so the trip starts at the current time — keeps time-relative consumers (tide plugins, weather overlays) coherent. `original` keeps the recorded timestamps, useful for historical analysis. |

## How replay behaves

The plugin status line shows download progress (`downloading <id> (N%)`),
then updates every five seconds during playback:

```
Replaying Boundary Pass, T+00:04 @ 10× — https://youtube.com/...
```

The YouTube link appears when the manifest entry includes one.

When the trip ends:

```
finished Boundary Pass: 4821 deltas, 2 malformed
```

Malformed lines (invalid JSON, missing updates array, unparseable timestamp)
are skipped and counted; the replay continues.

The recorded vessel (`meta.self` in the archive) is mapped to `self` on your
server by dropping the `context` field — the deltas arrive exactly as if your
own instruments produced them. All other contexts (AIS targets) pass through
unchanged.

Replayed values carry `$source: journey-replay.<original-source>` so they are
distinguishable from live data on any consuming server.

## Coexistence warning

Anything else emitting the same paths — simulators, mock plugins, real
sensors — will interleave with the replay. Disable overlapping sources while
replaying. Never treat replay output as live navigation data; this is for
development, dashboards, and demos.

## Offline

If the manifest URL is unreachable the plugin falls back to the last
successfully cached copy. Previously downloaded trips replay with no network
at all.

## Publish your own journeys

Point `manifestUrl` at any manifest that matches the
[journey-data schema](https://github.com/sailingnaturali/journey-data#readme).
The `files.deltas` entry is required; a `self` field in the metadata line is
recommended so the recorded vessel maps correctly to `self` on replay.

Full schema, hosting recipe, and gotchas (absolute URLs, `self` mapping,
rebase vs original): **[Bring your own journey data →
journey-data/docs/BRING-YOUR-OWN-DATA.md](https://github.com/sailingnaturali/journey-data/blob/main/docs/BRING-YOUR-OWN-DATA.md)**.

## License

MIT
