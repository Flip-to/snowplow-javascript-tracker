import { BrowserPlugin, BrowserTracker, dispatchToTrackersInCollection } from '@snowplow/browser-tracker-core';
import { buildSelfDescribingEvent, LOG, PayloadBuilder, SelfDescribingJson } from '@snowplow/tracker-core';

const PAGE_ENGAGEMENT_SCHEMA = 'iglu:to.flip/ft_page_engagement/jsonschema/1-0-0';
const BACKGROUND_SCHEMA = 'iglu:com.snowplowanalytics.snowplow/application_background/jsonschema/1-0-0';
const METHOD_VERSION = 1;
/** A hide needs at least this much foreground time the last report did not carry. */
const FLOOR_MS = 1000;
/** Keys typed here are not counted: with piggyback, the change in the count would give away a length. */
const SENSITIVE_AUTOCOMPLETE = /(^|\s)(cc-|one-time-code|current-password)/;

export type PageEngagementReason = 'hide' | 'pagehide' | 'piggyback' | 'page_change';

export interface PageEngagementConfiguration {
  /** Attach the running total to every event the tracker sends, except page views. Default false. */
  piggyback?: boolean;
}

/** The parts of the tracker configuration the plugin reads at activation. */
export interface TrackerSettings {
  stateStorageStrategy?: string;
  keepalive?: boolean;
}

interface PageState {
  tracker: BrowserTracker;
  piggyback: boolean;
  sending: boolean;
  /** The page view every total below belongs to. */
  pageViewId: string;
  /** The id this tracker last sent a page view under. */
  sentPageViewId?: string;
  /** Set when a page view goes out during this tracker's own trackPageView call. */
  pageViewTracked: boolean;
  /** Clock reading the totals below are accrued up to. */
  last: number;
  engaged: number;
  hidden: number;
  /** `engaged` when the last report was made. */
  reported: number;
  clicks: number;
  keys: number;
  touches: number;
  scroll: number;
  mouse: number;
  maxX: number;
  maxY: number;
}

const _trackers: Record<string, BrowserTracker> = {};
const states: Record<string, PageState> = {};
/** Per tracker: false while its storage strategy is 'none', i.e. no analytics consent. */
const consented: Record<string, boolean> = {};
const keepaliveOff: Record<string, boolean> = {};

// Window-wide clock inputs, shared by every tracker on the page.
let installed = false,
  focused = true,
  visible = true,
  active = true,
  scrollX = 0,
  scrollY = 0,
  mouseX: number | undefined,
  mouseY = 0,
  nextX: number | undefined,
  nextY = 0,
  framePending = false;

const now = () => performance.now();
const counting = () => focused && visible && active;
/** Enabled trackers with consent in effect. */
const each = (f: (s: PageState) => void) => Object.keys(states).forEach((id) => consented[id] && f(states[id]));
/** Handlers run on the customer's page, so nothing they do may throw into it. */
const safe = (f: (e?: any) => void) => (e?: any) => {
  try {
    f(e);
  } catch (x) {}
};
/** An RTL page scrolls to negative x offsets. */
const offsetX = () => Math.abs(window.pageXOffset || 0);
const offsetY = () => window.pageYOffset || 0;

function reset(s: PageState) {
  s.engaged = s.hidden = s.reported = s.clicks = s.keys = s.touches = s.scroll = s.mouse = s.maxX = s.maxY = 0;
  s.pageViewId = s.tracker.getPageViewId();
  s.last = now();
}

/**
 * Brings a tracker's totals up to now. Without consent nothing accrues: the totals were discarded
 * when consent went, and a grant starts them afresh, so nothing measured meanwhile can be sent.
 */
function accrue(s: PageState, t: number) {
  if (!consented[s.tracker.id]) return false;
  const dt = t - s.last;
  if (dt > 0) {
    if (counting()) s.engaged += dt;
    else if (!visible && active) s.hidden += dt;
  }
  s.last = t;
  return true;
}

// Another tracker's page view can rotate the shared page view id under this tracker. The totals
// so far belong to the old page view, which the entity names.
const rotated = (s: PageState) => s.tracker.getPageViewId() !== s.pageViewId;

function touch(s: PageState, t: number) {
  if (accrue(s, t) && rotated(s)) {
    flush(s, 'page_change');
    reset(s);
  }
}

function entity(s: PageState, reason: PageEngagementReason): SelfDescribingJson {
  const r = Math.round;
  s.maxX = Math.max(s.maxX, offsetX());
  s.maxY = Math.max(s.maxY, offsetY());
  s.reported = s.engaged;
  return {
    schema: PAGE_ENGAGEMENT_SCHEMA,
    data: {
      page_view_id: s.pageViewId,
      total_engagement_time_msec: r(s.engaged),
      hidden_time_msec: r(s.hidden),
      total_clicks: s.clicks,
      total_key_presses: s.keys,
      total_touches: s.touches,
      total_scroll_distance_px: r(s.scroll),
      total_mouse_distance_px: r(s.mouse),
      max_scroll_y_px: r(s.maxY),
      max_scroll_x_px: r(s.maxX),
      reason,
      method_version: METHOD_VERSION,
    },
  };
}

/** A hide waits for the floor; pagehide and page_change end the page view, so any remainder goes. */
function flush(s: PageState, reason: PageEngagementReason) {
  const unreported = s.engaged - s.reported;
  if (!consented[s.tracker.id] || unreported <= 0 || (reason === 'hide' && unreported < FLOOR_MS)) return;
  s.sending = true;
  try {
    s.tracker.core.track(buildSelfDescribingEvent({ event: { schema: BACKGROUND_SCHEMA, data: {} } }), [
      entity(s, reason),
    ]);
  } finally {
    s.sending = false;
  }
}

/** Applies a change to the clock inputs; `reason` flushes when it leaves the clock stopped. */
function transition(update: () => void, reason?: PageEngagementReason) {
  const t = now();
  each((s) => touch(s, t));
  update();
  // A tab switch fires blur and visibilitychange together. Blur only pauses; the hide flushes,
  // and a pagehide after it finds nothing new, so the sequence sends one event.
  if (reason && !counting()) each((s) => flush(s, reason));
}

function frame() {
  framePending = false;
  const x = offsetX(),
    y = offsetY(),
    scrolled = Math.abs(x - scrollX) + Math.abs(y - scrollY);
  let moved = 0;
  if (nextX !== undefined) {
    if (mouseX !== undefined)
      moved = Math.sqrt((nextX - mouseX) * (nextX - mouseX) + (nextY - mouseY) * (nextY - mouseY));
    mouseX = nextX;
    mouseY = nextY;
    nextX = undefined;
  }
  scrollX = x;
  scrollY = y;
  const c = counting();
  each((s) => {
    s.maxX = Math.max(s.maxX, x);
    s.maxY = Math.max(s.maxY, y);
    if (c) {
      s.scroll += scrolled;
      s.mouse += moved;
    }
  });
}

function requestFrame() {
  if (!framePending) {
    framePending = true;
    requestAnimationFrame(safe(frame));
  }
}

function sensitive(e: Event) {
  const t = e.target as HTMLInputElement | null;
  return (
    !!t &&
    typeof t.getAttribute === 'function' &&
    (t.type === 'password' || SENSITIVE_AUTOCOMPLETE.test(t.getAttribute('autocomplete') || ''))
  );
}

function install() {
  if (installed) return;
  installed = true;
  // GA4 reads hasFocus() once at start and follows window focus/blur events from then on.
  focused = document.hasFocus();
  visible = document.visibilityState !== 'hidden';
  scrollX = offsetX();
  scrollY = offsetY();

  const on = (target: EventTarget, type: string, f: (e?: any) => void, options?: AddEventListenerOptions) =>
      target.addEventListener(type, safe(f), options),
    clock = (target: EventTarget, type: string, update: () => void, reason?: PageEngagementReason) =>
      on(target, type, () => transition(update, reason)),
    input = { passive: true, capture: true },
    // Script-dispatched input is not a visitor's.
    count = (type: string, key: 'clicks' | 'keys' | 'touches') =>
      on(document, type, (e: Event) => e.isTrusted && counting() && !sensitive(e) && each((s) => s[key]++), input);

  // Non-capture, as GA4: focus moving into an iframe fires window blur and pauses the clock.
  clock(window, 'blur', () => (focused = false));
  clock(window, 'focus', () => (focused = true));
  clock(document, 'visibilitychange', () => (visible = document.visibilityState !== 'hidden'), 'hide');
  clock(window, 'pagehide', () => (active = false), 'pagehide');
  clock(window, 'pageshow', () => (active = true));
  on(window, 'scroll', requestFrame, { passive: true });
  on(
    document,
    'mousemove',
    (e: MouseEvent) => {
      if (!e.isTrusted) return;
      nextX = e.clientX;
      nextY = e.clientY;
      requestFrame();
    },
    input
  );
  count('click', 'clicks');
  count('keydown', 'keys');
  count('touchstart', 'touches');
}

/**
 * Follows the tracker's storage strategy, which is how consent reaches it on Flip.to pages: 'none'
 * means no analytics consent. Mirrors core, where each call changes the strategy only when its
 * configuration names one. The call may also rotate the shared page view id; that is consent
 * plumbing, not a new page, so totals carry over to the new id and nothing is sent.
 */
function followConsent(tracker: BrowserTracker, settings: TrackerSettings) {
  const id = tracker.id,
    set = (strategy: string) => {
      const was = consented[id];
      consented[id] = strategy !== 'none';
      const s = states[id];
      // Nothing accrued before a decline is sent, and a grant starts fresh.
      if (s && was !== consented[id]) reset(s);
    };
  set(settings.stateStorageStrategy || 'cookieAndLocalStorage');
  (['enableAnonymousTracking', 'disableAnonymousTracking'] as const).forEach((name) => {
    const original = tracker[name];
    tracker[name] = (configuration?: { stateStorageStrategy?: string }) => {
      const before = tracker.getPageViewId();
      original(configuration as any);
      safe(() => {
        if (configuration && configuration.stateStorageStrategy) set(configuration.stateStorageStrategy);
        const after = tracker.getPageViewId();
        if (after === before) return;
        // Every state on the old id moves with it, this tracker's and the others', unsent.
        Object.keys(states).forEach((k) => {
          const s = states[k];
          if (s.pageViewId === before) s.pageViewId = after;
          if (s.sentPageViewId === before) s.sentPageViewId = after;
        });
      })();
    };
  });
}

function enable(tracker: BrowserTracker, configuration: PageEngagementConfiguration) {
  if (states[tracker.id]) return;
  install();
  if (keepaliveOff[tracker.id]) {
    LOG.debug(`Page engagement on ${tracker.id}: keepalive is off, so the report sent on pagehide can be lost`);
  }
  const s = (states[tracker.id] = {
    tracker,
    piggyback: !!configuration.piggyback,
    sending: false,
    pageViewTracked: false,
  } as PageState);
  reset(s);

  // An SPA page view replaces the page view id before any plugin sees the event, so the outgoing
  // page's total is flushed here, while web_page still carries the old id. Nothing goes out before
  // this tracker's first page view: there is no page view to report on yet.
  const trackPageView = tracker.trackPageView;
  tracker.trackPageView = (event) => {
    safe(() => {
      const t = now();
      touch(s, t);
      if (s.sentPageViewId === s.pageViewId) flush(s, 'page_change');
    })();
    s.pageViewTracked = false;
    trackPageView(event);
    safe(() => {
      // A new page starts from zero; the time trackPageView itself took is not reported.
      if (s.pageViewTracked) reset(s);
      // The id is shared by every tracker on the page, so the others close out now.
      const t = now();
      each((x) => x !== s && touch(x, t));
    })();
  };
}

/**
 * Measures engagement time by GA4's rule, scroll depth and interaction counts per page view.
 * Activation wraps the tracker's enableAnonymousTracking and disableAnonymousTracking to follow
 * consent; measuring starts only when enabled, here or with enablePageEngagement. `settings` is
 * the tracker configuration, read for its storage strategy and keepalive.
 */
export function PageEngagementPlugin(
  configuration: boolean | PageEngagementConfiguration | undefined,
  settings: TrackerSettings
): BrowserPlugin {
  let trackerId: string;
  return {
    activateBrowserPlugin: (tracker) => {
      trackerId = tracker.id;
      _trackers[trackerId] = tracker;
      keepaliveOff[trackerId] = !settings.keepalive;
      followConsent(tracker, settings);
      if (configuration) enable(tracker, typeof configuration === 'object' ? configuration : {});
    },
    beforeTrack: (payloadBuilder: PayloadBuilder) => {
      const s = states[trackerId];
      if (!s || s.sending) return;
      if (payloadBuilder.getPayload().e === 'pv') {
        s.sentPageViewId = s.tracker.getPageViewId();
        s.pageViewTracked = true;
        // A page view starts a new page, so the outgoing page's total does not belong on it.
        return;
      }
      if (!s.piggyback || !accrue(s, now())) return;
      // Carries the totals so far; if the id rotated they close out here, not in a nested event.
      payloadBuilder.addContextEntity(entity(s, 'piggyback'));
      if (rotated(s)) reset(s);
    },
  };
}

/**
 * Starts measuring on the given trackers. Accepts a JSON string as well as an object, because a
 * GTM custom command passes its argument as text.
 */
export function enablePageEngagement(
  configuration?: PageEngagementConfiguration | string,
  trackers: Array<string> = Object.keys(_trackers)
) {
  let c: unknown = configuration;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch (e) {}
  }
  const config = c && typeof c === 'object' && !Array.isArray(c) ? (c as PageEngagementConfiguration) : {};
  dispatchToTrackersInCollection(trackers, _trackers, (t) => enable(t, config));
}
