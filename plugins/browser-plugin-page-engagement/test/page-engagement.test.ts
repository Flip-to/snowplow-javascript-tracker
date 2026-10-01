import fs from 'fs';
import path from 'path';

type Plugin = typeof import('../src');
type Core = typeof import('@snowplow/browser-tracker-core');
type TrackerCore = typeof import('@snowplow/tracker-core');

const SCHEMA_PATH = path.join(__dirname, '..', 'schemas', 'to.flip', 'ft_page_engagement', 'jsonschema', '1-0-0');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
const ENTITY = 'iglu:to.flip/ft_page_engagement/jsonschema/1-0-0';
const BACKGROUND = 'iglu:com.snowplowanalytics.snowplow/application_background/jsonschema/1-0-0';
const WEB_PAGE = 'iglu:com.snowplowanalytics.snowplow/web_page/jsonschema/1-0-0';

// Controlled clock, visibility, focus, scroll offsets and animation frames.
let clock = 0;
/** Added on every performance.now() call when set: a real clock never reads the same twice. */
let tick = 0;
let visibility = 'visible';
let hasFocus = true;
let frames: Array<() => void> = [];

Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
Object.defineProperty(window, 'pageXOffset', { configurable: true, writable: true, value: 0 });
Object.defineProperty(window, 'pageYOffset', { configurable: true, writable: true, value: 0 });
jest.spyOn(performance, 'now').mockImplementation(() => (clock += tick));
jest.spyOn(document, 'hasFocus').mockImplementation(() => hasFocus);
(window as any).requestAnimationFrame = (f: () => void) => {
  frames.push(f);
  return frames.length;
};

const advance = (ms: number) => (clock += ms);
const runFrames = () => {
  const pending = frames;
  frames = [];
  pending.forEach((f) => f());
};
const setScroll = (x: number, y: number) => {
  (window as any).pageXOffset = x;
  (window as any).pageYOffset = y;
  window.dispatchEvent(new Event('scroll'));
};
const hide = () => {
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
};
const show = () => {
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
};
const blur = () => window.dispatchEvent(new Event('blur'));
const focus = () => window.dispatchEvent(new Event('focus'));

interface Sent {
  e: string;
  ue?: any;
  contexts: Array<{ schema: string; data: any }>;
}

let trackerCounter = 0;

/** Calls the listeners the plugin registered with an event the browser would mark trusted. */
const trusted = (target: EventTarget, type: string, props: Record<string, unknown> = {}) =>
  added
    .filter(([t, ty]) => t === target && ty === type)
    .forEach(([, , listener]) => listener({ isTrusted: true, type, ...props }));

/** A fresh plugin module per test: its clock inputs are module state. */
function setup(
  pluginConfig?: boolean | { piggyback?: boolean },
  trackerCount = 1,
  { strategy = 'cookieAndLocalStorage', pageView = true }: { strategy?: string; pageView?: boolean } = {}
) {
  let plugin!: Plugin;
  let core!: Core;
  let trackerCore!: TrackerCore;
  jest.isolateModules(() => {
    plugin = require('../src');
    core = require('@snowplow/browser-tracker-core');
    trackerCore = require('@snowplow/tracker-core');
  });
  const state = new core.SharedState();
  const trackers = Array.from({ length: trackerCount }, () => {
    const id = `sp${++trackerCounter}`;
    const store = trackerCore.newInMemoryEventStore({});
    const tracker = core.addTracker(id, id, 'js-test', '', state, {
      encodeBase64: false,
      plugins: [plugin.PageEngagementPlugin(pluginConfig, { stateStorageStrategy: strategy })],
      stateStorageStrategy: strategy as any,
      eventStore: store,
      customFetch: async () => new Response(null, { status: 500 }),
      contexts: { webPage: true },
    })!;
    const sent = async (): Promise<Sent[]> =>
      ((await store.getAllPayloads()) as any[]).map((p) => ({
        e: p.e,
        ue: p.ue_pr ? JSON.parse(p.ue_pr).data : undefined,
        contexts: p.co ? JSON.parse(p.co).data : [],
      }));
    return { id, tracker, sent, track: trackerCore.buildStructEvent };
  });
  // Nothing is reported for an id no page view was sent under, so most tests start after one.
  if (pageView) trackers.forEach((x) => x.tracker.trackPageView());
  return { plugin, core, trackerCore, trackers, t: trackers[0] };
}

/** BrowserTracker has no trackStructEvent; the browser-tracker API calls core.track like this. */
const struct = (t: { tracker: any; track: (e: { category: string; action: string }) => any }) =>
  t.tracker.core.track(t.track({ category: 'c', action: 'a' }));
const entityOf = (event: Sent) => event.contexts.find((c) => c.schema === ENTITY)?.data;
const pageViewIdOf = (event: Sent) => event.contexts.find((c) => c.schema === WEB_PAGE)?.data.id;
const reports = (events: Sent[]) => events.filter((e) => e.ue?.schema === BACKGROUND);

/** Checks an entity against the schema file itself, for the keywords that file uses. */
function schemaErrors(data: Record<string, unknown>): string[] {
  const errors: string[] = [];
  schema.required.forEach((k: string) => k in data || errors.push(`missing ${k}`));
  Object.keys(data).forEach((k) => {
    const prop = schema.properties[k];
    const v = data[k] as any;
    if (!prop) return errors.push(`unexpected ${k}`);
    if (prop.type === 'integer' && !Number.isInteger(v)) errors.push(`${k} not an integer`);
    if (prop.type === 'string' && typeof v !== 'string') errors.push(`${k} not a string`);
    if (prop.minimum !== undefined && v < prop.minimum) errors.push(`${k} below minimum`);
    if (prop.maximum !== undefined && v > prop.maximum) errors.push(`${k} above maximum`);
    if (prop.enum && prop.enum.indexOf(v) === -1) errors.push(`${k} not in enum`);
    if (prop.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
      errors.push(`${k} not a uuid`);
    return undefined;
  });
  return errors;
}

// Each test loads a fresh module, which installs its own listeners. Record them so the next test
// does not see an earlier module schedule frames or react to its transitions.
let added: Array<[EventTarget, string, any, any]> = [];
[window, document].forEach((target) => {
  const original = target.addEventListener.bind(target);
  jest.spyOn(target, 'addEventListener').mockImplementation((type: string, listener: any, options?: any) => {
    added.push([target, type, listener, options]);
    original(type, listener, options);
  });
});

beforeEach(() => {
  clock = 1000;
  tick = 0;
  visibility = 'visible';
  hasFocus = true;
  frames = [];
  (window as any).pageXOffset = 0;
  (window as any).pageYOffset = 0;
});

afterEach(() => {
  added.forEach(([target, type, listener, options]) => target.removeEventListener(type, listener, options));
  added = [];
});

describe('off by default', () => {
  it('sends nothing and attaches nothing when never enabled', async () => {
    const { t } = setup(undefined, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(5000);
    blur();
    hide();
    window.dispatchEvent(new Event('pagehide'));
    struct(t);
    const events = await t.sent();
    expect(events.map((e) => e.e)).toEqual(['pv', 'se']);
    expect(events.filter(entityOf)).toEqual([]);
  });
});

describe('GA4 clock rule', () => {
  it('flushes the foreground time on hide', async () => {
    const { t } = setup(true);
    advance(3000);
    hide();
    const sent = reports(await t.sent());
    expect(sent.length).toBe(1);
    expect(sent[0].ue.data).toEqual({});
    expect(entityOf(sent[0])).toMatchObject({ total_engagement_time_msec: 3000, reason: 'hide', method_version: 1 });
  });

  it('pauses on window blur without reporting, even though hasFocus() still reports true, as an iframe does', async () => {
    const { t } = setup(true);
    advance(2000);
    blur(); // focus moved into an iframe: hasFocus() stays true
    expect(reports(await t.sent())).toEqual([]);
    advance(8100);
    focus();
    advance(1500);
    hide();
    const totals = reports(await t.sent()).map((e) => [entityOf(e).reason, entityOf(e).total_engagement_time_msec]);
    expect(totals).toEqual([['hide', 3500]]);
  });

  it('does not count until focus when the page starts unfocused', async () => {
    hasFocus = false;
    const { t } = setup(true);
    advance(4000);
    focus();
    advance(1200);
    hide();
    expect(reports(await t.sent()).map((e) => entityOf(e).total_engagement_time_msec)).toEqual([1200]);
  });

  it('stops on pagehide and resumes on pageshow', async () => {
    const { t } = setup(true);
    advance(1500);
    window.dispatchEvent(new Event('pagehide'));
    advance(10000);
    window.dispatchEvent(new Event('pageshow'));
    advance(1000);
    hide();
    const sent = reports(await t.sent()).map((e) => [entityOf(e).reason, entityOf(e).total_engagement_time_msec]);
    expect(sent).toEqual([
      ['pagehide', 1500],
      ['hide', 2500],
    ]);
  });

  it('sends one event for blur, hidden and pagehide a few ms apart', async () => {
    const { t } = setup(true);
    advance(2000);
    blur();
    advance(3);
    hide();
    advance(2);
    window.dispatchEvent(new Event('pagehide'));
    const sent = reports(await t.sent());
    expect(sent.length).toBe(1);
    expect(entityOf(sent[0])).toMatchObject({ reason: 'hide', total_engagement_time_msec: 2000 });
  });

  it('skips a hide below the 1 s floor and carries the time into the next report', async () => {
    const { t } = setup(true);
    advance(900);
    hide();
    expect(reports(await t.sent())).toEqual([]);
    show();
    advance(200);
    hide();
    const sent = reports(await t.sent());
    expect(sent.map((e) => entityOf(e).total_engagement_time_msec)).toEqual([1100]);
  });

  it('reports a remainder under the floor on pagehide, so the final value is exact', async () => {
    const { t } = setup(true);
    advance(2000);
    hide();
    show();
    advance(400);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    const sent = reports(await t.sent()).map((e) => [entityOf(e).reason, entityOf(e).total_engagement_time_msec]);
    expect(sent).toEqual([
      ['hide', 2000],
      ['pagehide', 2400],
    ]);
  });

  it('is cumulative across hides and measures hidden time', async () => {
    const { t } = setup(true);
    advance(2000);
    hide();
    advance(3000);
    show();
    advance(1500);
    hide();
    const sent = reports(await t.sent()).map(entityOf);
    expect(sent.map((d) => d.total_engagement_time_msec)).toEqual([2000, 3500]);
    expect(sent.map((d) => d.hidden_time_msec)).toEqual([0, 3000]);
  });

  it('keeps running when focus moves between elements of the page', async () => {
    const { t } = setup(true);
    const input = document.createElement('input');
    document.body.appendChild(input);
    advance(1000);
    input.dispatchEvent(new FocusEvent('blur'));
    advance(1000);
    hide();
    input.remove();
    expect(reports(await t.sent()).map((e) => entityOf(e).total_engagement_time_msec)).toEqual([2000]);
  });

  it('counts hidden time only while the page is active', async () => {
    const { t } = setup(true);
    advance(1000);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    advance(5000);
    window.dispatchEvent(new Event('pageshow'));
    advance(1000);
    show();
    advance(1000);
    hide();
    expect(reports(await t.sent()).map((e) => entityOf(e).hidden_time_msec)).toEqual([0, 1000]);
  });

  it('does not count blurred-but-visible time as hidden', async () => {
    const { t } = setup(true);
    advance(1000);
    blur();
    advance(5000);
    focus();
    advance(1000);
    hide();
    expect(reports(await t.sent()).map((e) => entityOf(e).hidden_time_msec)).toEqual([0]);
  });
});

describe('scroll depth', () => {
  it('samples once per animation frame and keeps the maximum', async () => {
    const { t } = setup(true);
    setScroll(0, 400);
    setScroll(0, 900);
    setScroll(30, 600);
    expect(frames.length).toBe(1);
    runFrames();
    setScroll(10, 200);
    runFrames();
    advance(1000);
    hide();
    const d = entityOf(reports(await t.sent())[0]);
    // 0 -> (30, 600) in the first frame, then (10, 200): the 900 in between fell inside one frame.
    expect(d.max_scroll_y_px).toBe(600);
    expect(d.max_scroll_x_px).toBe(30);
    expect(d.total_scroll_distance_px).toBe(630 + 420);
  });
});

describe('right-to-left pages', () => {
  it('measures horizontal depth from negative x offsets', async () => {
    const { t } = setup(true);
    setScroll(-300, 0);
    runFrames();
    setScroll(-100, 0);
    runFrames();
    advance(1000);
    hide();
    expect(entityOf(reports(await t.sent())[0])).toMatchObject({ max_scroll_x_px: 300, total_scroll_distance_px: 500 });
  });
});

describe('interaction counters', () => {
  const clickKeyTouch = () => {
    trusted(document, 'click');
    trusted(document, 'keydown');
    trusted(document, 'touchstart');
  };

  it('counts clicks, key presses and touches only while the clock runs', async () => {
    const { t } = setup(true);
    clickKeyTouch();
    clickKeyTouch();
    blur();
    clickKeyTouch();
    focus();
    advance(1000);
    hide();
    const d = entityOf(reports(await t.sent())[0]);
    expect([d.total_clicks, d.total_key_presses, d.total_touches]).toEqual([2, 2, 2]);
  });

  it('does not count key presses in password, card or one-time-code fields', async () => {
    const { t } = setup(true);
    const field = (attrs: Record<string, string>) => {
      const el = document.createElement('input');
      Object.keys(attrs).forEach((k) => el.setAttribute(k, attrs[k]));
      return el;
    };
    [
      field({ type: 'password' }),
      field({ autocomplete: 'cc-number' }),
      field({ autocomplete: 'section-pay cc-csc' }),
      field({ autocomplete: 'one-time-code' }),
      field({ autocomplete: 'current-password' }),
      field({ autocomplete: 'new-password' }),
      field({ autocomplete: 'CC-NUMBER' }),
    ].forEach((target) => trusted(document, 'keydown', { target }));
    // Inside a shadow root the document sees the host as the target; the path names the input.
    const host = document.createElement('div');
    trusted(document, 'keydown', { target: host, composedPath: () => [field({ type: 'password' }), host] });
    trusted(document, 'keydown', { target: field({ type: 'text', autocomplete: 'email' }) });
    trusted(document, 'keydown', { target: document.body });
    advance(1000);
    hide();
    expect(entityOf(reports(await t.sent())[0]).total_key_presses).toBe(2);
  });

  it('skips clicks and touches on sensitive fields too', async () => {
    const { t } = setup(true);
    const pw = document.createElement('input');
    pw.setAttribute('type', 'password');
    trusted(document, 'click', { target: pw });
    trusted(document, 'touchstart', { target: pw });
    trusted(document, 'click', { target: document.body });
    advance(1000);
    hide();
    expect(entityOf(reports(await t.sent())[0])).toMatchObject({ total_clicks: 1, total_touches: 0 });
  });

  it('ignores script-dispatched input', async () => {
    const { t } = setup(true);
    document.dispatchEvent(new MouseEvent('click'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    document.dispatchEvent(new Event('touchstart'));
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }));
    runFrames();
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 40 }));
    runFrames();
    trusted(document, 'click');
    advance(1000);
    hide();
    const d = entityOf(reports(await t.sent())[0]);
    expect([d.total_clicks, d.total_key_presses, d.total_touches, d.total_mouse_distance_px]).toEqual([1, 0, 0, 0]);
  });

  it('measures Euclidean mouse distance per animation frame', async () => {
    const { t } = setup(true);
    trusted(document, 'mousemove', { clientX: 0, clientY: 0 });
    runFrames();
    trusted(document, 'mousemove', { clientX: 3, clientY: 4 });
    runFrames();
    // Out and back within one frame: only the frame's end point counts.
    trusted(document, 'mousemove', { clientX: 300, clientY: 400 });
    trusted(document, 'mousemove', { clientX: 3, clientY: 4 });
    expect(frames.length).toBe(1);
    runFrames();
    advance(1000);
    hide();
    expect(entityOf(reports(await t.sent())[0]).total_mouse_distance_px).toBe(5);
  });

  it('drops movement and scrolling while the clock is stopped', async () => {
    const { t } = setup(true);
    trusted(document, 'mousemove', { clientX: 0, clientY: 0 });
    runFrames();
    advance(1000);
    blur();
    trusted(document, 'mousemove', { clientX: 30, clientY: 40 });
    setScroll(0, 500);
    runFrames();
    focus();
    trusted(document, 'mousemove', { clientX: 33, clientY: 44 });
    runFrames();
    advance(1000);
    hide();
    const d = entityOf(reports(await t.sent())[0]);
    expect(d.total_mouse_distance_px).toBe(5);
    expect(d.total_scroll_distance_px).toBe(0);
    // Depth is a position, not activity, so it still counts.
    expect(d.max_scroll_y_px).toBe(500);
  });
});

describe('piggyback', () => {
  it('is off by default: other events carry no entity', async () => {
    const { t } = setup(true);
    advance(2000);
    struct(t);
    expect((await t.sent()).filter(entityOf)).toEqual([]);
  });

  it('when on, attaches the running total to other events but not to page views', async () => {
    const { t } = setup({ piggyback: true }, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(2500);
    struct(t);
    const [pv, se] = await t.sent();
    expect(entityOf(pv)).toBeUndefined();
    expect(entityOf(se)).toMatchObject({ total_engagement_time_msec: 2500, reason: 'piggyback' });
  });

  it('carries nothing before a page view has been sent under the id', async () => {
    const { t } = setup({ piggyback: true }, 1, { pageView: false });
    advance(2000);
    struct(t);
    expect((await t.sent()).filter(entityOf)).toEqual([]);
  });

  it('suppresses a flush the piggyback already covered', async () => {
    const { t } = setup({ piggyback: true });
    advance(2500);
    struct(t);
    advance(300);
    hide();
    expect(reports(await t.sent())).toEqual([]);
  });
});

describe('page boundaries', () => {
  it('reports an SPA page view with the outgoing page view id, then starts the next page at zero', async () => {
    const { t } = setup(true, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(2000);
    trusted(document, 'click');
    t.tracker.trackPageView();
    advance(1500);
    hide();
    const events = await t.sent();
    expect(events.map((e) => e.e)).toEqual(['pv', 'ue', 'pv', 'ue']);
    const [pv1, change, pv2, final] = events;
    expect(pageViewIdOf(change)).toBe(pageViewIdOf(pv1));
    expect(entityOf(change)).toMatchObject({
      reason: 'page_change',
      page_view_id: pageViewIdOf(pv1),
      total_engagement_time_msec: 2000,
      total_clicks: 1,
    });
    expect(pageViewIdOf(pv2)).not.toBe(pageViewIdOf(pv1));
    expect(entityOf(final)).toMatchObject({
      reason: 'hide',
      page_view_id: pageViewIdOf(pv2),
      total_engagement_time_msec: 1500,
      total_clicks: 0,
    });
  });

  it('keeps the time from enable to the first page view in that page', async () => {
    const { t } = setup(true, 1, { pageView: false });
    advance(700);
    t.tracker.trackPageView();
    advance(1500);
    hide();
    expect(reports(await t.sent()).map((e) => entityOf(e).total_engagement_time_msec)).toEqual([2200]);
  });

  it('sends no hide or pagehide report while no page view has been sent under the id', async () => {
    const { t } = setup(true, 1, { pageView: false });
    advance(3000);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    expect(await t.sent()).toEqual([]);
  });

  it('sends nothing before the first page view, even with a clock that always moves', async () => {
    tick = 3;
    const { t } = setup(true, 1, { pageView: false });
    advance(500);
    t.tracker.trackPageView();
    expect((await t.sent()).map((e) => e.e)).toEqual(['pv']);
  });

  it('reports the first page when enabled after its page view, as a GTM enable tag after the page view tag does', async () => {
    const { plugin, t } = setup(undefined, 1, { pageView: false });
    t.tracker.trackPageView();
    const [pv] = await t.sent();
    plugin.enablePageEngagement({}, [t.id]);
    advance(1500);
    t.tracker.trackPageView();
    const events = await t.sent();
    expect(events.map((e) => e.e)).toEqual(['pv', 'ue', 'pv']);
    expect(entityOf(events[1])).toMatchObject({
      reason: 'page_change',
      page_view_id: pageViewIdOf(pv),
      total_engagement_time_msec: 1500,
    });
  });

  it('sends one report per SPA page view with a clock that moves inside trackPageView', async () => {
    tick = 3;
    const { t } = setup(true, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(2000);
    t.tracker.trackPageView();
    advance(1500);
    t.tracker.trackPageView();
    const events = await t.sent();
    expect(events.map((e) => e.e)).toEqual(['pv', 'ue', 'pv', 'ue', 'pv']);
    const [pv1, first, pv2, second] = events;
    expect(entityOf(first).page_view_id).toBe(pageViewIdOf(pv1));
    expect(entityOf(second).page_view_id).toBe(pageViewIdOf(pv2));
    // The second page starts after its page view; the milliseconds inside trackPageView are not in it.
    expect(entityOf(second).total_engagement_time_msec).toBeLessThan(1500 + 30);
    expect(entityOf(second).total_engagement_time_msec).toBeGreaterThanOrEqual(1500);
  });

  it('sends one report per page view between two trackers page views, with a moving clock', async () => {
    tick = 3;
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    advance(100);
    b.tracker.trackPageView();
    advance(2000);
    a.tracker.trackPageView();
    advance(100);
    b.tracker.trackPageView();
    expect(reports(await a.sent()).map((e) => entityOf(e).reason)).toEqual(['page_change']);
  });
  it('reports a page change under the 1 s floor exactly', async () => {
    const { t } = setup(true, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(300);
    t.tracker.trackPageView();
    const change = reports(await t.sent());
    expect(change.map((e) => [entityOf(e).reason, entityOf(e).total_engagement_time_msec])).toEqual([
      ['page_change', 300],
    ]);
  });

  it('keeps reporting under the page view id when a consent call rotates the id after the page view', async () => {
    const { t } = setup(true, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(2000);
    trusted(document, 'click');
    t.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'cookieAndLocalStorage' });
    const rotatedId = t.tracker.getPageViewId();
    const [pv1] = await t.sent();
    expect(rotatedId).not.toBe(pageViewIdOf(pv1));
    expect(reports(await t.sent())).toEqual([]);
    advance(1000);
    hide();
    show();
    advance(500);
    t.tracker.trackPageView(); // core reuses the rotated id for this page view
    advance(1200);
    hide();
    const events = await t.sent();
    const pvIds = events.filter((e) => e.e === 'pv').map(pageViewIdOf);
    expect(pvIds).toEqual([pageViewIdOf(pv1), rotatedId]);
    expect(reports(events).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: pvIds[0], total_engagement_time_msec: 3000, total_clicks: 1 },
      { reason: 'page_change', page_view_id: pvIds[0], total_engagement_time_msec: 3500 },
      { reason: 'hide', page_view_id: pvIds[1], total_engagement_time_msec: 1200, total_clicks: 0 },
    ]);
    reports(events).forEach((e) => expect(pvIds).toContain(entityOf(e).page_view_id));
  });

  it('reports on the page view when enabled after a consent rotation, as GTM grants before it enables', async () => {
    const { plugin, t } = setup(undefined, 1, { pageView: false });
    t.tracker.trackPageView();
    const [pv] = await t.sent();
    t.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'cookieAndLocalStorage' });
    plugin.enablePageEngagement({}, [t.id]);
    advance(1500);
    hide();
    show();
    advance(500);
    t.tracker.trackPageView(); // under the rotated id
    advance(1200);
    hide();
    const events = await t.sent();
    const pvIds = events.filter((e) => e.e === 'pv').map(pageViewIdOf);
    expect(reports(events).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: pageViewIdOf(pv), total_engagement_time_msec: 1500 },
      { reason: 'page_change', page_view_id: pageViewIdOf(pv), total_engagement_time_msec: 2000 },
      { reason: 'hide', page_view_id: pvIds[1], total_engagement_time_msec: 1200 },
    ]);
  });

  it('moves the totals to the new id when no page view used the old one', async () => {
    const { t } = setup(true, 1, { pageView: false });
    advance(1000);
    t.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'cookieAndLocalStorage' });
    t.tracker.trackPageView();
    advance(1500);
    hide();
    const events = await t.sent();
    expect(reports(events).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: pageViewIdOf(events[0]), total_engagement_time_msec: 2500 },
    ]);
  });
  it('reports the page under its page view id on the next page view after a re-applied grant', async () => {
    const { t } = setup(true, 1, { pageView: false });
    t.tracker.trackPageView();
    const [pv] = await t.sent();
    advance(2000);
    t.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'cookieAndLocalStorage' });
    advance(500);
    t.tracker.trackPageView();
    const events = await t.sent();
    expect(events.map((e) => e.e)).toEqual(['pv', 'ue', 'pv']);
    expect(entityOf(events[1])).toMatchObject({
      reason: 'page_change',
      page_view_id: pageViewIdOf(pv),
      total_engagement_time_msec: 2500,
    });
  });
  it('keeps the reporter on its page view when another tracker rotates the id for consent', async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    const pvId = pageViewIdOf((await a.sent())[0]);
    advance(2000);
    b.tracker.enableAnonymousTracking({ options: false });
    advance(1000);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: pvId, total_engagement_time_msec: 3000 },
    ]);
  });
  it("closes out the old page view at once when another tracker's page view moves the shared id", async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView(); // same id: b has not sent one before
    const [pv] = await a.sent();
    advance(2000);
    b.tracker.trackPageView(); // rotates the shared id under a
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: pageViewIdOf(pv), total_engagement_time_msec: 2000 },
    ]);
    const newId = a.tracker.getPageViewId();
    advance(1000);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: pageViewIdOf(pv), total_engagement_time_msec: 2000 },
      { reason: 'hide', page_view_id: newId, total_engagement_time_msec: 1000 },
    ]);
  });
  it('carries only the new page after another tracker moved the id, with piggyback on', async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({ piggyback: true }, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    advance(2000);
    b.tracker.trackPageView();
    const newId = a.tracker.getPageViewId();
    advance(500);
    struct(a);
    advance(700);
    struct(a);
    const carried = (await a.sent()).filter((e) => e.e === 'se').map(entityOf);
    expect(carried).toMatchObject([
      { reason: 'piggyback', page_view_id: newId, total_engagement_time_msec: 500 },
      { reason: 'piggyback', page_view_id: newId, total_engagement_time_msec: 1200 },
    ]);
  });
  it("sends one report when another tracker's page view comes first on the reporter's page", async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    b.tracker.trackPageView();
    advance(2000);
    a.tracker.trackPageView(); // reuses b's id: the same page
    advance(1000);
    hide();
    const events = await a.sent();
    expect(pageViewIdOf(events[0])).toBe(pageViewIdOf((await b.sent())[0]));
    expect(reports(events).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: pageViewIdOf(events[0]), total_engagement_time_msec: 3000 },
    ]);
  });

  it("sends no second page_change when the reporter's page view follows another tracker's navigation", async () => {
    tick = 3;
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    advance(2000);
    b.tracker.trackPageView(); // rotates the id: the reporter closes out once
    a.tracker.trackPageView(); // same new page
    expect(reports(await a.sent()).map((e) => entityOf(e).reason)).toEqual(['page_change']);
  });

  it('reports every page when another tracker drives the navigation', async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    const ids = [a.tracker.getPageViewId()];
    advance(1000);
    b.tracker.trackPageView();
    ids.push(a.tracker.getPageViewId());
    advance(1500);
    b.tracker.trackPageView();
    ids.push(a.tracker.getPageViewId());
    advance(1200);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: ids[0], total_engagement_time_msec: 1000 },
      { reason: 'page_change', page_view_id: ids[1], total_engagement_time_msec: 1500 },
      { reason: 'hide', page_view_id: ids[2], total_engagement_time_msec: 1200 },
    ]);
  });

  it("reports the page when another tracker's page view follows a consent rotation", async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    const first = a.tracker.getPageViewId();
    advance(1000);
    a.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'cookieAndLocalStorage' });
    const rotated = a.tracker.getPageViewId();
    advance(1000);
    b.tracker.trackPageView(); // core reuses the rotated id: a new page all the same
    expect(pageViewIdOf((await b.sent()).slice(-1)[0])).toBe(rotated);
    advance(1200);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: first, total_engagement_time_msec: 2000 },
      { reason: 'hide', page_view_id: rotated, total_engagement_time_msec: 1200 },
    ]);
  });

  it("treats another tracker's first page view as the same page, even after a consent rotation", async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    const first = a.tracker.getPageViewId();
    advance(1000);
    a.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'cookieAndLocalStorage' });
    b.tracker.trackPageView(); // its first, under the rotated id
    advance(1000);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: first, total_engagement_time_msec: 2000 },
    ]);
  });

  it("follows another tracker's navigation while the reporter has no consent, without a report", async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    a.tracker.disableAnonymousTracking({ stateStorageStrategy: 'none' });
    advance(1000);
    b.tracker.trackPageView(); // a navigation the reporter must follow unconsented
    const newId = a.tracker.getPageViewId();
    a.tracker.disableAnonymousTracking({ stateStorageStrategy: 'cookieAndLocalStorage' });
    advance(1500);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'hide', page_view_id: newId, total_engagement_time_msec: 1500 },
    ]);
  });

  it('enables one reporter per document: a second tracker stays off', async () => {
    const { plugin, trackers } = setup(undefined, 2);
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    plugin.enablePageEngagement({}, [b.id]);
    advance(2000);
    hide();
    expect(reports(await a.sent()).length).toBe(1);
    expect(reports(await b.sent())).toEqual([]);
  });

  it('enables only the first of several trackers named in one call', async () => {
    const { plugin, trackers } = setup(undefined, 2);
    const [a, b] = trackers;
    plugin.enablePageEngagement({});
    advance(2000);
    hide();
    expect(reports(await a.sent()).length + reports(await b.sent()).length).toBe(1);
  });
});

describe('consent', () => {
  it("measures nothing when the tracker starts under stateStorageStrategy 'none'", async () => {
    const { t } = setup(true, 1, { strategy: 'none', pageView: false });
    t.tracker.trackPageView();
    advance(3000);
    trusted(document, 'click');
    hide();
    window.dispatchEvent(new Event('pagehide'));
    expect(reports(await t.sent())).toEqual([]);
  });

  it('starts fresh when consent is granted mid-page', async () => {
    const { t } = setup(true, 1, { strategy: 'none' });
    advance(3000);
    t.tracker.disableAnonymousTracking({ stateStorageStrategy: 'cookieAndLocalStorage' });
    advance(1500);
    hide();
    expect(reports(await t.sent()).map((e) => entityOf(e).total_engagement_time_msec)).toEqual([1500]);
  });

  it('discards the totals and sends nothing when consent is declined mid-page', async () => {
    const { t } = setup({ piggyback: true });
    advance(3000);
    trusted(document, 'click');
    blur(); // accrues the 3 s, so a decline that did not discard would have something to send
    focus();
    t.tracker.enableAnonymousTracking({ stateStorageStrategy: 'none' });
    advance(2000);
    struct(t);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    const events = await t.sent();
    expect(reports(events)).toEqual([]);
    expect(events.filter(entityOf)).toEqual([]);
  });

  it('sends nothing when the reporter declines before the other tracker', async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    advance(3000);
    blur();
    focus();
    a.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'none' });
    b.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'none' });
    advance(1000);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    expect(reports(await a.sent())).toEqual([]);
    expect(reports(await b.sent())).toEqual([]);
  });
  it('sends nothing when the tracker that declines first does not have the plugin enabled', async () => {
    const { plugin, trackers } = setup(undefined, 2, { pageView: false });
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    advance(3000);
    blur();
    focus();
    b.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'none' });
    a.tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'none' });
    advance(1000);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    expect(reports(await a.sent())).toEqual([]);
  });

  it('stops measuring when a decline throws inside core', async () => {
    const { plugin, core, trackerCore } = setup(undefined, 0);
    const store = trackerCore.newInMemoryEventStore({});
    const id = `sp${++trackerCounter}`;
    const tracker = core.addTracker(id, id, 'js-test', '', new core.SharedState(), {
      encodeBase64: false,
      eventStore: store,
      customFetch: async () => new Response(null, { status: 500 }),
      contexts: { webPage: true },
    })!;
    // Core switches to 'none' and then throws, as blocked site storage can make it. The plugin is
    // added after, so this throwing call is the one it wraps.
    const coreCall = tracker.enableAnonymousTracking;
    tracker.enableAnonymousTracking = (configuration?: any) => {
      coreCall(configuration);
      throw new Error('storage blocked');
    };
    tracker.addPlugin({ plugin: plugin.PageEngagementPlugin(true, { stateStorageStrategy: 'cookieAndLocalStorage' }) });
    tracker.trackPageView();
    advance(2000);
    expect(() => tracker.enableAnonymousTracking({ options: false, stateStorageStrategy: 'none' })).toThrow(
      'storage blocked'
    );
    advance(2000);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    const events = ((await store.getAllPayloads()) as any[]).map((x) => x.e);
    expect(events).toEqual(['pv']);
  });

  it('starts fresh when consent is granted again after a decline', async () => {
    const { t } = setup(true);
    advance(3000);
    trusted(document, 'click');
    t.tracker.enableAnonymousTracking({ stateStorageStrategy: 'none' });
    advance(2000);
    t.tracker.enableAnonymousTracking({ stateStorageStrategy: 'cookieAndLocalStorage' });
    advance(1200);
    hide();
    const sent = reports(await t.sent()).map(entityOf);
    expect(sent).toMatchObject([{ total_engagement_time_msec: 1200, total_clicks: 0 }]);
  });

  it('leaves consent as it is when a call names no strategy', async () => {
    const { t } = setup(true, 1, { strategy: 'none' });
    t.tracker.enableAnonymousTracking();
    advance(2000);
    hide();
    expect(reports(await t.sent())).toEqual([]);
  });
});

describe('enabling', () => {
  it('enables the tracker named, parses a JSON string, and leaves the others off', async () => {
    const { plugin, trackers } = setup(undefined, 3);
    const [a, b, c] = trackers;
    plugin.enablePageEngagement('{"piggyback":true}', [b.id]);
    advance(2000);
    struct(b);
    struct(a);
    hide();
    expect(entityOf((await b.sent()).filter((e) => e.e === 'se')[0])).toMatchObject({
      reason: 'piggyback',
      total_engagement_time_msec: 2000,
    });
    expect(reports(await a.sent())).toEqual([]);
    expect((await a.sent()).filter(entityOf)).toEqual([]);
    expect(reports(await c.sent())).toEqual([]);
  });
  it('ignores a second enable on the same tracker', async () => {
    const { plugin, t } = setup(true, 1, { pageView: false });
    plugin.enablePageEngagement({ piggyback: true }, [t.id]);
    t.tracker.trackPageView();
    advance(2000);
    t.tracker.trackPageView();
    struct(t);
    const events = await t.sent();
    expect(reports(events).length).toBe(1);
    expect(events.filter(entityOf).length).toBe(1);
  });
});

describe('entity', () => {
  it('matches the schema for every reason', async () => {
    const { t } = setup({ piggyback: true }, 1, { pageView: false });
    t.tracker.trackPageView();
    setScroll(5, 50);
    runFrames();
    advance(1100);
    struct(t);
    advance(1100);
    t.tracker.trackPageView();
    advance(1100);
    hide();
    show();
    advance(1100);
    window.dispatchEvent(new Event('pagehide'));
    const entities = (await t.sent()).map(entityOf).filter(Boolean);
    expect(entities.map((d) => d.reason).sort()).toEqual(['hide', 'page_change', 'pagehide', 'piggyback']);
    entities.forEach((d) => expect(schemaErrors(d)).toEqual([]));
    expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    expect(Object.keys(entities[0]).sort()).toEqual(Object.keys(schema.properties).sort());
  });
});

describe('never throws into the page', () => {
  it('swallows a failing track call inside an event handler', async () => {
    const { t } = setup(true);
    const onError = jest.fn();
    window.addEventListener('error', onError);
    jest.spyOn(t.tracker.core, 'track').mockImplementation(() => {
      throw new Error('boom');
    });
    advance(2000);
    expect(() => hide()).not.toThrow();
    window.removeEventListener('error', onError);
    expect(onError).not.toHaveBeenCalled();
  });

  it('still tracks the page view when the flush before it fails', async () => {
    const { t } = setup(true, 1, { pageView: false });
    t.tracker.trackPageView();
    advance(2000);
    // The page_change report goes first and fails; the page view after it must still go out.
    jest.spyOn(t.tracker.core, 'track').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => t.tracker.trackPageView()).not.toThrow();
    expect((await t.sent()).filter((e) => e.e === 'pv').length).toBe(2);
  });
});
