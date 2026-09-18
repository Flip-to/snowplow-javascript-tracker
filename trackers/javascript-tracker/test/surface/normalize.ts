/**
 * Reduces the events Snowplow Micro received to a comparable surface: which fields and context
 * schemas a bundle emits, and what it puts in them.
 *
 * The exclusion list is the whole trustworthiness of a comparison like this. A generous one makes
 * any two builds look identical, so only ids and timestamps are dropped outright. Everything else
 * that varies is measured, by running the same bundle twice and treating whatever differs as the
 * noise floor.
 */

/** Different on every event, or fixed once per run so the two loads inside a run cannot see it. */
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
  'tabId',
];

/**
 * Fields the browser decides rather than the tracker, held to presence instead of value. A runner
 * image that bumps Chrome changes the user agent, and that is not a tracker change; a user agent
 * that stops being sent is. Pinning the browser instead would leave the suite testing a museum.
 *
 * Matched by leaf name anywhere in the event, so a name here silences that field wherever it
 * appears. Keep it to names only the environment owns.
 */
export const ENVIRONMENT_FIELDS = [
  'useragent',
  'br_lang',
  'br_colordepth',
  'br_viewwidth',
  'br_viewheight',
  'dvce_screenwidth',
  'dvce_screenheight',
  'doc_width',
  'doc_height',
  'doc_charset',
  'os_timezone',
  'viewport',
  'documentSize',
  'resolution',
  'colorDepth',
  'devicePixelRatio',
  'browserLanguage',
  'deviceMemory',
  'hardwareConcurrency',
];

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Flattens to `a.b.c=value` so a failure names the exact field rather than printing a blob. */
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
 * Lines are prefixed with the event they came from. Without that the seven events collapse into one
 * set, and a field that only one event stops sending is hidden by an identical line from another:
 * page_view and page_ping both carry page_title, so losing it from either would compare equal.
 */
export function surfaceLines(raw: Array<any>): Set<string> {
  const drop = new Set(VOLATILE_FIELDS);
  const out: string[] = [];
  raw.forEach((entry) => flatten(entry?.event ?? {}, entry?.event?.event_name ?? '', drop, out));
  return new Set(out);
}

/** Field path without its value, array indexes collapsed, so two runs line up. */
export function pathOf(line: string): string {
  return line.split('=')[0].replace(/\[\d+\]/g, '[]');
}

const leafOf = (line: string): string => {
  const path = line.split('=')[0];
  return path.slice(path.lastIndexOf('.') + 1);
};

/** True when the line's value belongs to the machine, so only its presence is comparable. */
export const isEnvironmentLine = (line: string): boolean => ENVIRONMENT_FIELDS.indexOf(leafOf(line)) !== -1;

/** Values for what the tracker produces, bare paths for what it only passes through. */
export function comparable(lines: string[]): string[] {
  return lines.map((l) => (isEnvironmentLine(l) ? `${pathOf(l)}=<environment>` : l)).sort();
}

/**
 * Paths that differ between two runs of the SAME bundle. Timings, transfer sizes and per-session
 * counters land here on their own, without anyone deciding they should.
 */
export function noiseFloor(runA: Set<string>, runB: Set<string>): Set<string> {
  const differing = new Set<string>();
  runA.forEach((l) => {
    if (!runB.has(l)) {
      differing.add(pathOf(l));
    }
  });
  runB.forEach((l) => {
    if (!runA.has(l)) {
      differing.add(pathOf(l));
    }
  });
  return differing;
}

/** The lines a comparison can hold a build to: everything the same build does not vary by. */
export function stableLines(run: Set<string>, noise: Set<string>): string[] {
  return comparable(Array.from(run).filter((l) => !noise.has(pathOf(l))));
}

/** Schema URIs emitted, which is the column set a warehouse ends up with. */
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
  return Array.from(schemas).sort();
}
