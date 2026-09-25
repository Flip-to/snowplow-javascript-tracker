# Engagement time (Flip.to fork plugin)

Measures, per tracker and per page view, how long the page was in use by GA4's rule, how far it was
scrolled, and how much the visitor interacted with it. Reported as the entity
`iglu:to.flip/ft_engagement_time/jsonschema/1-0-0`, whose schema lives in
[`schemas/`](schemas/to.flip/ft_engagement_time/jsonschema/1-0-0) in Iglu static-repository layout.

This package exists only in the Flip.to fork. It is compiled into `sp.lite.js` (served as
`ftsa2.js`) and is inert until a tracker enables it.

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
only while the clock runs. Scroll and pointer positions are sampled once per animation frame.

## Reports

- **Flush.** When a `blur`, `visibilitychange` or `pagehide` leaves the clock stopped, one
  `application_background` event carries the entity, provided at least 1000 ms accrued since the
  previous report. A tab switch fires two of those transitions; the second finds nothing new to
  report, so the pair sends one event.
- **Piggyback** (off by default). Every other event the tracker sends, except page views, carries
  the running total, and a flush it already covered is skipped.
- **SPA page views.** Core replaces the page view id before any plugin sees the new page view, so
  the plugin wraps `trackPageView`: the outgoing page's total is flushed first, with the old id,
  then the totals restart.

Every field is cumulative for the page view in the `web_page` entity, so the last report per page
view is its final value.

## Enabling

Per tracker, in either of two ways:

```js
// At creation
snowplow('newTracker', 'sp', collector, { contexts: { engagementTime: true } });
snowplow('newTracker', 'sp', collector, { contexts: { engagementTime: { piggyback: true } } });

// Afterwards, which is what a GTM "[Custom Command]" tag can send
snowplow('enableEngagementTime:sp', {});
snowplow('enableEngagementTime:sp', '{"piggyback":true}');
```

The command accepts its argument as a JSON string because a GTM custom command passes text.

## Tests

`npx jest test --no-cache` in this directory.
