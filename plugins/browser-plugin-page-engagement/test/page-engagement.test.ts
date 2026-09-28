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
let visibility = 'visible';
let hasFocus = true;
let frames: Array<() => void> = [];

Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
Object.defineProperty(window, 'pageXOffset', { configurable: true, writable: true, value: 0 });
Object.defineProperty(window, 'pageYOffset', { configurable: true, writable: true, value: 0 });
jest.spyOn(performance, 'now').mockImplementation(() => clock);
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
  { strategy = 'cookieAndLocalStorage', keepalive = true }: { strategy?: string; keepalive?: boolean } = {}
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
      plugins: [plugin.PageEngagementPlugin(pluginConfig, { stateStorageStrategy: strategy, keepalive })],
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
  return { plugin, trackers, t: trackers[0] };
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
    const { t } = setup();
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
    const { t } = setup({ piggyback: true });
    t.tracker.trackPageView();
    advance(2500);
    struct(t);
    const [pv, se] = await t.sent();
    expect(entityOf(pv)).toBeUndefined();
    expect(entityOf(se)).toMatchObject({ total_engagement_time_msec: 2500, reason: 'piggyback' });
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
    const { t } = setup(true);
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

  it('reports a page change under the 1 s floor exactly', async () => {
    const { t } = setup(true);
    t.tracker.trackPageView();
    advance(300);
    t.tracker.trackPageView();
    const change = reports(await t.sent());
    expect(change.map((e) => [entityOf(e).reason, entityOf(e).total_engagement_time_msec])).toEqual([
      ['page_change', 300],
    ]);
  });

  it('closes out the old page view when enableAnonymousTracking rotates the id mid-page', async () => {
    const { t } = setup(true);
    t.tracker.trackPageView();
    const [pv] = await t.sent();
    advance(2000);
    t.tracker.enableAnonymousTracking({ options: false });
    const rotatedId = t.tracker.getPageViewId();
    expect(rotatedId).not.toBe(pageViewIdOf(pv));
    advance(1500);
    hide();
    expect(reports(await t.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: pageViewIdOf(pv), total_engagement_time_msec: 2000 },
      { reason: 'hide', page_view_id: rotatedId, total_engagement_time_msec: 1500 },
    ]);
  });

  it("closes out the old page view when another tracker's page view moves the shared id", async () => {
    const { trackers } = setup(true, 2);
    const [a, b] = trackers;
    a.tracker.trackPageView();
    b.tracker.trackPageView(); // same id: b has not sent one before
    const [pv] = await a.sent();
    advance(2000);
    b.tracker.trackPageView(); // rotates the shared id under a
    const newId = a.tracker.getPageViewId();
    advance(1000);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: pageViewIdOf(pv), total_engagement_time_msec: 2000 },
      { reason: 'hide', page_view_id: newId, total_engagement_time_msec: 1000 },
    ]);
  });

  it('closes out on the next carried event when a tracker without the plugin enabled moves the id', async () => {
    const { plugin, trackers } = setup(undefined, 2);
    const [a, b] = trackers;
    plugin.enablePageEngagement({ piggyback: true }, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    const oldId = pageViewIdOf((await a.sent())[0]);
    advance(2000);
    b.tracker.trackPageView(); // b is not enabled, so no wrapper sees this rotation
    advance(500);
    struct(a);
    advance(700);
    struct(a);
    const carried = (await a.sent()).filter((e) => e.e === 'se').map(entityOf);
    expect(carried).toMatchObject([
      { reason: 'piggyback', page_view_id: oldId, total_engagement_time_msec: 2500 },
      { reason: 'piggyback', page_view_id: a.tracker.getPageViewId(), total_engagement_time_msec: 700 },
    ]);
    expect(carried[1].page_view_id).not.toBe(oldId);
  });

  it('closes out on the next transition when a tracker without the plugin enabled moves the id', async () => {
    const { plugin, trackers } = setup(undefined, 2);
    const [a, b] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    const oldId = pageViewIdOf((await a.sent())[0]);
    advance(2000);
    b.tracker.trackPageView();
    advance(500);
    hide();
    expect(reports(await a.sent()).map(entityOf)).toMatchObject([
      { reason: 'page_change', page_view_id: oldId, total_engagement_time_msec: 2500 },
    ]);
  });

  it('gives each of two enabled trackers its own final report on one page view', async () => {
    const { trackers } = setup(true, 2);
    const [a, b] = trackers;
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    const firstId = pageViewIdOf((await a.sent())[0]);
    advance(2000);
    a.tracker.trackPageView();
    b.tracker.trackPageView();
    for (const x of [a, b]) {
      const change = reports(await x.sent()).map(entityOf);
      expect(change).toMatchObject([
        { reason: 'page_change', page_view_id: firstId, total_engagement_time_msec: 2000 },
      ]);
    }
  });
});

describe('consent', () => {
  it("measures nothing when the tracker starts under stateStorageStrategy 'none'", async () => {
    const { t } = setup(true, 1, { strategy: 'none' });
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
    t.tracker.enableAnonymousTracking({ stateStorageStrategy: 'none' });
    advance(2000);
    struct(t);
    hide();
    window.dispatchEvent(new Event('pagehide'));
    const events = await t.sent();
    expect(reports(events)).toEqual([]);
    expect(events.filter(entityOf)).toEqual([]);
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

describe('keepalive', () => {
  it('warns once per tracker when keepalive is off', () => {
    const warn = console.warn as jest.Mock;
    warn.mockClear();
    const { plugin, t } = setup(true, 1, { keepalive: false });
    plugin.enablePageEngagement({}, [t.id]);
    expect(warn.mock.calls.filter((c) => /keepalive/.test(String(c[0]))).length).toBe(1);
    warn.mockClear();
    setup(true, 1, { keepalive: true });
    expect(warn.mock.calls.filter((c) => /keepalive/.test(String(c[0]))).length).toBe(0);
  });
});

describe('per tracker', () => {
  it('enables only the trackers named and keeps their totals apart', async () => {
    const { plugin, trackers } = setup(undefined, 3);
    const [a, b, c] = trackers;
    plugin.enablePageEngagement({}, [a.id]);
    advance(1000);
    plugin.enablePageEngagement('{"piggyback":true}', [b.id]);
    advance(2000);
    hide();
    expect(reports(await a.sent()).map((e) => entityOf(e).total_engagement_time_msec)).toEqual([3000]);
    expect(reports(await b.sent()).map((e) => entityOf(e).total_engagement_time_msec)).toEqual([2000]);
    expect(await c.sent()).toEqual([]);

    show();
    advance(1000);
    struct(b);
    struct(a);
    const lastOf = async (x: typeof a) => (await x.sent()).slice(-1)[0];
    expect(entityOf(await lastOf(b))).toMatchObject({ reason: 'piggyback', total_engagement_time_msec: 3000 });
    expect(entityOf(await lastOf(a))).toBeUndefined();
  });

  it('ignores a second enable on the same tracker', async () => {
    const { plugin, t } = setup(true);
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
    const { t } = setup({ piggyback: true });
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
    const { t } = setup(true);
    t.tracker.trackPageView();
    advance(2000);
    jest.spyOn(t.tracker, 'getPageViewId').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    expect(() => t.tracker.trackPageView()).not.toThrow();
    expect((await t.sent()).filter((e) => e.e === 'pv').length).toBe(2);
  });
});
