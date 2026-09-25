# Flip.to fork of the Snowplow JavaScript tracker

This fork produces **`ftsa2.js`**, the tracker served at `https://cdn.flip.to/public/ftsa2.js` and
loaded by every Flip.to integration. It is `sp.lite.js` built with a whitelabelled global name.

Upstream is `snowplow/snowplow-javascript-tracker`. Everything not listed under
[What this fork changes](#what-this-fork-changes) is upstream's and should be left alone, because a
divergence there costs a conflict on every future merge.

## Building

```powershell
pwsh -File ./_FLIPTO_BUILD.ps1
```

About four minutes. Output is `trackers/javascript-tracker/dist/ftsa2.js` and its `.map`.

The script derives its paths from its own location, checks every exit code, and asserts three
properties of the result before it will claim success:

- the bundle carries `ftSpacetimeGlobalNamespace`, which is what Platform's `analytics.util.ts`
  reads the tracker off `window` under;
- it no longer carries `GlobalSnowplowNamespace` anywhere;
- reversing the namespace reproduces the plain `sp.lite.js` byte for byte, so the whitelabel
  provably changed the global name and nothing else.

That last one matters more than it looks. It is what lets the event surface measured against
`sp.lite.js` in `trackers/javascript-tracker/test/surface` describe the served file as well.

### Publishing

Upload `ftsa2.js` and `ftsa2.js.map` to Azure Storage and clear the CDN. Rolling back means putting
the previous `ftsa2.js` back: the file is the whole deployment and there is no state to unwind.

Verify before uploading. The build will not match the served file byte for byte, and both
differences are expected:

```bash
curl -s https://cdn.flip.to/public/ftsa2.js -o served.js
diff <(tr -d '\r' < served.js) trackers/javascript-tracker/dist/ftsa2.js
```

The served file is CRLF and the script writes LF, which is the two bytes `tr` removes. It is also
banner-free, because earlier instructions asked whoever was building to strip the header by hand.
This build keeps the banner, so the new file is 158 bytes longer, and `diff` reports that one
leading block. Anything beyond those two is a real change.

Keeping the banner is not cosmetic. Its six newlines put the bundle on generated line 7, and
`sp.lite.js.map` opens with exactly six `;`, so its first mapping expects line 7. Stripping the
header without rewriting the map shifts **every** mapping by six lines, which is the state the
currently served pair is in. The banner also carries the BSD-3-Clause notice, which a redistributed
build should keep.

## What this fork changes

Seven source files in upstream's packages, `+47/-61` against upstream's `4.10.2` tag, plus one
package upstream does not have, `plugins/browser-plugin-page-engagement`. The fork does not carry
upstream's tags, so fetch them first. Regenerate the list rather than trusting this one:

```bash
git fetch https://github.com/snowplow/snowplow-javascript-tracker.git tag 4.10.2
git diff --stat 4.10.2...HEAD -- '**/src/**'
```

A new entry there should be a behaviour change. Keep upstream's bytes everywhere else: formatter
output made most hunks of the 4.10.2 merge conflict. It most likely came from resolving the 2026-01-21 upstream
merge with format-on-save on, so resolve upstream merges with it off. One line conflicts whatever the
formatting: the `plugins:` array in `browser-plugin-web-vitals/rollup.config.js`, where the fork
removed `cleanup(...)` and upstream edits the same line.

| File | Change |
|---|---|
| `browser-tracker-core/src/tracker/index.ts` | localStorage fallback in `getSnowplowCookieValue`, a localStorage write in `persistValue` under the `cookie` strategy as well as `cookieAndLocalStorage`, `loadDomainUserIdCookie` restoring a deleted cookie from localStorage and no longer returning `emptyIdCookie()` under strategy `none` (so an absent cookie is not replaced by a blank one), and the `fliptoDataLayer.snowplow` handle |
| `browser-tracker-core/src/tracker/local_storage_event_store.ts` | out queue renamed `snowplowOutQueue` to `ftOutQueue`, and the queue is cleared when localStorage access is lost, which otherwise duplicated page views |
| `trackers/javascript-tracker/src/index.ts` | guard so loading the tracker script twice does not throw |
| `trackers/javascript-tracker/src/features.ts` | wires `browser-plugin-page-engagement`, activated whenever the bundle carries it so the `enablePageEngagement` command exists for GTM containers; `tracker.lite.config.ts` and `tracker.test.config.ts` set `pageEngagement = true`, `tracker.config.ts` (sp.js) sets it false |
| `trackers/javascript-tracker/src/configuration.ts` | the `contexts.pageEngagement` option (`boolean` or `{ piggyback }`) |
| `plugins/browser-plugin-page-engagement/` | the whole package: GA4-rule engagement time, scroll depth and interaction counts per page view, reported as `iglu:to.flip/ft_page_engagement/jsonschema/1-0-0`, whose schema file lives in its `schemas/`. Inert until a tracker enables it; see its README |
| `browser-plugin-web-vitals/src/{index,utils}.ts` | bundles the `web-vitals` package instead of loading `window.webVitals` from an external script |

`tracker.lite.config.ts` also selects the plugin set the bundle carries.

The `??` to `||` fix that made the localStorage fallback reachable is inside `index.ts` above:
`getCookie` returns `''` rather than null, so the nullish form never fired and the fallback was
dead for a month.

Consequences worth knowing before touching any of them:

- **`stateStorageStrategy: 'none'` is intact.** Nothing is written under it, and the localStorage
  read is read-only. The consent fail-safe holds.
- **A leftover localStorage entry reads as an existing session**, which suppresses
  `onSessionUpdateCallback` for a visitor who cleared cookies but not storage. The E2E suite found
  this; `pageSetup` now clears localStorage so specs do not inherit each other's identity.
- **`useLocalStorage: false` holds only until the first consent grant.** Each grant calls
  `enableAnonymousTracking({ stateStorageStrategy: 'cookieAndLocalStorage' })`, and the toggle
  re-derives `useLocalStorage` from the strategy, so from then on events buffer to `ftOutQueue_*`.
  For the tracker Platform's `analytics.util` creates, the copy is never read back: the tracker
  loads it only at creation, with `useLocalStorage: false`. The GTM containers' trackers
  (`ftWebsite`, `ftBookingEngine`) pass no `useLocalStorage`, so with consent they do read their
  `ftOutQueue_*` back at start, which is upstream's normal behaviour. Not patched here, because
  consent was given and a fork patch would be one more divergence from upstream. Revoking sets the
  strategy to `none`, which removes the copy; events already in memory still send. A visit that
  starts denied never flips, so once Flip-to/Platform#4407 ships, `purgeTrackerIdentity` removes
  every `ftOutQueue_*` on a deny, the GTM trackers' copies included. That purge matches the prefix
  set in `local_storage_event_store.ts`, so a rename there breaks it.
- **`fliptoDataLayer.snowplow` is unconditional.** The `namespace === 'fliptoSa'` guard was dropped,
  so every tracker on a page overwrites the handle.

## Tests

`rush test` runs the unit suites. The browser suite runs headless on CI through `test:e2e:ci`, since
this fork has no Saucelabs credentials and every E2E step was gated on them, which meant they were
skipped in silence for years while the workflow stayed green.

`trackers/javascript-tracker/test/surface` compares the event surface the shipped bundle produces
against a recorded golden, which is how "does this change what the warehouse receives" gets answered
by measurement. Its README covers recording a golden and what the comparison does not reach.

## Traps this repo has already sprung

Each of these cost real time, and each looked like success while it was happening.

**`rush build` prints a SUCCESS line for the operations that passed even when others failed.** A
partial failure leaves the previous `sp.lite.js` in `dist/`, and the next step copies it as though
it were new. Always check for a `FAILURE:` line, not just the last one.

**Switching branches without `rush install` fails in a way that looks like a code error.** A missing
module or a type mismatch after a checkout usually means `common/temp` belongs to another branch.

**Closure Compiler runs out of memory under load.** `java.lang.OutOfMemoryError: Could not allocate
an aligned heap chunk` means too much parallelism, not a broken source. `--parallelism 2` clears it.

**The whitelabel used to corrupt `tags/tag.js`.** The replace was not idempotent when the new
namespace contained the old one, so `--whitelabel=FliptoGlobalSnowplowNamespace` grew a `Flipto`
prefix on every write until the file read `FliptoFliptoFlipto...`. Per write, not per build: the
hook ran once per rollup output and the two configs share one plugins array, so each build wrote
the loaders twice. Sixteen prefixes is eight builds. The build now writes the whitelabelled loaders
to `dist/` once, and never modifies the sources under `tags/`.

## Committing

Gitleaks flags the test fixtures. `git commit --no-verify` is the workaround.

**Every pull request needs a rush change file per project it touches**, or `Pull Request Check`
fails on `rush change --verify` with the project named. Files at the repo root count too: editing
`.bundlemonrc.json` attributes to `@snowplow/javascript-tracker`. Add
`common/changes/@snowplow/<project>/<something>_<date>.json` with `"type": "none"`, copying a
neighbour. The check runs before anything expensive, so this costs a round trip every time it is
forgotten.

Watch what `git add -A` picks up. `test/pages/` accumulates built bundles that the E2E fixtures
load, and one of them, a 674 KB sourcemap, reached master that way.
