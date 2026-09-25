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

describe('constructNavigationTimingContext', () => {
  const validEntry = {
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
    responseStatus: 200,
    serverTiming: [{ description: 'test', duration: 1900, name: 'ttfb_estimate' }],
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

  const contextData = (entry: object) =>
    constructNavigationTimingContext(entry as PerformanceNavigationTiming)[0].data as Record<string, unknown>;

  const validData = () => contextData(validEntry);

  const withoutKeys = (data: Record<string, unknown>, ...keys: string[]) => {
    const copy = { ...data };
    keys.forEach((key) => delete copy[key]);
    return copy;
  };

  it('serializes a valid entry exactly as before', () => {
    expect(JSON.stringify(validData())).toBe(
      '{"entryType":"navigation","duration":1803.8000001907349,"nextHopProtocol":"h2","workerStart":1,' +
        '"redirectStart":1,"redirectEnd":1,"fetchStart":18.200000286102295,"domainLookupStart":25.90000009536743,' +
        '"domainLookupEnd":79,"connectStart":79,"secureConnectionStart":101.90000009536743,' +
        '"connectEnd":236.09999990463257,"requestStart":236.09999990463257,"responseStart":376.7000002861023,' +
        '"responseEnd":401.7000002861023,"transferSize":11773,"encodedBodySize":11473,"decodedBodySize":59833,' +
        '"serverTiming":[{"description":"test","duration":1900,"name":"ttfb_estimate"}],"unloadEventStart":1,' +
        '"unloadEventEnd":1,"domInteractive":1077.5,"domContentLoadedEventStart":1077.5999999046326,' +
        '"domContentLoadedEventEnd":1078.2000002861023,"domComplete":1802.2000002861023,' +
        '"loadEventStart":1803.7000002861023,"loadEventEnd":1803.8000001907349,"type":"reload","redirectCount":1,' +
        '"activationStart":203.8,"deliveryType":"cache"}'
    );
  });

  it('keeps values exactly at the schema bounds', () => {
    const atBounds = {
      redirectStart: -2147483647,
      domainLookupStart: 2147483647,
      encodedBodySize: 2147483647,
      loadEventEnd: 2147483647,
      redirectCount: 64,
      nextHopProtocol: 'x'.repeat(16),
      type: 'x'.repeat(32),
      deliveryType: 'x'.repeat(128),
      serverTiming: [{ description: 'd'.repeat(4096), duration: 2147483647, name: 'n'.repeat(4096) }],
    };

    expect(contextData({ ...validEntry, ...atBounds })).toStrictEqual({ ...validData(), ...atBounds });
  });

  it('omits the WebKit domain lookup times of 2^32 + n and keeps everything else', () => {
    const entry = { ...validEntry, domainLookupStart: 4294967297, domainLookupEnd: 4294967297 };

    expect(contextData(entry)).toStrictEqual(withoutKeys(validData(), 'domainLookupStart', 'domainLookupEnd'));
  });

  it('omits infinite values and values of the wrong type', () => {
    const entry = { ...validEntry, fetchStart: Infinity, connectStart: '79', type: 1 };

    expect(contextData(entry)).toStrictEqual(withoutKeys(validData(), 'fetchStart', 'connectStart', 'type'));
  });

  /* An item's invalid description or duration is sent as undefined, which JSON.stringify leaves out, hence toEqual */
  it('omits a server timing duration outside the item schema and keeps the entry', () => {
    const entry = {
      ...validEntry,
      serverTiming: [
        { description: 'too big', duration: 2147483648, name: 'cdn' },
        { description: 'negative', duration: -1, name: 'db' },
        { description: 'test', duration: 1900, name: 'ttfb_estimate' },
      ],
    };

    expect(contextData(entry)).toEqual({
      ...validData(),
      serverTiming: [
        { description: 'too big', name: 'cdn' },
        { description: 'negative', name: 'db' },
        { description: 'test', duration: 1900, name: 'ttfb_estimate' },
      ],
    });
  });

  it('omits a server timing description over 4096 characters and keeps the entry', () => {
    const entry = { ...validEntry, serverTiming: [{ description: 'd'.repeat(4097), duration: 1900, name: 'cdn' }] };

    expect(contextData(entry)).toEqual({ ...validData(), serverTiming: [{ duration: 1900, name: 'cdn' }] });
  });

  it('drops a server timing entry whose required name breaks the item schema', () => {
    const entry = {
      ...validEntry,
      serverTiming: [
        { description: 'test', duration: 1900, name: 'n'.repeat(4097) },
        { description: 'test', duration: 1900, name: 'ttfb_estimate' },
      ],
    };

    expect(contextData(entry)).toStrictEqual(validData());
  });

  it('leaves serverTiming out when no entry survives', () => {
    const entry = { ...validEntry, serverTiming: [{ description: 'test', duration: 1900, name: 'n'.repeat(4097) }] };

    expect(contextData(entry).serverTiming).toBeUndefined();
    expect(JSON.stringify(contextData(entry))).not.toContain('serverTiming');
  });

  it('omits a serverTiming that is not an array', () => {
    expect(contextData({ ...validEntry, serverTiming: { length: 1 } })).not.toHaveProperty('serverTiming');
  });

  it('skips a null serverTiming item rather than throwing', () => {
    const entry = { ...validEntry, serverTiming: [null, { duration: 1900, name: 'cdn' }] };

    expect(contextData(entry).serverTiming).toEqual([{ duration: 1900, name: 'cdn' }]);
  });

  /* Bounds copied from the schema, written out apart from the builder's table so a wrong entry there fails here */
  const signed = { min: -2147483647, max: 2147483647 };
  const unsigned = { min: 0, max: 2147483647 };
  const schemaNumbers: Array<[string, { min: number; max: number; integer?: boolean }]> = [
    ['duration', unsigned],
    ['workerStart', signed],
    ['redirectStart', signed],
    ['redirectEnd', signed],
    ['fetchStart', signed],
    ['domainLookupStart', signed],
    ['domainLookupEnd', signed],
    ['connectStart', signed],
    ['secureConnectionStart', signed],
    ['connectEnd', signed],
    ['requestStart', signed],
    ['responseStart', signed],
    ['responseEnd', signed],
    ['transferSize', { ...unsigned, integer: true }],
    ['encodedBodySize', { ...unsigned, integer: true }],
    ['decodedBodySize', { ...unsigned, integer: true }],
    ['unloadEventStart', unsigned],
    ['unloadEventEnd', unsigned],
    ['domInteractive', unsigned],
    ['domContentLoadedEventStart', unsigned],
    ['domContentLoadedEventEnd', unsigned],
    ['domComplete', unsigned],
    ['loadEventStart', unsigned],
    ['loadEventEnd', unsigned],
    ['redirectCount', { min: 0, max: 64, integer: true }],
    ['activationStart', unsigned],
  ];
  const schemaStrings: Array<[string, number]> = [
    ['entryType', 128],
    ['nextHopProtocol', 16],
    ['type', 32],
    ['deliveryType', 128],
  ];

  const dataWith = (key: string, value: unknown) => contextData({ ...validEntry, [key]: value });

  /* An invalid value must take only its own key with it, so omission is checked against the whole entity */
  it.each(schemaNumbers)('%s keeps values at its schema bounds and omits values past them', (key, bound) => {
    const omitted = withoutKeys(validData(), key);
    expect(dataWith(key, bound.max)[key]).toBe(bound.max);
    expect(dataWith(key, bound.max + 1)).toStrictEqual(omitted);
    expect(dataWith(key, bound.min - 1)).toStrictEqual(omitted);
    /* A fraction past the bound catches a comparison loosened by less than 1 */
    expect(dataWith(key, bound.max + 0.5)).toStrictEqual(omitted);
    expect(dataWith(key, bound.min - 0.5)).toStrictEqual(omitted);
    /* 0 is falsy, and falsy values have always been skipped, so only a non-zero minimum is sent */
    if (bound.min !== 0) {
      expect(dataWith(key, bound.min)[key]).toBe(bound.min);
    }
    if (bound.integer) {
      expect(dataWith(key, 1.5)).toStrictEqual(omitted);
    } else {
      expect(dataWith(key, 1.5)[key]).toBe(1.5);
    }
  });

  it.each(schemaStrings)('%s keeps a string of its maxLength (%s) and omits a longer one', (key, maxLength) => {
    expect(dataWith(key, 'a'.repeat(maxLength))[key]).toBe('a'.repeat(maxLength));
    expect(dataWith(key, 'a'.repeat(maxLength + 1))).toStrictEqual(withoutKeys(validData(), key));
  });

  it('sends only keys the schema defines', () => {
    /* validEntry carries name, startTime, initiatorType, renderBlockingStatus and responseStatus, which 1-0-0 lacks */
    const schemaKeys = schemaNumbers
      .map(([key]) => key)
      .concat(
        schemaStrings.map(([key]) => key),
        'serverTiming'
      );

    expect(Object.keys(validData()).filter((key) => schemaKeys.indexOf(key) === -1)).toStrictEqual([]);
  });
});
