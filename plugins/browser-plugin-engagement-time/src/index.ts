import { BrowserPlugin, BrowserTracker, dispatchToTrackersInCollection } from '@snowplow/browser-tracker-core';
import { buildSelfDescribingEvent, PayloadBuilder, SelfDescribingJson } from '@snowplow/tracker-core';

const ENGAGEMENT_TIME_SCHEMA = 'iglu:to.flip/ft_engagement_time/jsonschema/1-0-0';
const BACKGROUND_SCHEMA = 'iglu:com.snowplowanalytics.snowplow/application_background/jsonschema/1-0-0';
const METHOD_VERSION = 1;
/** A flush needs at least this much foreground time the last report did not carry. */
const FLOOR_MS = 1000;

export type EngagementReason = 'hide' | 'blur' | 'pagehide' | 'piggyback' | 'page_change';

export interface EngagementTimeConfiguration {
  /** Attach the running total to every event the tracker sends, except page views. Default false. */
  piggyback?: boolean;
}

interface PageState {
  tracker: BrowserTracker;
  piggyback: boolean;
  sending: boolean;
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
const each = (f: (s: PageState) => void) => {
  for (const id in states) f(states[id]);
};
/** Handlers run on the customer's page, so nothing they do may throw into it. */
const safe = (f: (e?: any) => void) => (e?: any) => {
  try {
    f(e);
  } catch (x) {}
};

function accrue(s: PageState, t: number) {
  const dt = t - s.last;
  if (dt > 0) {
    if (counting()) s.engaged += dt;
    else if (!visible && active) s.hidden += dt;
  }
  s.last = t;
}

function entity(s: PageState, reason: EngagementReason): SelfDescribingJson {
  const d = document.documentElement,
    r = Math.round;
  s.maxX = Math.max(s.maxX, window.pageXOffset || 0);
  s.maxY = Math.max(s.maxY, window.pageYOffset || 0);
  s.reported = s.engaged;
  return {
    schema: ENGAGEMENT_TIME_SCHEMA,
    data: {
      total_engagement_time_msec: r(s.engaged),
      hidden_time_msec: r(s.hidden),
      total_clicks: s.clicks,
      total_key_presses: s.keys,
      total_touches: s.touches,
      total_scroll_distance_px: r(s.scroll),
      total_mouse_distance_px: r(s.mouse),
      max_scroll_y_px: r(s.maxY),
      max_scroll_x_px: r(s.maxX),
      content_height_px: d.scrollHeight,
      content_width_px: d.scrollWidth,
      viewport_height_px: window.innerHeight,
      reason,
      method_version: METHOD_VERSION,
    },
  };
}

function flush(s: PageState, reason: EngagementReason) {
  if (s.engaged - s.reported < FLOOR_MS) return;
  s.sending = true;
  try {
    s.tracker.core.track(buildSelfDescribingEvent({ event: { schema: BACKGROUND_SCHEMA, data: {} } }), [
      entity(s, reason),
    ]);
  } finally {
    s.sending = false;
  }
}

/** Applies a change to the clock inputs, flushing when the clock is left stopped. */
function transition(update: () => void, reason: EngagementReason) {
  const t = now();
  each((s) => accrue(s, t));
  update();
  // A tab switch fires blur and visibilitychange together. The first stops the clock and flushes;
  // nothing accrues before the second, so the floor skips it and the pair sends one event.
  if (!counting()) each((s) => flush(s, reason));
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
    clock = (target: EventTarget, type: string, reason: EngagementReason, update: () => void) =>
      on(target, type, () => transition(update, reason)),
    input = { passive: true, capture: true },
    count = (type: string, key: 'clicks' | 'keys' | 'touches') =>
      on(document, type, () => counting() && each((s) => s[key]++), input);

  // Non-capture, as GA4: focus moving into an iframe fires window blur and pauses the clock.
  clock(window, 'blur', 'blur', () => (focused = false));
  clock(window, 'focus', 'blur', () => (focused = true));
  clock(document, 'visibilitychange', 'hide', () => (visible = document.visibilityState !== 'hidden'));
  clock(window, 'pagehide', 'pagehide', () => (active = false));
  clock(window, 'pageshow', 'pagehide', () => (active = true));
  on(window, 'scroll', requestFrame, { passive: true });
  on(
    document,
    'mousemove',
    (e: MouseEvent) => {
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

function reset(s: PageState) {
  s.engaged = s.hidden = s.reported = s.clicks = s.keys = s.touches = s.scroll = s.mouse = s.maxX = s.maxY = 0;
  s.last = now();
}

function enable(tracker: BrowserTracker, configuration: EngagementTimeConfiguration) {
  if (states[tracker.id]) return;
  install();
  const s = (states[tracker.id] = { tracker, piggyback: !!configuration.piggyback, sending: false } as PageState);
  reset(s);

  // An SPA page view replaces the page view id before any plugin sees the event, so the outgoing
  // page's total is flushed here, while the web_page entity still carries the old id.
  const trackPageView = tracker.trackPageView;
  tracker.trackPageView = (event) => {
    let before: string | undefined;
    try {
      before = tracker.getPageViewId();
      accrue(s, now());
      flush(s, 'page_change');
    } catch (e) {}
    trackPageView(event);
    try {
      if (before !== undefined && tracker.getPageViewId() !== before) reset(s);
    } catch (e) {}
  };
}

/**
 * Measures engagement time by GA4's rule, scroll depth and interaction counts per page view.
 * Inert until enabled, by passing a configuration here or with enableEngagementTime.
 */
export function EngagementTimePlugin(configuration?: boolean | EngagementTimeConfiguration): BrowserPlugin {
  let trackerId: string;
  return {
    activateBrowserPlugin: (tracker) => {
      trackerId = tracker.id;
      _trackers[trackerId] = tracker;
      if (configuration) enable(tracker, typeof configuration === 'object' ? configuration : {});
    },
    beforeTrack: (payloadBuilder: PayloadBuilder) => {
      const s = states[trackerId];
      // A page view starts a new page, so the outgoing page's total does not belong on it.
      if (!s || !s.piggyback || s.sending || payloadBuilder.getPayload().e === 'pv') return;
      accrue(s, now());
      payloadBuilder.addContextEntity(entity(s, 'piggyback'));
    },
  };
}

/**
 * Starts measuring on the given trackers. Accepts a JSON string as well as an object, because a
 * GTM custom command passes its argument as text.
 */
export function enableEngagementTime(
  configuration?: EngagementTimeConfiguration | string,
  trackers: Array<string> = Object.keys(_trackers)
) {
  let c: unknown = configuration;
  if (typeof c === 'string') {
    try {
      c = JSON.parse(c);
    } catch (e) {}
  }
  const config = c && typeof c === 'object' && !Array.isArray(c) ? (c as EngagementTimeConfiguration) : {};
  dispatchToTrackersInCollection(trackers, _trackers, (t) => enable(t, config));
}
