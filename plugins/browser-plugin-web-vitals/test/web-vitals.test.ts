import { JSDOM } from 'jsdom';
import { trackerCore } from '@snowplow/tracker-core';
import { WebVitalsPlugin } from '../src';
import { BrowserTracker } from '@snowplow/browser-tracker-core';

declare var jsdom: JSDOM;

/**
 * This fork bundles the web-vitals package rather than injecting a script tag pointing at
 * unpkg, so there is no window.webVitals to stub. Mock the module instead, which is the
 * same fixture the upstream test built on window.
 */
jest.mock('web-vitals', () => {
  const measurement = (callback: (metric: { value: number; navigationType: string }) => void) => {
    callback({ value: 0.01, navigationType: 'navigation' });
  };
  return {
    onCLS: measurement,
    onLCP: measurement,
    onFCP: measurement,
    onFID: measurement,
    onINP: measurement,
    onTTFB: measurement,
  };
});

describe('Web Vitals plugin', () => {
  it('Returns values for Web Vitals properties', (done) => {
    Object.defineProperty(jsdom.window, 'PerformanceObserver', { value: jest.fn() });

    const core = trackerCore({
      corePlugins: [],
      callback: (payloadBuilder) => {
        const [data, ...context] = payloadBuilder.getJson();
        expect(data.json.data).toMatchSnapshot();
        expect(context.map(({ json }) => json)).toMatchSnapshot('context');
        done();
      },
    });

    WebVitalsPlugin({
      context: [{ schema: 'iglu:com.example/test/jsonschema/1-0-0', data: { ok: true } }],
    }).activateBrowserPlugin?.({ core } as BrowserTracker);
    const pagehideEvent = new PageTransitionEvent('pagehide');
    jsdom.window.dispatchEvent(pagehideEvent);
  });
});
