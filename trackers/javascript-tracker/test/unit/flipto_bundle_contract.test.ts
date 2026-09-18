/**
 * Flip.to bundle contract tests.
 *
 * These run against the BUILT bundle (dist/sp.lite.js), not the TypeScript sources,
 * because what reaches cdn.flip.to is the bundle and nothing else checks it today.
 *
 * Every assertion here is a behaviour that Flip.to Platform code depends on. Three of
 * them are fork patches that upstream does not have, so an upstream merge that silently
 * drops one would otherwise only be noticed in production, on every customer site at once.
 *
 * Run: rushx build, then rushx test.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const BUNDLE_PATH = resolve(__dirname, '../../dist/sp.lite.js');
const BUILD_SCRIPT_PATH = resolve(__dirname, '../../../../_FLIPTO_BUILD.ps1');

/** The namespace the release build pins. Asserted against the build script, not the bundle,
 *  because CI builds without --whitelabel and would otherwise see GlobalSnowplowNamespace. */
const RELEASE_WHITELABEL_NAMESPACE = 'ftSpacetimeGlobalNamespace';

/** The out queue key. Renamed away from snowplowOutQueue_ so the localStorage key does not
 *  name the vendor on customer sites. */
const OUT_QUEUE_PREFIX = 'ftOutQueue_';

if (!existsSync(BUNDLE_PATH)) {
  throw new Error(`Bundle not found at ${BUNDLE_PATH}. Run "rushx build" in trackers/javascript-tracker first.`);
}

const bundleSource = readFileSync(BUNDLE_PATH, 'utf-8');

/** The bundle ends with window.<namespace>.shift(). Read the namespace out rather than
 *  hardcoding it, so this file works for both a whitelabel and a vanilla build. */
function readGlobalNamespace(source: string): string {
  const match = source.match(/window\.([A-Za-z0-9_$]+)\.shift\(\)/);
  if (!match) {
    throw new Error('Could not find the global namespace array in the bundle.');
  }
  return match[1];
}

const GLOBAL_NAMESPACE = readGlobalNamespace(bundleSource);

/**
 * jsdom ships no crypto.getRandomValues, no Request and no Response, and the bundle needs
 * all three (uuid for the event id, the emitter for transport). Supply the minimum.
 */
function installBrowserPolyfills() {
  if (!(window as any).crypto?.getRandomValues) {
    const nodeCrypto = require('crypto');
    Object.defineProperty(window, 'crypto', {
      configurable: true,
      value: {
        getRandomValues: (arr: Uint8Array) => {
          const bytes = nodeCrypto.randomBytes(arr.length);
          arr.set(bytes);
          return arr;
        },
      },
    });
  }
  if ((globalThis as any) !== (window as any) && !(globalThis as any).crypto?.getRandomValues) {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: (window as any).crypto });
  }

  if (typeof (globalThis as any).Request === 'undefined') {
    class FakeRequest {
      url: string;
      private _body: string;
      constructor(url: string, init: any = {}) {
        this.url = url;
        this._body = init.body ?? '';
      }
      async text() {
        return this._body;
      }
    }
    (globalThis as any).Request = FakeRequest;
    (window as any).Request = FakeRequest;
  }
  if (typeof (globalThis as any).Response === 'undefined') {
    class FakeResponse {
      ok = true;
      status = 200;
      constructor(public body: string = '{}', init: any = {}) {
        this.status = init.status ?? 200;
        this.ok = this.status < 400;
      }
      async text() {
        return this.body;
      }
      async json() {
        return JSON.parse(this.body);
      }
    }
    (globalThis as any).Response = FakeResponse;
    (window as any).Response = FakeResponse;
  }
}

interface Captured {
  url: string;
  body: any;
}

/**
 * Loads the built IIFE into the current jsdom window exactly the way the on-page tag does,
 * and returns a callable tracker queue plus the collector requests it makes.
 */
function loadBundle(trackerName = 'ftsa') {
  installBrowserPolyfills();
  const requests: Captured[] = [];

  const fetchStub = async (input: any) => {
    const request = input as Request;
    let body: any = null;
    try {
      body = JSON.parse(await request.text());
    } catch {
      body = null;
    }
    requests.push({ url: request.url, body });
    return new (globalThis as any).Response('{}', { status: 200 });
  };
  (window as any).fetch = fetchStub;
  (globalThis as any).fetch = fetchStub;

  (window as any)[GLOBAL_NAMESPACE] = [trackerName];
  const queueFn: any = function (...args: unknown[]) {
    queueFn.q.push(args);
  };
  queueFn.q = [];
  (window as any)[trackerName] = queueFn;

  // eslint-disable-next-line no-eval
  window.eval(bundleSource);

  return {
    call: (...args: unknown[]) => queueFn(...args),
    requests,
    /** The live tracker object, reachable because of the fliptoDataLayer patch. */
    tracker: () => (window as any).fliptoDataLayer?.snowplow,
  };
}

function newTrackerArgs(overrides: Record<string, unknown> = {}) {
  return {
    appId: 'contract-test',
    platform: 'web',
    eventMethod: 'post',
    bufferSize: 1,
    contexts: { webPage: true, session: false, performanceTiming: false },
    ...overrides,
  };
}

function clearBrowserState() {
  window.localStorage.clear();
  document.cookie.split(';').forEach((c) => {
    const name = c.split('=')[0].trim();
    if (name) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });
}

describe('Flip.to bundle contract', () => {
  beforeEach(() => {
    clearBrowserState();
    delete (window as any).fliptoDataLayer;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('1. Out queue key is ftOutQueue_, not snowplowOutQueue_', () => {
    it('the bundle never mentions the upstream key', () => {
      expect(bundleSource).toContain(OUT_QUEUE_PREFIX);
      expect(bundleSource).not.toContain('snowplowOutQueue_');
    });

    it('a buffered event lands under an ftOutQueue_ key', async () => {
      const sp = loadBundle('ftsa_q');
      sp.call('newTracker', 'q1', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: true }));
      sp.call('trackPageView');

      await flushMicrotasks();

      const keys = Object.keys(window.localStorage);
      expect(keys.some((k) => k.startsWith(OUT_QUEUE_PREFIX))).toBe(true);
      expect(keys.some((k) => k.startsWith('snowplowOutQueue_'))).toBe(false);
    });
  });

  describe('2. useLocalStorage: false still governs the out queue', () => {
    /**
     * Platform's configureTracker passes useLocalStorage: false, and its comment records that
     * the option is undocumented and that losing it would force Platform to write its own
     * in-memory event store. So the contract is not only "the option is accepted" but
     * "no localStorage buffer is created".
     */
    it('creates no localStorage buffer when false', async () => {
      const sp = loadBundle('ftsa_nols');
      sp.call('newTracker', 'q2', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      sp.call('trackPageView');

      await flushMicrotasks();

      const keys = Object.keys(window.localStorage);
      expect(keys.filter((k) => k.startsWith(OUT_QUEUE_PREFIX))).toEqual([]);
    });

    it('drops an existing buffer when switched off at runtime', async () => {
      const sp = loadBundle('ftsa_tgl');
      sp.call('newTracker', 'q3', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: true }));
      sp.call('trackPageView');
      await flushMicrotasks();
      expect(Object.keys(window.localStorage).some((k) => k.startsWith(OUT_QUEUE_PREFIX))).toBe(true);

      // the runtime toggle is driven by stateStorageStrategy, and our patch made it destructive:
      // switching the buffer off must also delete the key, or a lost-consent page replays its queue
      sp.call('enableAnonymousTracking', { stateStorageStrategy: 'none' });
      await flushMicrotasks();

      expect(Object.keys(window.localStorage).filter((k) => k.startsWith(OUT_QUEUE_PREFIX))).toEqual([]);
    });
  });

  describe('3. enableActivityTracking and enableActivityTrackingCallback share one flag and one validator', () => {
    /**
     * Platform PR #4337 runs the heartbeat locally and sends nothing, which only works while
     * enableActivityTracking is enableActivityTrackingCallback with a sending callback injected:
     * same enabled flag, same config validator, one shared interval installer.
     */
    it('the callback form fires a heartbeat and sends no collector request', async () => {
      jest.useFakeTimers();
      const sp = loadBundle('ftsa_cb');
      sp.call('newTracker', 'a1', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));

      const seen: any[] = [];
      sp.call('enableActivityTrackingCallback', {
        minimumVisitLength: 10,
        heartbeatDelay: 10,
        callback: (data: any) => seen.push(data),
      });
      sp.call('trackPageView');
      await flushMicrotasks();

      const sentAfterPageView = sp.requests.length;

      jest.advanceTimersByTime(5000);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
      jest.advanceTimersByTime(5000);

      expect(seen.length).toBeGreaterThan(0);
      // the heartbeat itself must not have produced a request
      expect(sp.requests.length).toBe(sentAfterPageView);
      jest.useRealTimers();
    });

    it('the page ping form uses the same installer and does send', async () => {
      jest.useFakeTimers();
      const sp = loadBundle('ftsa_pp');
      sp.call('newTracker', 'a2', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      sp.call('enableActivityTracking', { minimumVisitLength: 10, heartbeatDelay: 10 });
      sp.call('trackPageView');
      await flushMicrotasks();

      const sentAfterPageView = sp.requests.length;

      jest.advanceTimersByTime(5000);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
      jest.advanceTimersByTime(5000);
      await flushMicrotasks();

      expect(sp.requests.length).toBeGreaterThan(sentAfterPageView);
      jest.useRealTimers();
    });

    it('rejects a non-integer config through the same validator in both forms', async () => {
      jest.useFakeTimers();
      const sp = loadBundle('ftsa_bad');
      sp.call('newTracker', 'a3', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));

      const seen: any[] = [];
      sp.call('enableActivityTrackingCallback', {
        minimumVisitLength: 10.5,
        heartbeatDelay: 10,
        callback: (data: any) => seen.push(data),
      });
      sp.call('trackPageView');
      await flushMicrotasks();

      jest.advanceTimersByTime(60000);
      expect(seen).toEqual([]);
      jest.useRealTimers();
    });
  });

  describe('4. addGlobalContexts classifies a context generator by arity', () => {
    /**
     * isContextCallbackFunction is `typeof input === 'function' && input.length <= 1`.
     * A second parameter silently reclassifies the generator as a filter rule and the
     * context stops attaching, with no error anywhere.
     */
    it('attaches a generator of arity 1', async () => {
      const sp = loadBundle('ftsa_ctx1');
      sp.call('newTracker', 'c1', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      sp.call('addGlobalContexts', [
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        function (_payload: unknown) {
          return { schema: 'iglu:com.flipto/arity_one/jsonschema/1-0-0', data: { ok: true } };
        },
      ]);
      sp.call('trackPageView');
      await flushMicrotasks();

      expect(schemasIn(sp.requests)).toContain('iglu:com.flipto/arity_one/jsonschema/1-0-0');
    });

    it('attaches a generator of arity 0', async () => {
      const sp = loadBundle('ftsa_ctx0');
      sp.call('newTracker', 'c0', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      sp.call('addGlobalContexts', [
        function () {
          return { schema: 'iglu:com.flipto/arity_zero/jsonschema/1-0-0', data: { ok: true } };
        },
      ]);
      sp.call('trackPageView');
      await flushMicrotasks();

      expect(schemasIn(sp.requests)).toContain('iglu:com.flipto/arity_zero/jsonschema/1-0-0');
    });

    it('does NOT attach a generator of arity 2 (this is the trap, and it is silent)', async () => {
      const sp = loadBundle('ftsa_ctx2');
      sp.call('newTracker', 'c2', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      sp.call('addGlobalContexts', [
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        function (_payload: unknown, _second: unknown) {
          return { schema: 'iglu:com.flipto/arity_two/jsonschema/1-0-0', data: { ok: true } };
        },
      ]);
      sp.call('trackPageView');
      await flushMicrotasks();

      expect(schemasIn(sp.requests)).not.toContain('iglu:com.flipto/arity_two/jsonschema/1-0-0');
    });
  });

  describe('5. Identity survives stateStorageStrategy: none, and the sa_ft naming is intact', () => {
    /**
     * Fork patch: getSnowplowCookieValue always attempts the cookie, and falls back to
     * localStorage, so a pre-existing id is still readable on a page that starts with no
     * consent. A merge that took upstream here would mean a fresh domain user id per page.
     */
    it('reads a pre-existing sa_ft cookie under strategy none', async () => {
      const spWrite = loadBundle('ftsa_id1');
      spWrite.call(
        'newTracker',
        'id1',
        'http://localhost:9999',
        newTrackerArgs({
          cookieName: 'sa_ft',
          stateStorageStrategy: 'cookieAndLocalStorage',
          useLocalStorage: false,
          cookieSecure: false,
          synchronousCookieWrite: true,
        })
      );
      spWrite.call('trackPageView');
      await flushMicrotasks();

      const written = spWrite.tracker().getDomainUserId();
      expect(written).toBeTruthy();
      expect(document.cookie).toContain('sa_ft');

      const spRead = loadBundle('ftsa_id2');
      spRead.call(
        'newTracker',
        'id2',
        'http://localhost:9999',
        newTrackerArgs({
          cookieName: 'sa_ft',
          stateStorageStrategy: 'none',
          useLocalStorage: false,
          cookieSecure: false,
          synchronousCookieWrite: true,
        })
      );
      spRead.call('trackPageView');
      await flushMicrotasks();

      expect(spRead.tracker().getDomainUserId()).toBe(written);
    });

    it('exposes the tracker on window.fliptoDataLayer', async () => {
      const sp = loadBundle('ftsa_dl');
      sp.call('newTracker', 'dl', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      await flushMicrotasks();

      expect((window as any).fliptoDataLayer).toBeDefined();
      expect(typeof sp.tracker().getDomainUserId).toBe('function');
    });

    it('the release build script pins the ftSpacetime whitelabel namespace', () => {
      const buildScript = readFileSync(BUILD_SCRIPT_PATH, 'utf-8');
      expect(buildScript).toContain(`--whitelabel=${RELEASE_WHITELABEL_NAMESPACE}`);
    });

    it('running the tag twice does not throw', () => {
      const sp = loadBundle('ftsa_twice');
      sp.call('newTracker', 'tw', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));
      // second run: the namespace array is empty, so the shift yields undefined
      (window as any)[GLOBAL_NAMESPACE] = [];
      expect(() => window.eval(bundleSource)).not.toThrow();
    });
  });

  describe('6. activityMetrics reaches the callback with no page ping', () => {
    /**
     * Upstream 4.10.x gates activity metrics on
     *   pagePing?.activityMetrics || callback?.activityMetrics
     * so the callback form gets them with no page ping and no extra request. Our build strips
     * plugins, so this checks the metrics survived that stripping.
     */
    it('delivers mouseDistance, keyPresses, clicks and touches to the callback', async () => {
      jest.useFakeTimers();
      const sp = loadBundle('ftsa_am');
      sp.call('newTracker', 'm1', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));

      const seen: any[] = [];
      sp.call('enableActivityTrackingCallback', {
        minimumVisitLength: 10,
        heartbeatDelay: 10,
        activityMetrics: true,
        callback: (data: any) => seen.push(data),
      });
      sp.call('trackPageView');
      await flushMicrotasks();

      const sentAfterPageView = sp.requests.length;

      jest.advanceTimersByTime(5000);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 }));
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 3, clientY: 4 }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      document.dispatchEvent(new MouseEvent('click'));
      document.dispatchEvent(new Event('touchstart'));
      document.dispatchEvent(new Event('scroll'));
      jest.advanceTimersByTime(5000);

      expect(seen.length).toBeGreaterThan(0);
      const metrics = seen[0].activityMetrics;
      expect(metrics).toBeDefined();
      expect(metrics.mouseDistance).toBe(5);
      expect(metrics.keyPresses).toBe(1);
      expect(metrics.clicks).toBe(1);
      expect(metrics.touches).toBe(1);
      expect(typeof metrics.scrollDistance).toBe('number');

      // no page ping, no extra request
      expect(sp.requests.length).toBe(sentAfterPageView);
      jest.useRealTimers();
    });

    it('omits activityMetrics when the flag is not set', async () => {
      jest.useFakeTimers();
      const sp = loadBundle('ftsa_noam');
      sp.call('newTracker', 'm2', 'http://localhost:9999', newTrackerArgs({ useLocalStorage: false }));

      const seen: any[] = [];
      sp.call('enableActivityTrackingCallback', {
        minimumVisitLength: 10,
        heartbeatDelay: 10,
        callback: (data: any) => seen.push(data),
      });
      sp.call('trackPageView');
      await flushMicrotasks();

      jest.advanceTimersByTime(5000);
      document.dispatchEvent(new MouseEvent('mousemove', { clientX: 10, clientY: 10 }));
      jest.advanceTimersByTime(5000);

      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0].activityMetrics).toBeUndefined();
      jest.useRealTimers();
    });
  });

  describe('7. Web Vitals is bundled, not fetched from a third-party CDN', () => {
    it('does not load web-vitals from unpkg', () => {
      expect(bundleSource).not.toContain('unpkg.com');
    });

    it('still carries the web_vitals schema', () => {
      expect(bundleSource).toContain('web_vitals');
    });
  });
});

function schemasIn(requests: Captured[]): string[] {
  const out: string[] = [];
  requests.forEach((r) => {
    (r.body?.data ?? []).forEach((event: any) => {
      const co = event.co ?? event.cx;
      if (!co) return;
      try {
        const parsed = typeof co === 'string' ? JSON.parse(co) : co;
        (parsed.data ?? []).forEach((c: any) => out.push(c.schema));
      } catch {
        /* ignore */
      }
    });
  });
  return out;
}

async function flushMicrotasks(ticks = 8): Promise<void> {
  // Pure microtask draining, so this behaves the same under real and fake timers.
  for (let i = 0; i < ticks; i++) {
    await Promise.resolve();
  }
}
