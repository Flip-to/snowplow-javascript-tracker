import { onCLS, onFCP, onFID, onINP, onLCP, onTTFB } from 'web-vitals';
import { MetricType } from './types';

/**
 * Attach page listeners to collect the Web Vitals values
 * @param {() => void} callback
 */
export function attachWebVitalsPageListeners(callback: () => void) {
  // Safari does not fire "visibilitychange" on the tab close
  // So we have 2 options: lose Safari data, or lose LCP/CLS that depends on "visibilitychange" logic.
  // Current solution: if LCP/CLS supported, use `onHidden` otherwise, use `pagehide` to fire the callback in the end.
  //
  // More details: https://github.com/treosh/web-vitals-reporter/issues/3
  const supportedEntryTypes = (PerformanceObserver && PerformanceObserver.supportedEntryTypes) || [];
  const isLatestVisibilityChangeSupported = supportedEntryTypes.indexOf('layout-shift') !== -1;

  if (isLatestVisibilityChangeSupported) {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        callback();
        window.removeEventListener('visibilitychange', onVisibilityChange, true);
      }
    };
    window.addEventListener('visibilitychange', onVisibilityChange, true);
  } else {
    window.addEventListener('pagehide', callback, { capture: true, once: true });
  }
}

/**
 *
 * Adds the Web Vitals measurements on the object used by the trackers to store metric properties.
 * @param {Record<string, unknown>} webVitalsObject
 * @return {void}
 */
export function webVitalsListener(webVitalsObject: Record<string, unknown>) {
  function addWebVitalsMeasurement(metricSchemaName: string): (arg: MetricType) => void {
    return (arg) => {
      webVitalsObject[metricSchemaName] = arg.value;
      webVitalsObject.navigationType = arg.navigationType;
    };
  }
  onCLS(addWebVitalsMeasurement('cls'));
  onFID(addWebVitalsMeasurement('fid'));
  onLCP(addWebVitalsMeasurement('lcp'));
  onFCP(addWebVitalsMeasurement('fcp'));
  onINP(addWebVitalsMeasurement('inp'));
  onTTFB(addWebVitalsMeasurement('ttfb'));
}
