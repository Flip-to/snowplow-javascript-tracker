# Page engagement (Flip.to fork plugin)

Measures, per page view and with one reporting tracker per document, how long the page was in use by GA4's rule, how far it was
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
`current-password` or `new-password` (any case), are not counted, including inside an open shadow root.
That limits what a count carried on successive events says about what was typed there. Not covered:
email, tel and address fields (they are counted, so with piggyback on the change in `total_key_presses`
between events leaks the typed length: keep piggyback opt-in), a card field marked `autocomplete="off"`, a password field a show-password toggle has switched to
`type="text"` without an `autocomplete` value, and fields inside a closed shadow root. Scroll is measured from the page offset, so it cannot
tell the visitor's scrolling from a script's: `window.scrollTo`, scroll restoration and smooth-scroll
widgets count too. Scroll and pointer positions are sampled once per animation frame; a
right-to-left page's negative x offsets count as distances.

## Consent

The plugin measures only while the tracker's storage strategy is not `'none'`, which is how
consent reaches Flip.to trackers (GTM's "Enable/Disable Cookies" tags and Platform's consent code
both call `enableAnonymousTracking` with `cookieAndLocalStorage` or `none`). It reads the strategy
from the tracker configuration at activation and follows every `enableAnonymousTracking` and
`disableAnonymousTracking` call that names one, as core does, even when core throws part-way.
Under `'none'` it discards anything accrued and sends nothing new (a report the tracker already
holds when the decline arrives still goes out, whether a failed send awaiting retry or one batched
and not yet flushed); a return to consent starts fresh.
If a report was already sent for the page, a decline and a later grant restart its totals under the
same `page_view_id`, so its latest report is not its full total in that rare case.

Only the reporter's own consent governs the measurement. The reporter is the tracker that enabled
the plugin first, and it stays so even while that tracker is at `'none'`: a later enable on another
tracker is a no-op, and a decline on a tracker that is not the reporter does not stop it (it only
moves the shared id, below). That is fine while Flip.to declines all its trackers together.

`enableAnonymousTracking` with anonymous session tracking off also rotates the shared page view id
(core calls `resetPageView()`; `disableAnonymousTracking` does not). GTM's Enable Cookies tag and
Platform's consent code grant with `options: false`, which is that case. That is consent plumbing, not a new page,
so nothing is sent, and the totals stay on the page view that was sent: later reports keep naming
it in `page_view_id` while their `web_page` carries the rotated id. Only when no page view was sent
under the old id do the totals move to the new one. Decided behaviour, so a decline that rotates the
id leaves the totals on the old id too: after a re-grant, the page's own events carry the rotated
`web_page` id while the plugin's reports keep naming the pre-decline page view in `page_view_id`.
Join on `page_view_id`. A tracker enabled right after such a rotation
(GTM's grant fires "Enable Cookies" before the enable tag) reports on its own page view the same way.

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
  'page_change'`, once this tracker has sent a page view for it. That event carries the outgoing
  page view in `page_view_id`, and in `web_page` unless a consent rotation already moved it.
  When the reporter's first page view comes after another tracker's and a consent rotation, the same
  report closes out the page view that other tracker started, and its `web_page` is likewise the
  new id. Its `page_url` is the **incoming** URL, because core reads the URL when the event is sent and an
  SPA has already changed it. When the page view goes out under a different id (including core
  reusing an id a consent rotation made), the new page starts from zero; when it reuses the id the
  reporter is on (the tracker's first page view on the page), the totals continue. A page view the
  reporter re-fires on the id it already holds (core kept it, for example under
  `preservePageViewId`) is not a new page: the report before it still goes out, labelled
  `page_change`, and the totals continue, so the latest report per page view stays its running total.
- **Another tracker's page view.** All trackers on a page share one page view id. Another
  tracker's first page view joins the current page. Any later one is a navigation when it goes out
  under an id other than the reporter's: the plugin compares ids, so one that keeps the id
  (`preservePageViewId`, or `preservePageViewIdForUrl` matching) is not one, and a manual
  `resetPageView` or a page view from a tracker without the plugin is seen only at the next page
  view the plugin sees. The reporter closes its page out at that moment with a `page_change` report
  under the stored `page_view_id` (its `web_page` already carries the new id) and starts the next
  at zero. Without consent it follows the navigation without a report. Key on `page_view_id`, not
  on `web_page`.
- **Piggyback** carries nothing while no page view has been sent under the id.

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
