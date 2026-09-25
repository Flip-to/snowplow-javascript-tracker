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

/* A number is a string's maxLength; [minimum, maximum, integer?] bounds a number */
type SchemaBound = number | [number, number, boolean?];

const INT32_MAX = 2147483647;
const TIMESTAMP: SchemaBound = [-INT32_MAX, INT32_MAX];
const NON_NEGATIVE: SchemaBound = [0, INT32_MAX];
const NON_NEGATIVE_INTEGER: SchemaBound = [0, INT32_MAX, true];

/**
 * Every key the entity sends, in the order it has always been sent, with what
 * iglu:org.w3/PerformanceNavigationTiming/jsonschema/1-0-0 allows for its value.
 * Enrich rejects the whole event when an entity fails its schema, and browsers do report values outside
 * these bounds (WebKit domain lookup times of 2^32 + n, body sizes over 2^31, negative DOM timestamps),
 * so a value that does not fit is left out rather than sent. Every value is optional in the schema.
 */
const performanceNavigationSchema: Record<string, SchemaBound | null> = {
  entryType: 128,
  duration: NON_NEGATIVE,
  nextHopProtocol: 16,
  workerStart: TIMESTAMP,
  redirectStart: TIMESTAMP,
  redirectEnd: TIMESTAMP,
  fetchStart: TIMESTAMP,
  domainLookupStart: TIMESTAMP,
  domainLookupEnd: TIMESTAMP,
  connectStart: TIMESTAMP,
  secureConnectionStart: TIMESTAMP,
  connectEnd: TIMESTAMP,
  requestStart: TIMESTAMP,
  responseStart: TIMESTAMP,
  responseEnd: TIMESTAMP,
  transferSize: NON_NEGATIVE_INTEGER,
  encodedBodySize: NON_NEGATIVE_INTEGER,
  decodedBodySize: NON_NEGATIVE_INTEGER,
  serverTiming: null /* an array of items, each built by constructServerTimingEntry */,
  unloadEventStart: NON_NEGATIVE,
  unloadEventEnd: NON_NEGATIVE,
  domInteractive: NON_NEGATIVE,
  domContentLoadedEventStart: NON_NEGATIVE,
  domContentLoadedEventEnd: NON_NEGATIVE,
  domComplete: NON_NEGATIVE,
  loadEventStart: NON_NEGATIVE,
  loadEventEnd: NON_NEGATIVE,
  type: 32,
  redirectCount: [0, 64, true],
  activationStart: NON_NEGATIVE,
  deliveryType: 128,
};

/* The schema's serverTiming item: name is required, description and duration are optional */
const SERVER_TIMING_TEXT: SchemaBound = 4096;

function isWithinSchema(value: unknown, bound: SchemaBound | null | undefined) {
  if (typeof bound === 'number') {
    /* length counts UTF-16 units, which is never fewer than the code points maxLength counts */
    return typeof value === 'string' && value.length <= bound;
  }
  /* The range comparisons also reject NaN and Infinity. Math.floor because IE 11 has no Number.isInteger */
  return (
    !!bound &&
    typeof value === 'number' &&
    value >= bound[0] &&
    value <= bound[1] &&
    (!bound[2] || Math.floor(value) === value)
  );
}

function constructServerTimingEntry({ description, duration, name }: PerformanceServerTiming) {
  /* Filled in the order the entry was always sent in, so a valid entry serializes as before */
  const entry: { description?: string; duration?: number; name?: string } = {};
  if (isWithinSchema(description, SERVER_TIMING_TEXT)) {
    entry.description = description;
  }
  if (isWithinSchema(duration, NON_NEGATIVE)) {
    entry.duration = duration;
  }
  entry.name = name;
  return entry;
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
  const instance = performanceNavigationTimingInstance as unknown as Record<string, unknown>;

  const performanceContextData = Object.keys(performanceNavigationSchema).reduce((accum, key) => {
    const performanceValue = instance[key];
    if (key === 'serverTiming' && Array.isArray(performanceValue)) {
      /* The object check comes first, so a null item is skipped rather than throwing in the destructure */
      const serverTiming = performanceValue
        .filter((item: PerformanceServerTiming | null) => !!item && isWithinSchema(item.name, SERVER_TIMING_TEXT))
        .map(constructServerTimingEntry);
      accum[key] = serverTiming.length ? serverTiming : undefined;
    } else if (performanceValue && isWithinSchema(performanceValue, performanceNavigationSchema[key])) {
      accum[key] = performanceValue;
    }

    return accum;
  }, {} as Record<string, unknown>);

  return [
    {
      schema: PERFORMANCE_NAVIGATION_TIMING_SCHEMA,
      data: performanceContextData,
    },
  ];
}
