import { BrowserPlugin, BrowserTracker, dispatchToTrackersInCollection } from '@snowplow/browser-tracker-core';
import { buildSelfDescribingEvent, LOG, PayloadBuilder, SelfDescribingJson } from '@snowplow/tracker-core';

const PAGE_ENGAGEMENT_SCHEMA = 'iglu:to.flip/ft_page_engagement/jsonschema/1-0-0';
const BACKGROUND_SCHEMA = 'iglu:com.snowplowanalytics.snowplow/application_background/jsonschema/1-0-0';
const METHOD_VERSION = 1;
/** A hide needs at least this much foreground time the last report did not carry. */
const FLOOR_MS = 1000;

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
const each = (f: (s: PageState) => void) => Object.keys(states).forEach((id) => f(states[id]));
/** Handlers run on the customer's page, so nothing they do may throw into it. */
const safe = (f: (e?: any) => void) => (e?: any) => {
  try {
    f(e);
  } catch (x) {}
};

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

// Another tracker's page view, or enableAnonymousTracking, can rotate the shared page view id
// under this tracker. The totals so far belong to the old page view, which the entity names.
const rotated = (s: PageState) => s.tracker.getPageViewId() !== s.pageViewId;

function touch(s: PageState, t: number) {
  if (accrue(s, t) && rotated(s)) {
    flush(s, 'page_change');
    reset(s);
  }
}

function entity(s: PageState, reason: PageEngagementReason): SelfDescribingJson {
  const r = Math.round;
  s.maxX = Math.max(s.maxX, window.pageXOffset || 0);
  s.maxY = Math.max(s.maxY, window.pageYOffset || 0);
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
  if (unreported <= 0 || (reason === 'hide' && unreported < FLOOR_MS)) return;
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
  const x = window.pageXOffset || 0,
    y = window.pageYOffset || 0,
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

function install() {
  if (installed) return;
  installed = true;
  // GA4 reads hasFocus() once at start and follows window focus/blur events from then on.
  focused = document.hasFocus();
  visible = document.visibilityState !== 'hidden';
  scrollX = window.pageXOffset || 0;
  scrollY = window.pageYOffset || 0;

  const on = (target: EventTarget, type: string, f: (e?: any) => void, options?: AddEventListenerOptions) =>
      target.addEventListener(type, safe(f), options),
    clock = (target: EventTarget, type: string, update: () => void, reason?: PageEngagementReason) =>
      on(target, type, () => transition(update, reason)),
    input = { passive: true, capture: true },
    // Script-dispatched input is not a visitor's.
    count = (type: string, key: 'clicks' | 'keys' | 'touches') =>
      on(document, type, (e: Event) => e.isTrusted && counting() && each((s) => s[key]++), input);

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
 * configuration names one.
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
      original(configuration as any);
      try {
        if (configuration && configuration.stateStorageStrategy) set(configuration.stateStorageStrategy);
        // With session tracking off, core also rotates the page view id here.
        const t = now();
        each((s) => touch(s, t));
      } catch (e) {}
    };
  });
}

function enable(tracker: BrowserTracker, configuration: PageEngagementConfiguration, settings: TrackerSettings) {
  if (states[tracker.id]) return;
  install();
  if (!settings.keepalive) {
    LOG.warn(`Page engagement on ${tracker.id}: keepalive is off, so the report sent on pagehide can be lost`);
  }
  const s = (states[tracker.id] = { tracker, piggyback: !!configuration.piggyback, sending: false } as PageState);
  reset(s);

  // An SPA page view replaces the page view id before any plugin sees the event, so the outgoing
  // page's total is flushed here, while web_page still carries the old id.
  const trackPageView = tracker.trackPageView;
  tracker.trackPageView = (event) => {
    try {
      touch(s, now());
      flush(s, 'page_change');
    } catch (e) {}
    trackPageView(event);
    try {
      // The id is shared by every tracker on the page, so the others close out now too.
      const t = now();
      each((x) => touch(x, t));
    } catch (e) {}
  };
}

const settingsOf: Record<string, TrackerSettings> = {};

/**
 * Measures engagement time by GA4's rule, scroll depth and interaction counts per page view.
 * Inert until enabled, by passing a configuration here or with enablePageEngagement.
 * `settings` is the tracker configuration, read for its storage strategy and keepalive.
 */
export function PageEngagementPlugin(
  configuration?: boolean | PageEngagementConfiguration,
  settings: TrackerSettings = {}
): BrowserPlugin {
  let trackerId: string;
  return {
    activateBrowserPlugin: (tracker) => {
      trackerId = tracker.id;
      _trackers[trackerId] = tracker;
      settingsOf[trackerId] = settings;
      followConsent(tracker, settings);
      if (configuration) enable(tracker, typeof configuration === 'object' ? configuration : {}, settings);
    },
    beforeTrack: (payloadBuilder: PayloadBuilder) => {
      const s = states[trackerId];
      // A page view starts a new page, so the outgoing page's total does not belong on it.
      if (!s || !s.piggyback || s.sending || payloadBuilder.getPayload().e === 'pv') return;
      if (!accrue(s, now())) return;
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
  dispatchToTrackersInCollection(trackers, _trackers, (t) => enable(t, config, settingsOf[t.id] || {}));
}
