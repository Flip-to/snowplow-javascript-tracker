import fs from 'fs';
import path from 'path';
import { fetchResults } from '../micro';
import { pageSetup } from '../integration/helpers';
import { comparable, noiseFloor, pathOf, schemaSurface, stableLines, surfaceLines } from './normalize';

/**
 * Holds the shipped bundle to the event surface it produced when the golden was recorded: which
 * schemas it emits, which atomic fields it fills, and what it puts in them.
 *
 * This loads dist/sp.lite.js, the artifact that becomes ftsa2.js, rather than the differently
 * configured bundle the rest of the suite uses. tracker.test.config.ts has webVitals and
 * performanceNavigationTiming off, so a suite built on it cannot see two of the plugins we ship.
 *
 * The page is loaded twice and the difference between those two runs is the noise floor. Only
 * fields that a single build keeps constant are compared against the golden, so the exclusion list
 * is measured rather than chosen.
 */

const GOLDEN = path.join(__dirname, 'golden.json');

/** One per plugin the lite bundle carries that the rest of the suite's bundle does not. */
const REQUIRED_SCHEMAS = [
  'iglu:com.snowplowanalytics.snowplow/web_vitals/jsonschema/1-0-0',
  'iglu:org.w3/PerformanceNavigationTiming/jsonschema/1-0-0',
  'iglu:com.google.analytics/cookies/jsonschema/1-0-0',
  'iglu:com.google.ga4/cookies/jsonschema/1-0-0',
  'iglu:com.google.analytics.enhanced-ecommerce/productFieldObject/jsonschema/1-0-0',
  'iglu:com.snowplowanalytics.snowplow/application/jsonschema/1-0-0',
  // Stands in for the to.flip entities Platform attaches, which no plugin provides and which the
  // rest of the suite never exercises.
  'iglu:com.snowplowanalytics.snowplow/mobile_context/jsonschema/1-0-1',
  // Deliberately absent: http_client_hints. navigator.userAgentData exists only in a secure context
  // and the suite serves over plain http on a hostname, so the plugin cannot fire here. It does fire
  // in production, over https, and is covered by nothing in this repo. See the README.
];

interface Golden {
  schemas: string[];
  stable: string[];
  noisePaths: string[];
}

describe('lite bundle event surface', () => {
  let runA: Set<string>;
  let runB: Set<string>;
  let schemas: string[];

  const loadFixture = async () => {
    await browser.url('/lite-surface.html');
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

  /**
   * Micro accumulates across loads and every spec in this worker, and it returns newest first. By
   * id rather than by position: slicing the array measured other specs' events instead, produced a
   * golden of six schemas rather than twenty-one, and passed.
   */
  const collectSince = async (before: Set<unknown>) => {
    const log = (await browser.call(async () => await fetchResults())) as Array<any>;
    return log.filter((e) => !before.has(e?.event?.event_id));
  };

  beforeAll(async () => {
    await pageSetup();

    const beforeFirst = await eventIds();
    await loadFixture();
    const first = await collectSince(beforeFirst);

    const beforeSecond = await eventIds();
    await loadFixture();
    const second = await collectSince(beforeSecond);

    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toEqual(first.length);

    runA = surfaceLines(first);
    runB = surfaceLines(second);
    schemas = schemaSurface(first);
  });

  /**
   * A floor, so measuring the wrong events cannot quietly record a smaller golden. Each entry comes
   * from a plugin only the lite bundle carries, or stands in for the entities Platform attaches, so
   * its absence means the fixture did not drive what this test exists to measure.
   *
   * In its own case rather than in beforeAll: an expectation that failed there did not fail the run,
   * and a golden recorded without http_client_hints passed while this list demanded it.
   */
  it('drives every plugin the comparison is supposed to cover', () => {
    const missing = REQUIRED_SCHEMAS.filter((schema) => schemas.indexOf(schema) === -1);
    expect(missing).toEqual([]);
  });

  /**
   * The golden carries fields that depend on the machine, so it has to be recorded on the runner
   * rather than on a laptop. Set SURFACE_WRITE_GOLDEN to record one; the file is then committed.
   * Without the flag a missing golden fails rather than quietly passing.
   */
  const readGolden = (): Golden => {
    if (!fs.existsSync(GOLDEN)) {
      if (!process.env.SURFACE_WRITE_GOLDEN) {
        throw new Error(`No golden at ${GOLDEN}. Record one with SURFACE_WRITE_GOLDEN=1 and commit it.`);
      }
      const noise = noiseFloor(runA, runB);
      const golden: Golden = {
        schemas,
        stable: stableLines(runA, noise),
        noisePaths: Array.from(noise).sort(),
      };
      fs.writeFileSync(GOLDEN, JSON.stringify(golden, null, 1));
      console.log(
        `Recorded golden: ${golden.schemas.length} schemas, ${golden.stable.length} stable fields, ` +
          `${golden.noisePaths.length} paths this build varies by on its own.`
      );
    }
    return JSON.parse(fs.readFileSync(GOLDEN, 'utf-8'));
  };

  it('emits the schema set recorded in the golden', () => {
    expect(schemas).toEqual(readGolden().schemas);
  });

  it('fills the fields recorded in the golden, outside what one build varies by', () => {
    const golden = readGolden();
    const noise = noiseFloor(runA, runB);

    // A path the golden treats as stable but that now varies on its own would otherwise be read
    // as a regression. Say so plainly instead.
    const newlyNoisy = Array.from(noise).filter((p) => !golden.noisePaths.includes(p));
    expect(newlyNoisy).toEqual([]);

    const stable = stableLines(runA, noise);
    // The golden may predate the environment rule, so normalise it the same way before comparing.
    const expected = comparable(golden.stable.filter((l) => !noise.has(pathOf(l))));

    expect(stable).toEqual(expected);
  });
});
