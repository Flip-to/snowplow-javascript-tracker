# Page engagement (Flip.to fork plugin)

Measures, per tracker and per page view, how long the page was in use by GA4's rule, how far it was
scrolled, and how much the visitor interacted with it. Reported as the entity
`iglu:to.flip/ft_page_engagement/jsonschema/1-0-0` (BigQuery column
`contexts_to_flip_ft_page_engagement_1_0_0`), whose schema lives in
[`schemas/`](schemas/to.flip/ft_page_engagement/jsonschema/1-0-0) in Iglu static-repository layout.

This package exists only in the Flip.to fork. It is compiled into `sp.lite.js` (served as
`ftsa2.js`). Activation wraps every tracker's `enableAnonymousTracking` and
`disableAnonymousTracking` to follow consent; nothing is measured or sent until a tracker enables
the plugin.

## Before enabling it anywhere

1. **Publish the schema to our Iglu registry first.** An entity that does not resolve sends the
   event carrying it to bad rows: every `application_background` report, and with piggyback on,
   every other event the tracker sends except page views.
2. **The tracker should have `keepalive: true`.** A page view that ends without a tab switch has
   its only report sent on `pagehide`, and a fetch without keepalive is aborted when the document
   unloads. Platform's trackers set it. If a GTM container cannot be given keepalive, the exit-page
   report can be lost; that is accepted as a fallback on FTK-7844. This is a documented
   precondition only: the plugin does not check it at run time or log anything about it.
3. **One reporter per document.** Only the first tracker enabled on a page measures and reports;
   enabling another, by either path, is a no-op. So the event budget is one set of reports per page
   view, whichever and however many containers send the enable command.

## The clock

It runs only while all three hold, which is what GA4's gtag.js does:

- the window has focus (`blur`/`focus` on `window`, non-capture; `document.hasFocus()` is read once,
  at start). Focus moving into an iframe fires `blur` and pauses it, so an embedded booking engine
  running its own tracker is not counted twice;
- the document is visible (`visibilitychange`);
- the page is active (`pagehide`/`pageshow`).

Time comes from `performance.now()` differences at each transition. There are no timers and no page
pings. `hidden_time_msec` counts time the document was hidden while the page was active, **up to
the last report**: a page closed while hidden sends no further report, so its last hidden stretch
is not in it.

Clicks, key presses (a count, never the key), touches and pointer distance count only while the
clock runs, and only trusted input: events a script dispatches are ignored. Clicks, key presses and
touches on password fields, or on fields whose `autocomplete` is `cc-*`, `one-time-code`,
`current-password` or `new-password` (any case), are not counted, including inside a shadow root.
That limits what a count carried on successive events says about what was typed there; a card field
marked `autocomplete="off"` is still counted. Scroll is measured from the page offset, so it cannot
tell the visitor's scrolling from a script's: `window.scrollTo`, scroll restoration and smooth-scroll
widgets count too. Scroll and pointer positions are sampled once per animation frame; a
right-to-left page's negative x offsets count as distances.

## Consent

The plugin measures only while the tracker's storage strategy is not `'none'`, which is how
consent reaches Flip.to trackers (GTM's "Enable/Disable Cookies" tags and Platform's consent code
both call `enableAnonymousTracking` with `cookieAndLocalStorage` or `none`). It reads the strategy
from the tracker configuration at activation and follows every `enableAnonymousTracking` and
`disableAnonymousTracking` call that names one, as core does, even when core throws part-way.
Under `'none'` it discards anything accrued and sends nothing; a return to consent starts fresh.

`enableAnonymousTracking` with session tracking off also rotates the shared page view id (core calls
`resetPageView()`; `disableAnonymousTracking` does not). That is consent plumbing, not a new page,
so nothing is sent, and the totals stay on the page view that was sent: later reports keep naming
it in `page_view_id` while their `web_page` carries the rotated id. Only when no page view was sent
under the old id do the totals move to the new one.

## Reports

Nothing is reported for an id no page view was sent under, by any tracker on the page.

- **Hide.** When the document is hidden, one `application_background` event carries the entity,
  provided at least 1000 ms accrued since the previous report. Window `blur` only pauses the clock:
  the next report is cumulative, so it carries that time anyway.
- **Pagehide and page change** end the page view, so they report any remainder, however small. The
  last report of a page view that ends in either is exact.
- **Piggyback** (off by default). Every other event the tracker sends, except page views, carries
  the running total, and a hide it already covered sends nothing.
- **SPA page views.** Core replaces the page view id before any plugin sees the new page view, so
  the plugin wraps `trackPageView` and reports the outgoing page first, with `reason:
  'page_change'`. That event carries the outgoing page view in `page_view_id` and in `web_page`.
  Its `page_url` is the **incoming** URL, because core reads the URL when the event is sent and an
  SPA has already changed it. When the page view goes out under a different id, the new page starts
  from zero; when it reuses the id (the first page view, or core keeping the id after a consent
  rotation) the totals continue.
- **Another tracker's page view.** All trackers on a page share one page view id, so a page view on
  one moves it under the reporter. The reporter closes its old page view out at that moment with a
  `page_change` report under the stored `page_view_id`; its `web_page` already carries the new id.
  Key on `page_view_id`, not on `web_page`.

## Enabling

On one tracker per page, in either of two ways:

```js
// At creation
snowplow('newTracker', 'sp', collector, { keepalive: true, contexts: { pageEngagement: true } });
snowplow('newTracker', 'sp', collector, { keepalive: true, contexts: { pageEngagement: { piggyback: true } } });

// Afterwards, which is what a GTM "[Custom Command]" tag can send
snowplow('enablePageEngagement:sp', {});
snowplow('enablePageEngagement:sp', '{"piggyback":true}');
```

The command accepts its argument as a JSON string because a GTM custom command passes text.

## Tests

`npx jest test --no-cache` in this directory.
