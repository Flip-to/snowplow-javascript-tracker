import { PERFORMANCE_NAVIGATION_TIMING_SCHEMA } from './schemata';

declare global {
  interface Window {
    mozPerformance: any;
    msPerformance: any;
    webkitPerformance: any;
  }
}

type PerformanceNavigationTimingContext = PerformanceNavigationTiming & {
  activationStart?: number;
  deliveryType?: string;
};

/**
 * Enrich drops the whole event when one value breaks iglu:org.w3/PerformanceNavigationTiming/jsonschema/1-0-0,
 * and browsers report numbers past its bounds (WebKit gives domain lookup times of 2^32 + n). Every number there
 * is at most 2^31 - 1, and only the fetch-phase timestamps may be negative, down to -(2^31 - 1). FTK-7957
 */
function isInSchemaRange(key: string, value: unknown) {
  const signed = /^(worker|redirect|fetch|domainLookup|connect|secureConnection|request|response)(Start|End)$/;
  return typeof value !== 'number' || (value >= (signed.test(key) ? -2147483647 : 0) && value <= 2147483647);
}

/**
 * Creates a context from the PerformanceNavigationTiming object
 *
 * @returns object PerformanceNavigationTiming context
 */
export function getPerformanceNavigationTimingContext() {
  const performanceAlias =
    window.performance || window.mozPerformance || window.msPerformance || window.webkitPerformance || {};

  if (performanceAlias.getEntriesByType) {
    const [performanceNavigationTiming] = performanceAlias.getEntriesByType('navigation') as [
      PerformanceNavigationTiming
    ];

    if (!performanceNavigationTiming) {
      return [];
    }

    return constructNavigationTimingContext(performanceNavigationTiming);
  }

  return [];
}

export function constructNavigationTimingContext(
  performanceNavigationTimingInstance: PerformanceNavigationTimingContext
) {
  const performanceNavigationKeys = [
    'entryType',
    'duration',
    'nextHopProtocol',
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
    'transferSize',
    'encodedBodySize',
    'decodedBodySize',
    'serverTiming',
    'unloadEventStart',
    'unloadEventEnd',
    'domInteractive',
    'domContentLoadedEventStart',
    'domContentLoadedEventEnd',
    'domComplete',
    'loadEventStart',
    'loadEventEnd',
    'type',
    'redirectCount',
    'activationStart',
    'deliveryType',
  ] as const;

  const performanceContextData = performanceNavigationKeys.reduce((accum, key) => {
    const performanceValue = performanceNavigationTimingInstance[key];
    if (key === 'serverTiming' && Array.isArray(performanceValue)) {
      accum[key] = performanceValue.length
        ? performanceValue.map(({ description, duration, name }: PerformanceServerTiming) => ({
            description,
            duration: isInSchemaRange('duration', duration) ? duration : undefined,
            name,
          }))
        : undefined;
    } else if (performanceValue && isInSchemaRange(key, performanceValue)) {
      accum[key] = performanceValue;
    }

    return accum;
  }, {} as Record<typeof performanceNavigationKeys[number], unknown>);

  return [
    {
      schema: PERFORMANCE_NAVIGATION_TIMING_SCHEMA,
      data: performanceContextData,
    },
  ];
}
