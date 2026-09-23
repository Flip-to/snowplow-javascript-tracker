# Event surface comparison

Answers one question by measurement: **does this change what the warehouse receives?**

The fixture drives every plugin the shipped lite bundle carries against Snowplow Micro, and the
spec compares the enriched events field by field against `golden.json`. A tracker change that adds,
drops or renames a context, or stops an event filling an atomic column, fails here.

## What it measures

`dist/sp.lite.js`, which is the artifact that becomes `ftsa2.js`. Not the bundle the rest of the
suite uses: `rollup.config.test.js` aliases `tracker.test.config.ts`, which has `webVitals` and
`performanceNavigationTiming` **off** and fifteen plugins on that the lite build does not carry. So
nothing else in this repo observes what we actually ship.

Per run: 9 events, 25 iglu schemas, 131 atomic fields each.

| | |
|---|---|
| Events | page_view, page_ping, struct, link_click, application_error, enhanced ecommerce action, web_vitals, screen_view, application_background |
| Entities | web_page, browser, client_session, application, PerformanceNavigationTiming, UA cookies, GA4 cookies, the four enhanced ecommerce field objects, screen, screen_summary, and a stand-in for the entities Platform attaches |

`payload_data` never appears: it is the POST envelope, not an entity on an event.

Platform attaches around twenty-seven `to.flip` entities, several of which dbt reads, and no plugin
provides any of them. The tracker does not know what a custom entity means, so the vendor is
irrelevant to what needs testing: that an entity the application supplies is carried unchanged. One
stand-in covers that, through both attachment paths, a global context and a per-event one. It uses a
schema Iglu Central resolves, because Micro's embedded repository loads from the classpath and
cannot read a mounted directory.

Lines are keyed by the event they came from. Without that the seven events collapse into one set and
a field only one event stops sending is hidden by an identical line from another, since `page_view`
and `page_ping` both carry `page_title`.

## How the exclusion list stays honest

A comparison like this lives or dies on what it ignores.

Twenty fields are dropped outright, all ids and timestamps, listed in `normalize.ts`. Everything
else that varies excludes itself: the page is loaded **twice in the same run**, and any field path
that differs between those loads is the noise floor. Timings, transfer sizes and per-session
counters land there without anyone deciding they should.

One list is chosen rather than measured, and for a different reason: `ENVIRONMENT_FIELDS` names what
the **browser** decides rather than the tracker, such as the user agent and the viewport. Those are
compared by presence. The runner updates Chrome on its own schedule, and a new user agent string is
not a tracker change; a user agent that stops being sent is. Pinning the browser instead would leave
a suite that exists to catch browser behaviour testing a museum.

That list is matched by leaf name anywhere in the event, so a name in it silences that field
everywhere. Keep it to names only the environment owns.

## Re-recording

Every run writes what it measured to `golden.recorded.json`, which is gitignored and uploaded by CI
as the `surface-golden` artifact. There is no flag to set.

```
gh run download <run-id> --name surface-golden --dir trackers/javascript-tracker/test/surface/
mv trackers/javascript-tracker/test/surface/golden.recorded.json trackers/javascript-tracker/test/surface/golden.json
```

Commit the diff. That diff is the review artifact: it states exactly what changed about the event
surface, which is the thing worth arguing about.

A missing `golden.json` fails. The comparison never writes the file it compares against.

## What it does not cover

- **Client hints.** `navigator.userAgentData` exists only in a secure context, and the suite serves
  over plain http on a hostname, so `http_client_hints` is absent from the golden. It does fire in
  production, over https. Nothing here covers that plugin.
- **Browsers other than Chrome.** Saucelabs covered that and is not available on this fork. The
  golden is recorded on headless Chrome, so `wdio.ci.conf` is the only config that runs this spec.
- **Code paths the fixture does not drive.** Absence from the golden means uncovered, not verified.

A schema in the golden recorded locally but missing from the one recorded on CI is worth chasing
rather than accepting: that is how the client hints gap was found.

## Extending the fixture

Lines are keyed by `event_name`, so two events sharing one would merge back into a single set and
hide a field that only one of them stops sending. The fixture drives one of each today.

Check the emitted schema count against the bundle's rather than trusting a pass. Three plugins
reached the fixture only after a correction, and none of the three failures produced an error:

- the enhanced ecommerce field objects attach through `addEnhancedEcommerce*Context`, not the
  `*FieldObject` names, and an unknown command is dropped without a warning;
- `gaCookies` attaches nothing when the `__utm*` cookies are absent;
- `web-vitals` is gated on `contexts.webVitals`, not on being compiled in.

`REQUIRED_SCHEMAS` in the spec is the floor that now catches this.
