import { SelfDescribingJson } from '@snowplow/tracker-core';
import { Plugins } from '../../src/features';

describe('Performance Navigation Timing', () => {
  let windowSpy: any;

  const otherContexts = {
    webPage: false,
    session: false,
    performanceTiming: false,
    gaCookies: false,
    geolocation: false,
    clientHints: false,
    webVitals: false,
  };

  const hasPerformanceNavigationTimingContext = (plugins: ReturnType<typeof Plugins>): boolean => {
    const pluginContexts = plugins.map((plugin) => plugin[0]?.contexts?.());
    const hasPerformanceContext = pluginContexts.some((contexts?: SelfDescribingJson[]) =>
      contexts?.some(
        (context: { schema?: string }) => context.schema === 'iglu:org.w3/PerformanceNavigationTiming/jsonschema/1-0-0'
      )
    );
    return hasPerformanceContext;
  };

  beforeEach(() => {
    windowSpy = jest.spyOn(global, 'window', 'get');

    // The PerformanceNavigationTiming context will only be added if the plugin can:
    // - Access the `performance` object on the window
    // - See that a value is returned from `getEntriesByType`
    windowSpy.mockImplementation(() => ({
      performance: {
        getEntriesByType: () => [{}],
      },
    }));
  });

  it('Is enabled if contexts.performanceNavigationTiming is true', () => {
    const plugins = Plugins({
      contexts: {
        performanceNavigationTiming: true,
        ...otherContexts,
      },
    });

    expect(hasPerformanceNavigationTimingContext(plugins)).toBe(true);
  });

  it('Is disabled if contexts.performanceNavigationTiming is false', () => {
    const plugins = Plugins({
      contexts: {
        performanceNavigationTiming: false,
        ...otherContexts,
      },
    });

    expect(hasPerformanceNavigationTimingContext(plugins)).toBe(false);
  });
});

describe('WebView plugin', () => {
  it('WebViewPlugin is not activated when webView flag is false', () => {
    jest.isolateModules(() => {
      const mockWebViewPlugin = jest.fn(() => ({}));
      jest.mock('@snowplow/browser-plugin-webview', () => ({
        WebViewPlugin: mockWebViewPlugin,
      }));
      jest.mock('../../tracker.config', () => ({ webView: false }));
      // Vimeo player crashes on fresh module load in jsdom; mock it to prevent that
      jest.mock('@snowplow/browser-plugin-vimeo-tracking', () => ({
        VimeoTrackingPlugin: jest.fn(() => ({})),
      }));
      const { Plugins: PluginsFresh } = require('../../src/features');
      PluginsFresh({});
      expect(mockWebViewPlugin).not.toHaveBeenCalled();
    });
  });

  it('WebViewPlugin is activated when webView flag is true', () => {
    jest.isolateModules(() => {
      const mockWebViewPlugin = jest.fn(() => ({}));
      jest.mock('@snowplow/browser-plugin-webview', () => ({
        WebViewPlugin: mockWebViewPlugin,
      }));
      jest.mock('../../tracker.config', () => ({ webView: true }));
      // Vimeo player crashes on fresh module load in jsdom; mock it to prevent that
      jest.mock('@snowplow/browser-plugin-vimeo-tracking', () => ({
        VimeoTrackingPlugin: jest.fn(() => ({})),
      }));
      const { Plugins: PluginsFresh } = require('../../src/features');
      PluginsFresh({});
      expect(mockWebViewPlugin).toHaveBeenCalled();
    });
  });
});

describe('PageEngagement plugin', () => {
  const load = (flag: boolean, contexts: Record<string, unknown> = {}) => {
    let result: { mock: jest.Mock; plugins: Array<[unknown, Record<string, unknown>]> } | undefined;
    jest.isolateModules(() => {
      const mock = jest.fn(() => ({}));
      jest.mock('@snowplow/browser-plugin-page-engagement', () => ({
        PageEngagementPlugin: mock,
        enablePageEngagement: () => undefined,
      }));
      jest.mock('../../tracker.config', () => ({ pageEngagement: flag }));
      jest.mock('@snowplow/browser-plugin-vimeo-tracking', () => ({
        VimeoTrackingPlugin: jest.fn(() => ({})),
      }));
      const { Plugins: PluginsFresh } = require('../../src/features');
      result = { mock, plugins: PluginsFresh({ contexts }) };
    });
    return result!;
  };

  it('is not activated when the bundle does not carry it', () => {
    expect(load(false, { pageEngagement: true }).mock).not.toHaveBeenCalled();
  });

  // Activated even without the context flag, so the enablePageEngagement command a GTM container
  // sends exists; the plugin itself stays inert.
  it('is activated without contexts.pageEngagement and exposes enablePageEngagement', () => {
    const { mock, plugins } = load(true);
    expect(mock).toHaveBeenCalledWith(undefined);
    expect(plugins.some(([, api]) => typeof api.enablePageEngagement === 'function')).toBe(true);
  });

  it('passes contexts.pageEngagement through as the auto-enable configuration', () => {
    expect(load(true, { pageEngagement: { piggyback: true } }).mock).toHaveBeenCalledWith({ piggyback: true });
  });
});
