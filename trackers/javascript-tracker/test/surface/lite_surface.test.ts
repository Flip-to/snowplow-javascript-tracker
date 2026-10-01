import fs from 'fs';
import path from 'path';
import { fetchResults } from '../micro';
import { pageSetup } from '../integration/helpers';
import { comparable, noiseFloor, pathOf, schemaSurface, stableLines, surfaceLines } from './normalize';

/**
 * Holds the shipped bundle to the event surface recorded in golden.json: which schemas it emits,
 * which atomic fields it fills, and what it puts in them.
 *
 * It loads dist/sp.lite.js, the artifact that becomes ftsa2.js, rather than the differently
 * configured bundle the rest of the suite uses: tracker.test.config.ts has webVitals and
 * performanceNavigationTiming off, so nothing else here observes what we ship.
 *
 * The page is loaded twice and the difference between those loads is the noise floor. Only fields a
 * single build keeps constant are compared, so the exclusion list is measured, not chosen.
 *
 * Every run writes what it measured to golden.recorded.json, which CI uploads. Re-recording is
 * copying that file over golden.json and committing the diff.
 */

const GOLDEN = path.join(__dirname, 'golden.json');
const RECORDED = path.join(__dirname, 'golden.recorded.json');

/** One per plugin the lite bundle carries that the rest of the suite's bundle does not. */
const REQUIRED_SCHEMAS = [
  'iglu:com.snowplowanalytics.snowplow/web_vitals/jsonschema/1-0-0',
  'iglu:org.w3/PerformanceNavigationTiming/jsonschema/1-0-0',
  'iglu:com.google.analytics/cookies/jsonschema/1-0-0',
  'iglu:com.google.ga4/cookies/jsonschema/1-0-0',
  'iglu:com.google.analytics.enhanced-ecommerce/productFieldObject/jsonschema/1-0-0',
  'iglu:com.snowplowanalytics.snowplow/application/jsonschema/1-0-0',
  // Resolved by Micro from the plugin's own schema directory; see micro.ts.
  'iglu:to.flip/ft_page_engagement/jsonschema/1-0-0',
  // Stands in for the to.flip entities Platform attaches; see README.
  'iglu:com.snowplowanalytics.snowplow/mobile_context/jsonschema/1-0-1',
  // http_client_hints is absent on purpose: navigator.userAgentData needs a secure context and the
  // suite serves plain http on a hostname.
];

interface Golden {
  schemas: string[];
  stable: string[];
  noisePaths: string[];
}

describe('lite bundle event surface', () => {
  let firstEvents: Array<any>;
  let runA: Set<string>;
  let runB: Set<string>;
  let schemas: string[];
  let firstCount: number;
  let secondCount: number;

  let peWindow: { enabledAt: number; pageChangedAt: number; hiddenAt: number };

  const loadFixture = async () => {
    await browser.url('/lite-surface.html');
    await browser.waitUntil(async () => !!(await browser.execute(() => (window as any).pageEngagementWindow)), {
      timeout: 15000,
      timeoutMsg: 'the surface page did not enable page engagement within 15s',
      interval: 50,
    });
    // Trusted input: the page engagement counters ignore script-dispatched events.
    await $('#title').click();
    await browser.keys('a');
    await browser.waitUntil(async () => (await $('#done').getText()) === 'true', {
      timeout: 15000,
      timeoutMsg: 'the surface page did not finish driving its plugins within 15s',
      interval: 250,
    });
    // web-vitals reports on the first hidden transition, and the page ping needs its heartbeat.
    await browser.pause(2000);
  };

  const eventIds = async () => {
    const log = (await browser.call(async () => await fetchResults())) as Array<any>;
    return new Set(log.map((e) => e?.event?.event_id));
  };

  /** By id, not by position: Micro accumulates across every spec in this worker and returns newest first. */
  const collectSince = async (before: Set<unknown>) => {
    const log = (await browser.call(async () => await fetchResults())) as Array<any>;
    return log.filter((e) => !before.has(e?.event?.event_id));
  };

  beforeAll(async () => {
    await pageSetup();

    const beforeFirst = await eventIds();
    await loadFixture();
    const first = await collectSince(beforeFirst);
    peWindow = (await browser.execute(() => (window as any).pageEngagementWindow)) as any;

    const beforeSecond = await eventIds();
    await loadFixture();
    const second = await collectSince(beforeSecond);

    firstEvents = first;
    firstCount = first.length;
    secondCount = second.length;

    runA = surfaceLines(first);
    runB = surfaceLines(second);
    schemas = schemaSurface(first);

    const noise = noiseFloor(runA, runB);
    const recorded: Golden = {
      schemas,
      stable: stableLines(runA, noise),
      noisePaths: Array.from(noise).sort(),
    };
    fs.writeFileSync(RECORDED, JSON.stringify(recorded, null, 1));
    console.log(
      `Measured surface: ${recorded.schemas.length} schemas, ${recorded.stable.length} stable fields, ` +
        `${recorded.noisePaths.length} paths this build varies by on its own. Written to golden.recorded.json.`
    );
  });

  /**
   * In its own case rather than in beforeAll, where a failing expectation does not fail the run.
   * It matters most when the surface is about to be re-recorded: a second load short of an event
   * makes that event's fields look like noise, and they are then never compared again.
   */
  it('collects the same events from both loads', () => {
    expect(firstCount).toBeGreaterThan(0);
    expect(secondCount).toEqual(firstCount);
  });

  it('drives every plugin the comparison is supposed to cover', () => {
    const missing = REQUIRED_SCHEMAS.filter((schema) => schemas.indexOf(schema) === -1);
    expect(missing).toEqual([]);
  });

  /**
   * The engagement totals are volatile (normalize.ts), so they are bounded here instead. The
   * fixture enables the plugin 1 s after load, tracks an SPA page view at 2.5 s and hides at 4 s,
   * and records each moment; each report must match its own window, so a clock that stopped,
   * counted from page start (a second over), or reported the time inside trackPageView fails.
   * WebDriver clicks and presses a key once on the first page, which also scrolls from 10 px to
   * 400 px. Exactly two reports: nothing before the first page view, one per page after.
   */
  it('reports page engagement per page view, on the page change and on hide', () => {
    const entityOf = (e: any) =>
      (e?.event?.contexts?.data ?? []).find((c: any) => c.schema === 'iglu:to.flip/ft_page_engagement/jsonschema/1-0-0')
        ?.data;
    const reports = firstEvents
      .filter((e) => e?.event?.event_name === 'application_background')
      .map(entityOf)
      .sort((a: any, b: any) => (a.reason < b.reason ? 1 : -1));
    expect(reports.map((d: any) => d.reason)).toEqual(['page_change', 'hide']);
    const [change, hide] = reports;
    const firstPage = peWindow.pageChangedAt - peWindow.enabledAt;
    const secondPage = peWindow.hiddenAt - peWindow.pageChangedAt;
    expect(firstPage).toBeGreaterThan(1000);
    expect(secondPage).toBeGreaterThan(1000);

    expect(change.total_engagement_time_msec).toBeGreaterThan(firstPage - 250);
    expect(change.total_engagement_time_msec).toBeLessThan(firstPage + 50);
    expect(change.total_clicks).toBe(1);
    expect(change.total_key_presses).toBe(1);
    expect(change.total_touches).toBe(0);
    expect(change.max_scroll_y_px).toBe(400);
    // 10 px to 400 px, plus up to 10 px if the WebDriver click scrolled the title back into view.
    expect(change.total_scroll_distance_px).toBeGreaterThanOrEqual(390);
    expect(change.total_scroll_distance_px).toBeLessThanOrEqual(410);

    expect(hide.total_engagement_time_msec).toBeGreaterThan(secondPage - 250);
    expect(hide.total_engagement_time_msec).toBeLessThan(secondPage + 50);
    expect(hide.total_clicks).toBe(0);
    expect(hide.page_view_id).not.toBe(change.page_view_id);
  });

  const readGolden = (): Golden => {
    if (!fs.existsSync(GOLDEN)) {
      throw new Error(`No golden at ${GOLDEN}. Copy golden.recorded.json over it and commit the diff.`);
    }
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf-8'));
  };

  it('emits the schema set recorded in the golden', () => {
    expect(schemas).toEqual(readGolden().schemas);
  });

  /**
   * The union below drops a path from both sides, which is right for one that was noisy at
   * recording time, and silent for one that was stable then and varies now. The golden asserts
   * domain_sessionidx=1 and sessionIndex=1 on every event: a change that made the second load open
   * a new session would move those into measured noise and pass. That is the behaviour this fork
   * patches, so it fails here instead.
   */
  it('keeps varying the fields the golden calls stable', () => {
    const golden = readGolden();
    const newlyNoisy = Array.from(noiseFloor(runA, runB)).filter((p) => golden.noisePaths.indexOf(p) === -1);
    expect(newlyNoisy).toEqual([]);
  });

  it('fills the fields recorded in the golden, outside what one build varies by', () => {
    const golden = readGolden();
    const measured = noiseFloor(runA, runB);

    // Either side's noise disqualifies a path. A path that was noisy when the golden was recorded
    // but whose two loads happen to agree today would otherwise appear as an extra field, and the
    // navigation timings Chrome rounds to 0.1 ms can do exactly that. The case above is what keeps
    // this from hiding the opposite direction.
    const noise = new Set(golden.noisePaths.concat(Array.from(measured)));

    const stable = stableLines(runA, noise);
    const expected = comparable(golden.stable.filter((l) => !noise.has(pathOf(l))));

    expect(stable).toEqual(expected);
  });
});
