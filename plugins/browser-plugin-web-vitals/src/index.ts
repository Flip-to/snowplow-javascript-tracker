import { BrowserPlugin, BrowserTracker, dispatchToTrackersInCollection } from '@snowplow/browser-tracker-core';
import { buildSelfDescribingEvent, DynamicContext, resolveDynamicContext } from '@snowplow/tracker-core';
import { WEB_VITALS_SCHEMA } from './schemata';
import { attachWebVitalsPageListeners, webVitalsListener } from './utils';

const _trackers: Record<string, BrowserTracker> = {};
let listenersAttached = false;
interface WebVitalsPluginOptions {
  loadWebVitalsScript?: boolean;
  webVitalsSource?: string;
  context?: DynamicContext;
}
const defaultPluginOptions = {
  context: [],
};

/**
 * Adds Web Vitals measurement events
 *
 * @remarks
 */
export function WebVitalsPlugin(pluginOptions: WebVitalsPluginOptions = defaultPluginOptions): BrowserPlugin {
  const webVitalsObject: Record<string, unknown> = {};
  const options = { ...defaultPluginOptions, ...pluginOptions };
  let trackerId: string;
  return {
    activateBrowserPlugin: (tracker) => {
      trackerId = tracker.id;
      _trackers[trackerId] = tracker;

      function sendWebVitals() {
        if (!Object.keys(webVitalsObject).length) {
          return;
        }
        dispatchToTrackersInCollection(Object.keys(_trackers), _trackers, (t) => {
          t.core.track(
            buildSelfDescribingEvent({
              event: {
                schema: WEB_VITALS_SCHEMA,
                data: webVitalsObject,
              },
            }),
            resolveDynamicContext(options.context ?? [], webVitalsObject)
          );
        });
      }

      /*
       * Attach page listeners only once per page.
       * Prevent multiple trackers from attaching listeners multiple times.
       */
      if (!listenersAttached) {
        webVitalsListener(webVitalsObject);
        attachWebVitalsPageListeners(sendWebVitals);
        listenersAttached = true;
      }

      return;
    },
  };
}
