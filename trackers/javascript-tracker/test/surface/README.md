# Event surface comparison

Answers one question by measurement: **does this change what the warehouse receives?**

The fixture drives every plugin the shipped lite bundle carries against Snowplow Micro, and the
spec compares the enriched events field by field against a recorded golden. A tracker change that
adds, drops or renames a context, or stops filling an atomic column, fails here.

## What it measures

`dist/sp.lite.js`, which is the artifact that becomes `ftsa2.js`. Not the bundle the rest of the
suite uses: `rollup.config.test.js` aliases `tracker.test.config.ts`, which has `webVitals` and
`performanceNavigationTiming` **off** and fifteen plugins on that the lite build does not carry. So
nothing else in this repo observes what we actually ship.

Per run: 7 events, 21 iglu schemas, 131 atomic fields each.

| | |
|---|---|
| Events | page_view, page_ping, struct, link_click, application_error, enhanced ecommerce action, web_vitals |
| Entities | web_page, browser, client_session, application, http_client_hints, PerformanceNavigationTiming, UA cookies, GA4 cookies, the four enhanced ecommerce field objects, and a stand-in for the entities Platform attaches |

### The custom entities

Platform attaches around twenty-seven `to.flip` entities, several of which dbt reads, and no plugin
provides any of them. The tracker does not know what a custom entity means, so the vendor is
irrelevant to what needs testing: that an entity the application supplies is carried unchanged.

One stand-in covers the mechanism all twenty-seven rely on, through both attachment paths. A global
context has to reach every event, and a per-event one has to survive alongside it. Measured: seven
events, the global entity on all seven, the struct event carrying both.

It uses a schema Iglu Central resolves rather than a `to.flip` one, because Micro's embedded
repository loads from the classpath and cannot read a mounted directory, and because standing up an
Iglu server for the sake of a vendor string would prove nothing extra.

`payload_data` never appears: it is the POST envelope, not an entity on an event.

## How the exclusion list stays honest

A comparison like this lives or dies on what it ignores. A generous list makes any two builds look
identical, so this one is mostly **measured rather than chosen**.

Nineteen fields are dropped outright, all ids and timestamps, listed in `normalize.ts`.

Everything else that varies excludes itself: the page is loaded **twice in the same run**, and any
field path that differs between those two loads is the noise floor. Timings, transfer sizes and
per-session counters land there on their own. A path the golden calls stable but that starts
varying fails with that stated, rather than being read as a regression.

## Recording the golden

The golden carries fields the machine decides, such as language, timezone and viewport, so it
cannot be recorded on a laptop and asserted on a runner.

1. Set `SURFACE_WRITE_GOLDEN: '1'` on the E2E step in `.github/workflows/build.yml`.
2. Push. The run records the golden and uploads it as the `surface-golden` artifact.
3. `gh run download <run-id> --name surface-golden --dir trackers/javascript-tracker/test/surface/`
4. Commit `golden.json` and **remove the `SURFACE_WRITE_GOLDEN` line again.**

Step 4 is not optional. While the flag is set, a missing golden passes instead of failing, which is
the failure mode this whole test exists to catch. Leaving it set turns the guard into decoration.

Re-recording is meant to be deliberate and visible: the `golden.json` diff in a pull request is the
review artifact. It states exactly what changed about the event surface.

## Why measuring `sp.lite.js` covers the served `ftsa2.js`

Measured rather than assumed. Reversing `ftSpacetimeGlobalNamespace` back to
`GlobalSnowplowNamespace` in the whitelabelled bundle reproduces the plain one **byte for byte**,
71,626 bytes, once both banners are stripped. There is one occurrence, in
`window.ftSpacetimeGlobalNamespace.shift()`. So the whitelabel changes the global name and nothing
else, and `_FLIPTO_BUILD.ps1` asserts that property on every build.

## What it does not cover

- **Browsers other than Chrome.** Saucelabs covered that and is not available on this fork.
- **Code paths the fixture does not drive.** Absence from the golden means uncovered, not verified.

## Three ways this quietly covered less than it claimed

All three were found by checking the emitted schema list against the shipped bundle's, and none
produced an error:

- The enhanced ecommerce field objects attach through `addEnhancedEcommerce*Context`, not the
  `*FieldObject` names. An unknown command is dropped without a warning. Cost: four schemas.
- `gaCookies` attaches nothing when the `__utm*` cookies are absent. Cost: one schema.
- `web-vitals` is gated on `contexts.webVitals` rather than on being compiled in, so the bundle
  carried the code while the fixture observed none of it. Cost: one schema.

If you extend the fixture, check the schema count against the bundle rather than trusting a pass.

## Result on the 4.10.2 upgrade

Two runs of one build differ in nothing. 4.6.8 against a 4.10.2 golden differs in `v_tracker`, and
in nothing else that is not a per-session counter or the fixture's own byte size. No dbt model
reads `v_tracker`.
