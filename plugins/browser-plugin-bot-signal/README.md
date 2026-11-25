# @snowplow/browser-plugin-bot-signal (prototype)

Client-side bot detection with [bot-signal](https://github.com/okasi/bot-signal) (MIT) instead of BotD. Mirrors
`browser-plugin-bot-detection`. Private and not published: the project is marked `shouldPublish: false` in `rush.json`.

## Usage

```js
import { newTracker } from '@snowplow/browser-tracker';
import { BotSignalPlugin } from '@snowplow/browser-plugin-bot-signal';

newTracker('sp', '<collector>', { plugins: [BotSignalPlugin()] });
```

The instant checks run once per page. Events tracked before they finish carry no entity, so the first `page_view`
at load will often miss it.

## Modes

- `BotSignalPlugin()` (standard): emits the standard `iglu:com.snowplowanalytics.snowplow/client_side_bot_detection/jsonschema/1-0-0`
  entity (`bot`, `kind`), so no new Iglu schema is needed. That schema is closed, so every bot-signal kind outside its enum
  (including the generic `browser-automation`) is sent as `unknown`.
- `BotSignalPlugin({ mode: 'pilot' })`: emits `iglu:com.flipto/client_side_bot_signal_pilot/jsonschema/1-0-0` with `bot`,
  `score`, `kind` and the fired signal ids. The schema (`schema/client_side_bot_signal_pilot.json`) is a draft and must be
  registered in the Iglu registry before use, or the collector rejects the events.

- `BotSignalPlugin({ mode: 'both' })`: both entities on every event, so a dashboard keeps the BotD-compatible fields and the pilot
  adds the score. Needs the pilot schema registered, because Snowplow rejects an event whose entity fails validation.

Several plugin instances on one page share one detection and each builds its own entity from its own mode.

## Privacy

The checks read browser characteristics (webdriver flag, automation globals, viewport, permissions, voice list). A text search
of bot-signal 2.0.18 `browser.js` found no network, storage or cookie calls. Activate the plugin only after consent where the
site requires it.

## Versioning

The project is `shouldPublish: false`, so it is outside the `tracker` version policy. Its `@snowplow/browser-tracker`
peer range (`~4.10.2`) is bumped by hand when the fork merges a new upstream tracker release.

## Build

The UMD build bundles `bot-signal` (pinned to 2.0.18). bot-signal ships ES2020, so `rollup.config.js` downlevels the bundled chunk
to ES5 with the repo's TypeScript (`es5()` plugin); a script that must stay parseable in old browsers cannot carry `async` or default
parameters. Measured on 2026-11-25: 42.3 KB minified, 13.0 KB gzip, 11.6 KB brotli. The ES module build leaves `bot-signal/browser` external, so a consumer
bundling it must pin the same version.

## Copyright and license

Copyright (c) Snowplow Analytics Ltd. Licensed under the BSD 3-Clause license, see [LICENSE](LICENSE).
