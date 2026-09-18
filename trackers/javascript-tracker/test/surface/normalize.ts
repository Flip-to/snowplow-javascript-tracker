/**
 * Reduces the events Snowplow Micro received to a comparable surface: which fields and context
 * schemas a bundle actually emits, and what it puts in them.
 *
 * The exclusion lists below are the whole trustworthiness of the comparison. A generous list makes
 * any two bundles look identical, so both are short, enumerated here rather than assembled from
 * patterns, and printed by the runner so a reviewer sees what was dropped.
 */

/** Different on every event by construction. Comparing them would only ever produce noise. */
export const VOLATILE_FIELDS = [
  'event_id',
  'collector_tstamp',
  'derived_tstamp',
  'dvce_created_tstamp',
  'dvce_sent_tstamp',
  'etl_tstamp',
  'true_tstamp',
  'load_tstamp',
  'domain_userid',
  'domain_sessionid',
  'network_userid',
  'user_ipaddress',
  'user_fingerprint',
  'page_view_id',
  'sessionId',
  'previousSessionId',
  'firstEventId',
  'firstEventTimestamp',
  'userId',
];

/**
 * Stable for a given machine and browser, different between machines. Dropped only when comparing
 * runs from different environments; a same-machine A/B keeps them, because a difference there would
 * be a real one.
 */
export const ENVIRONMENT_FIELDS = [
  'useragent',
  'br_name',
  'br_version',
  'br_family',
  'br_renderengine',
  'br_lang',
  'br_cookies',
  'br_colordepth',
  'br_viewwidth',
  'br_viewheight',
  'dvce_screenwidth',
  'dvce_screenheight',
  'doc_width',
  'doc_height',
  'doc_charset',
  'os_name',
  'os_family',
  'os_manufacturer',
  'os_timezone',
  'dvce_type',
  'dvce_ismobile',
  'viewport',
  'documentSize',
  'resolution',
  'colorDepth',
  'devicePixelRatio',
  'tabId',
  'brands',
  'architecture',
  'model',
  'platformVersion',
  'uaFullVersion',
  'fullVersionList',
];

export interface NormalizeOptions {
  /** Drop the environment list too. Needed when the two runs came from different machines. */
  crossEnvironment?: boolean;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Flattens to `a.b.c=value` lines so a diff points at the exact field rather than a blob. */
function flatten(value: unknown, prefix: string, drop: Set<string>, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, drop, out));
    return;
  }
  if (isObject(value)) {
    Object.keys(value)
      .sort()
      .forEach((k) => {
        if (drop.has(k)) {
          return;
        }
        flatten(value[k], prefix ? `${prefix}.${k}` : k, drop, out);
      });
    return;
  }
  out.push(`${prefix}=${JSON.stringify(value)}`);
}

/**
 * One entry per event, keyed by what the event is rather than by arrival order, since ordering
 * between a page view and its first page ping is not guaranteed.
 */
export function normalizeEvents(raw: Array<any>, options: NormalizeOptions = {}): string[] {
  const drop = new Set([...VOLATILE_FIELDS, ...(options.crossEnvironment ? ENVIRONMENT_FIELDS : [])]);

  return raw
    .map((entry) => {
      const event = entry?.event ?? {};
      const lines: string[] = [];
      flatten(event, '', drop, lines);

      const kind = [event.event, event.event_name, event.se_category, event.se_action]
        .filter(Boolean)
        .join('/');

      return [`### ${kind}`, ...lines.sort()].join('\n');
    })
    .sort();
}

/** Schema URIs the bundle emitted, which is the column set a warehouse ends up with. */
export function schemaSurface(raw: Array<any>): string[] {
  const schemas = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (isObject(v)) {
      if (typeof v.schema === 'string') {
        schemas.add(v.schema);
      }
      Object.values(v).forEach(walk);
    }
  };
  walk(raw);
  return [...schemas].sort();
}
