import { buildLinkClick, trackerCore } from '@snowplow/tracker-core';
import { JSDOM } from 'jsdom';
import { PerformanceNavigationTimingPlugin } from '../src';
import { constructNavigationTimingContext } from '../src/contexts';

declare var jsdom: JSDOM;

describe('Performance Navigation Timing plugin', () => {
  it('Returns values for Performance Navigation Timing properties', (done) => {
    const sampleNavigationTimingEntry = {
      name: 'https://web.dev/navigation-and-resource-timing/#wrapping-up',
      entryType: 'navigation',
      startTime: 0,
      duration: 1803.8000001907349,
      initiatorType: 'navigation',
      deliveryType: 'cache',
      nextHopProtocol: 'h2',
      renderBlockingStatus: 'blocking',
      workerStart: 1,
      redirectStart: 1,
      redirectEnd: 1,
      fetchStart: 18.200000286102295,
      domainLookupStart: 25.90000009536743,
      domainLookupEnd: 79,
      connectStart: 79,
      secureConnectionStart: 101.90000009536743,
      connectEnd: 236.09999990463257,
      requestStart: 236.09999990463257,
      responseStart: 376.7000002861023,
      responseEnd: 401.7000002861023,
      transferSize: 11773,
      encodedBodySize: 11473,
      decodedBodySize: 59833,
      responseStatus: 1,
      serverTiming: [
        {
          description: 'test',
          duration: 1900,
          name: 'ttfb_estimate',
        },
      ],
      unloadEventStart: 1,
      unloadEventEnd: 1,
      domInteractive: 1077.5,
      domContentLoadedEventStart: 1077.5999999046326,
      domContentLoadedEventEnd: 1078.2000002861023,
      domComplete: 1802.2000002861023,
      loadEventStart: 1803.7000002861023,
      loadEventEnd: 1803.8000001907349,
      type: 'reload',
      redirectCount: 1,
      activationStart: 203.8,
    };

    Object.defineProperty(jsdom.window.performance, 'getEntriesByType', {
      value: (entryType: string) => {
        if (entryType === 'navigation') {
          return [sampleNavigationTimingEntry];
        }
        return [];
      },
      configurable: true,
    });

    const core = trackerCore({
      corePlugins: [PerformanceNavigationTimingPlugin()],
      callback: (payloadBuilder) => {
        const json = payloadBuilder.getJson().filter((e) => e.keyIfEncoded === 'cx');
        expect(json[0].json).toMatchSnapshot();
        done();
      },
    });

    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('Returns values for Performance Navigation Timing properties removing empty or zero values', (done) => {
    const sampleNavigationTimingEntry = {
      name: 'https://web.dev/navigation-and-resource-timing/#wrapping-up',
      entryType: 'navigation',
      startTime: 0,
      duration: 1803.8000001907349,
      initiatorType: 'navigation',
      deliveryType: 'cache',
      nextHopProtocol: 'h2',
      renderBlockingStatus: 'blocking',
      workerStart: 0,
      redirectStart: 0,
      redirectEnd: 0,
      fetchStart: 18.200000286102295,
      domainLookupStart: 25.90000009536743,
      domainLookupEnd: 79,
      connectStart: 79,
      secureConnectionStart: 101.90000009536743,
      connectEnd: 236.09999990463257,
      requestStart: 236.09999990463257,
      responseStart: 376.7000002861023,
      responseEnd: 401.7000002861023,
      transferSize: 11773,
      encodedBodySize: 11473,
      decodedBodySize: 59833,
      responseStatus: 0,
      serverTiming: [],
      unloadEventStart: 1,
      unloadEventEnd: 1,
      domInteractive: 1077.5,
      domContentLoadedEventStart: 1077.5999999046326,
      domContentLoadedEventEnd: 1078.2000002861023,
      domComplete: 1802.2000002861023,
      loadEventStart: 1803.7000002861023,
      loadEventEnd: 1803.8000001907349,
      type: 'reload',
      redirectCount: 0,
      activationStart: 0,
    };

    Object.defineProperty(jsdom.window.performance, 'getEntriesByType', {
      value: (entryType: string) => {
        if (entryType === 'navigation') {
          return [sampleNavigationTimingEntry];
        }
        return [];
      },
      configurable: true,
    });

    const core = trackerCore({
      corePlugins: [PerformanceNavigationTimingPlugin()],
      callback: (payloadBuilder) => {
        const json = payloadBuilder.getJson().filter((e) => e.keyIfEncoded === 'cx');
        expect(json[0].json).toMatchSnapshot();
        done();
      },
    });

    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });
});

describe('constructNavigationTimingContext leaves out numbers outside the schema range', () => {
  const contextData = (entry: object) =>
    constructNavigationTimingContext(entry as PerformanceNavigationTiming)[0].data as Record<string, unknown>;

  /* Written out from the schema: these timestamps may go down to -(2^31 - 1), every other number starts at 0 */
  const signed = [
    'workerStart',
    'redirectStart',
    'redirectEnd',
    'fetchStart',
    'domainLookupStart',
    'domainLookupEnd',
    'connectStart',
    'secureConnectionStart',
    'connectEnd',
    'requestStart',
    'responseStart',
    'responseEnd',
  ];
  const unsigned = [
    'duration',
    'transferSize',
    'encodedBodySize',
    'decodedBodySize',
    'unloadEventStart',
    'unloadEventEnd',
    'domInteractive',
    'domContentLoadedEventStart',
    'domContentLoadedEventEnd',
    'domComplete',
    'loadEventStart',
    'loadEventEnd',
    'redirectCount',
    'activationStart',
  ];
  /* type rides along, so a value left out must take only its own key with it */
  const dataWith = (key: string, value: number) => contextData({ type: 'navigate', [key]: value });

  it.each(signed.concat(unsigned))('%s leaves out a value over 2^31 - 1', (key) => {
    expect(dataWith(key, 2147483647.5)).toStrictEqual({ type: 'navigate' });
  });

  it.each(signed)('%s keeps -(2^31 - 1) to 2^31 - 1 and leaves out anything smaller', (key) => {
    expect(dataWith(key, 2147483647)).toStrictEqual({ type: 'navigate', [key]: 2147483647 });
    expect(dataWith(key, -2147483647)).toStrictEqual({ type: 'navigate', [key]: -2147483647 });
    expect(dataWith(key, -2147483647.5)).toStrictEqual({ type: 'navigate' });
  });

  it.each(unsigned)('%s leaves out a negative value', (key) => {
    expect(dataWith(key, -0.5)).toStrictEqual({ type: 'navigate' });
  });

  it("leaves out WebKit's domain lookup times of 2^32 + n", () => {
    const entry = { fetchStart: 3.5, domainLookupStart: 4294967297, domainLookupEnd: 4294967298 };

    expect(contextData(entry)).toStrictEqual({ fetchStart: 3.5 });
  });

  it('leaves an out-of-range serverTiming duration out of its item', () => {
    const serverTiming = [
      { description: 'cdn', duration: 2147483648, name: 'cdn' },
      { description: 'db', duration: -1, name: 'db' },
      { description: 'app', duration: 12.5, name: 'app' },
    ];

    expect(JSON.stringify(contextData({ serverTiming }))).toBe(
      '{"serverTiming":[{"description":"cdn","name":"cdn"},{"description":"db","name":"db"},' +
        '{"description":"app","duration":12.5,"name":"app"}]}'
    );
  });
});
