# Page engagement (Flip.to fork plugin)

Measures, per tracker and per page view, how long the page was in use by GA4's rule, how far it was
scrolled, and how much the visitor interacted with it. Reported as the entity
`iglu:to.flip/ft_page_engagement/jsonschema/1-0-0` (warehouse column
`contexts_to_flip_ft_page_engagement_1`), whose schema lives in
[`schemas/`](schemas/to.flip/ft_page_engagement/jsonschema/1-0-0) in Iglu static-repository layout.

This package exists only in the Flip.to fork. It is compiled into `sp.lite.js` (served as
`ftsa2.js`) and is inert until a tracker enables it.

## Before enabling it anywhere

1. **Publish the schema to our Iglu registry first.** An entity that does not resolve sends the
   event carrying it to bad rows: every `application_background` report, and with piggyback on,
   every other event the tracker sends except page views.
2. **The tracker needs `keepalive: true`.** A page view that ends without a tab switch has its only
   report sent on `pagehide`, and a fetch without keepalive is aborted when the document unloads.
   Platform's trackers set it; a GTM-created tracker must be given it before this is enabled there.
   When keepalive is off the plugin still works, and logs one warning per tracker.

## The clock

It runs only while all three hold, which is what GA4's gtag.js does:

- the window has focus (`blur`/`focus` on `window`, non-capture; `document.hasFocus()` is read once,
  at start). Focus moving into an iframe fires `blur` and pauses it, so an embedded booking engine
  running its own tracker is not counted twice;
- the document is visible (`visibilitychange`);
- the page is active (`pagehide`/`pageshow`).

Time comes from `performance.now()` differences at each transition. There are no timers and no page
pings. `hidden_time_msec` counts time the document was hidden while the page was active.

Clicks, key presses (a count, never the key), touches, scroll distance and pointer distance count
only while the clock runs, and only trusted input: events a script dispatches are ignored. Scroll
and pointer positions are sampled once per animation frame.

## Consent

The plugin measures only while the tracker's storage strategy is not `'none'`, which is how
consent reaches Flip.to trackers (GTM's "Enable/Disable Cookies" tags and Platform's consent code
both call `enableAnonymousTracking` with `cookieAndLocalStorage` or `none`). It reads the strategy
from the tracker configuration at activation and follows every `enableAnonymousTracking` and
`disableAnonymousTracking` call that names one, as core does. Under `'none'` it discards anything
accrued and sends nothing; a return to consent starts fresh.

## Reports

- **Hide.** When the document is hidden, one `application_background` event carries the entity,
  provided at least 1000 ms accrued since the previous report. Window `blur` only pauses the clock:
  the next report is cumulative, so it carries that time anyway.
- **Pagehide and page change** end the page view, so they report any remainder, however small. The
  last report of a page view that ends in either is exact.
- **Piggyback** (off by default). Every other event the tracker sends, except page views, carries
  the running total, and a hide it already covered sends nothing.
- **SPA page views.** Core replaces the page view id before any plugin sees the new page view, so
  the plugin wraps `trackPageView` and reports the outgoing page first, with `reason:
  'page_change'`. That event carries the outgoing page view in `web_page` and in `page_view_id`, and
  the **incoming** `page_url`, because core reads the URL when the event is sent and an SPA has
  already changed it.
- **A page view id that moves underneath.** All trackers on a page share one page view id, and
  `enableAnonymousTracking` rotates it when session tracking is off. The entity's `page_view_id` is
  the page view its totals belong to; when the id moves, the plugin closes the old page view out
  with a `page_change` report under that `page_view_id` and starts the new one at zero. Key on
  `page_view_id`, not on `web_page`.

## Enabling

Per tracker, in either of two ways:

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
