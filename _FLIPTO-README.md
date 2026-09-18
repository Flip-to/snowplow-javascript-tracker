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

Verify before uploading. A correct build differs from the file currently served only by content you
intended to change:

```bash
curl -s https://cdn.flip.to/public/ftsa2.js -o served.js
cmp served.js trackers/javascript-tracker/dist/ftsa2.js
```

The script already strips the banner comment and rewrites the sourcemap reference, which earlier
instructions asked whoever was building to do by hand. Doing it in the script is what makes that
`cmp` meaningful.

## What this fork changes

Five commits, all in `libraries/browser-tracker-core/src/tracker/index.ts`.

| Change | Effect |
|---|---|
| localStorage fallback in `getSnowplowCookieValue` | a missing cookie falls back to localStorage, so clearing cookies alone does not mint a new user |
| localStorage write in `persistValue` | `id` and `ses` are mirrored to localStorage under the `cookie` strategy as well as `cookieAndLocalStorage` |
| `loadDomainUserIdCookie` restores from localStorage | a deleted cookie is rewritten from the surviving localStorage value |
| `??` to `\|\|` in the fallback | `getCookie` returns `''` rather than null, so the nullish form never fired and the fallback above was unreachable for a month |
| `fliptoDataLayer.snowplow` handle | exposes the tracker for GTM |

`tracker.lite.config.ts` also selects the plugin set the bundle carries.

Consequences worth knowing before touching any of them:

- **`stateStorageStrategy: 'none'` is intact.** Nothing is written under it, and the localStorage
  read is read-only. The consent fail-safe holds.
- **A leftover localStorage entry reads as an existing session**, which suppresses
  `onSessionUpdateCallback` for a visitor who cleared cookies but not storage. The E2E suite found
  this; `pageSetup` now clears localStorage so specs do not inherit each other's identity.
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
prefix on every build until the file read `FliptoFliptoFlipto...`. The build now writes the
whitelabelled loaders to `dist/` and never modifies the sources under `tags/`.

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
