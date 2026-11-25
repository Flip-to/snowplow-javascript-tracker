import { buildLinkClick, trackerCore } from '@snowplow/tracker-core';
import { BrowserTracker } from '@snowplow/browser-tracker-core';
import { setImmediate } from 'timers';

const flushPromises = () => new Promise(setImmediate);

let mockResult: any;
let mockReject: Error | null = null;

jest.mock('bot-signal/browser', () => ({
  detectInstantClientAsync: () => (mockReject ? Promise.reject(mockReject) : Promise.resolve(mockResult)),
}));

const PILOT_SCHEMA = 'iglu:to.flip/ft_bot_signal/jsonschema/1-0-0';
const SCHEMA = 'iglu:com.snowplowanalytics.snowplow/client_side_bot_detection/jsonschema/1-0-0';

function run(expectCx: (cx: any) => void, options?: { mode: 'pilot' }) {
  expect.hasAssertions();
  const { BotSignalPlugin } = require('../src');
  const plugin = BotSignalPlugin(options);
  const core = trackerCore({
    corePlugins: [plugin],
    callback: (pb) => expectCx(pb.getJson().filter((e) => e.keyIfEncoded === 'cx')[0]?.json),
  });
  plugin.activateBrowserPlugin?.({ core } as BrowserTracker);
  return core;
}

describe('BotSignalPlugin', () => {
  beforeEach(() => {
    jest.resetModules();
    mockReject = null;
    mockResult = { isLegitClient: true, suspicionScore: 0, signals: [], automation: { kind: null } };
  });

  it('maps an automation kind outside the schema enum to unknown', async () => {
    mockResult = {
      isLegitClient: false,
      suspicionScore: 0.9,
      signals: [
        { id: 'webdriver', weight: 1, triggered: true },
        { id: 'plugins', weight: 0.2, triggered: false },
      ],
      automation: { kind: 'playwright' },
    };
    const core = run((cx) =>
      expect(cx.data).toEqual([
        { schema: SCHEMA, data: { bot: true, kind: 'unknown' } },
      ])
    );
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('passes through automation kinds that exist in the schema enum', async () => {
    mockResult = { isLegitClient: false, suspicionScore: 1, signals: [], automation: { kind: 'selenium' } };
    const core = run((cx) => expect(cx.data).toEqual([{ schema: SCHEMA, data: { bot: true, kind: 'selenium' } }]));
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('reports unknown when not legit and no automation kind', async () => {
    mockResult = { isLegitClient: false, suspicionScore: 0.5, signals: [], automation: undefined };
    const core = run((cx) => expect(cx.data).toEqual([{ schema: SCHEMA, data: { bot: true, kind: 'unknown' } }]));
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('attaches a no-bot context for a legit client', async () => {
    const core = run((cx) =>
      expect(cx.data).toEqual([{ schema: SCHEMA, data: { bot: false, kind: null } }])
    );
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('pilot mode emits the custom schema with score and fired signals', async () => {
    mockResult = {
      isLegitClient: false,
      suspicionScore: 0.9,
      signals: [
        { id: 'webdriver', weight: 1, triggered: true },
        { id: 'plugins', weight: 0.2, triggered: false },
      ],
      automation: { kind: 'playwright' },
    };
    const core = run(
      (cx) =>
        expect(cx.data).toEqual([
          {
            schema: 'iglu:to.flip/ft_bot_signal/jsonschema/1-0-0',
            data: { bot: true, score: 0.9, kind: 'playwright', signals: ['webdriver'] },
          },
        ]),
      { mode: 'pilot' }
    );
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('attaches nothing while detection is pending', () => {
    const core = run((cx) => expect(cx).toBeUndefined());
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('attaches nothing when detection rejects', async () => {
    mockReject = new Error('boom');
    const core = run((cx) => expect(cx).toBeUndefined());
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('maps nightmare to nightmarejs', async () => {
    mockResult = { isLegitClient: false, suspicionScore: 1, signals: [], automation: { kind: 'nightmare' } };
    const core = run((cx) => expect(cx.data).toEqual([{ schema: SCHEMA, data: { bot: true, kind: 'nightmarejs' } }]));
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('passes phantomjs through', async () => {
    mockResult = { isLegitClient: false, suspicionScore: 1, signals: [], automation: { kind: 'phantomjs' } };
    const core = run((cx) => expect(cx.data).toEqual([{ schema: SCHEMA, data: { bot: true, kind: 'phantomjs' } }]));
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('pilot mode reports kind null for a legitimate client even when bot-signal says unknown', async () => {
    mockResult = { isLegitClient: true, suspicionScore: 0, signals: [], automation: { kind: 'unknown' } };
    const core = run(
      (cx) => expect(cx.data).toEqual([{ schema: PILOT_SCHEMA, data: { bot: false, score: 0, kind: null, signals: [] } }]),
      { mode: 'pilot' }
    );
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('pilot mode clips long ids and caps the signal list to the schema limits', async () => {
    const long = 'x'.repeat(100);
    mockResult = {
      isLegitClient: false,
      suspicionScore: 0.5,
      signals: Array.from({ length: 70 }, () => ({ id: long, weight: 1, triggered: true })),
      automation: { kind: long },
    };
    const core = run(
      (cx) => {
        const data = cx.data[0].data;
        expect(data.kind).toHaveLength(64);
        expect(data.signals).toHaveLength(64);
        expect(data.signals[0]).toHaveLength(64);
      },
      { mode: 'pilot' }
    );
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('pilot mode attaches nothing for a non-finite score', async () => {
    mockResult = { isLegitClient: false, suspicionScore: NaN, signals: [], automation: undefined };
    const core = run((cx) => expect(cx).toBeUndefined(), { mode: 'pilot' });
    await flushPromises();
    core.track(buildLinkClick({ targetUrl: 'https://example.com' }));
  });

  it('keeps each instance in its own mode when two plugins share one detection', async () => {
    expect.hasAssertions();
    mockResult = { isLegitClient: false, suspicionScore: 0.7, signals: [{ id: 'a', weight: 1, triggered: true }], automation: undefined };
    const { BotSignalPlugin } = require('../src');
    const standard = BotSignalPlugin();
    const pilot = BotSignalPlugin({ mode: 'pilot' });
    standard.activateBrowserPlugin?.({} as BrowserTracker);
    pilot.activateBrowserPlugin?.({} as BrowserTracker);
    await flushPromises();
    expect(standard.contexts?.()).toEqual([{ schema: SCHEMA, data: { bot: true, kind: 'unknown' } }]);
    expect(pilot.contexts?.()).toEqual([
      { schema: PILOT_SCHEMA, data: { bot: true, score: 0.7, kind: 'unknown', signals: ['a'] } },
    ]);
  });

  it('retries detection on a later activation after a rejection', async () => {
    expect.hasAssertions();
    mockReject = new Error('boom');
    const { BotSignalPlugin } = require('../src');
    const first = BotSignalPlugin();
    first.activateBrowserPlugin?.({} as BrowserTracker);
    await flushPromises();
    expect(first.contexts?.()).toEqual([]);

    mockReject = null;
    const second = BotSignalPlugin();
    second.activateBrowserPlugin?.({} as BrowserTracker);
    await flushPromises();
    expect(second.contexts?.()).toEqual([{ schema: SCHEMA, data: { bot: false, kind: null } }]);
  });

  it("mode 'both' attaches the standard and the pilot entity", async () => {
    expect.hasAssertions();
    mockResult = {
      isLegitClient: false,
      suspicionScore: 0.9,
      signals: [{ id: 'a', weight: 1, triggered: true }],
      automation: { kind: 'selenium' },
    };
    const { BotSignalPlugin } = require('../src');
    const both = BotSignalPlugin({ mode: 'both' });
    both.activateBrowserPlugin?.({} as BrowserTracker);
    await flushPromises();
    expect(both.contexts?.()).toEqual([
      { schema: SCHEMA, data: { bot: true, kind: 'selenium' } },
      { schema: PILOT_SCHEMA, data: { bot: true, score: 0.9, kind: 'selenium', signals: ['a'] } },
    ]);
  });

  it("mode 'both' still attaches the standard entity when the pilot score is not finite", async () => {
    expect.hasAssertions();
    mockResult = { isLegitClient: true, suspicionScore: NaN, signals: [], automation: undefined };
    const { BotSignalPlugin } = require('../src');
    const both = BotSignalPlugin({ mode: 'both' });
    both.activateBrowserPlugin?.({} as BrowserTracker);
    await flushPromises();
    expect(both.contexts?.()).toEqual([{ schema: SCHEMA, data: { bot: false, kind: null } }]);
  });
});
