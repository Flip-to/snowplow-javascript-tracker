import { BrowserPlugin } from '@snowplow/browser-tracker-core';
import { LOG } from '@snowplow/tracker-core';
import { detectInstantClientAsync } from 'bot-signal/browser';
import { CLIENT_SIDE_BOT_DETECTION_SCHEMA, CLIENT_SIDE_BOT_SIGNAL_PILOT_SCHEMA } from './schemata';
import { BotDetectionContextData, BotKind, BotSignalPilotContextData } from './types';

export { BotDetectionContextData, BotKind, BotSignalPilotContextData } from './types';

export interface BotSignalPluginOptions {
  /**
   * 'standard' (default): the Snowplow `client_side_bot_detection` 1-0-0 entity (`bot`, `kind`), no new schema.
   * 'pilot': a custom entity that also carries the score and fired signal ids. Needs its schema
   * (`schema/client_side_bot_signal_pilot.json`) registered in Iglu before use, or events fail validation.
   */
  mode?: 'standard' | 'pilot';
}

type Detection = Awaited<ReturnType<typeof detectInstantClientAsync>>;
type Entity = { schema: string; data: Record<string, unknown> };

// Limits of the pilot schema (maxLength / maxItems), applied here so a long id never makes a bad row.
const MAX_LEN = 64;
const MAX_SIGNALS = 64;

// bot-signal automation kinds that exist in the standard schema's `kind` enum. Everything else
// (browser-automation, playwright, puppeteer, lightpanda, curl, python, ...) is reported as 'unknown',
// because that schema is closed (enum + additionalProperties: false).
function toSchemaKind(raw: string | null): BotKind {
  switch (raw) {
    case 'selenium':
      return 'selenium';
    case 'phantomjs':
      return 'phantomjs';
    case 'nightmare':
      return 'nightmarejs';
    default:
      return 'unknown';
  }
}

function clip(s: string): string {
  return s.length > MAX_LEN ? s.slice(0, MAX_LEN) : s;
}

function standardEntity(r: Detection, rawKind: string | null): Entity {
  const data: BotDetectionContextData = r.isLegitClient
    ? { bot: false, kind: null }
    : { bot: true, kind: toSchemaKind(rawKind) };
  return { schema: CLIENT_SIDE_BOT_DETECTION_SCHEMA, data };
}

function pilotEntity(r: Detection, rawKind: string | null): Entity | undefined {
  if (typeof r.suspicionScore !== 'number' || !isFinite(r.suspicionScore)) {
    LOG.error('BotSignalPlugin: ignoring a non-finite suspicion score');
    return undefined;
  }
  const data: BotSignalPilotContextData = {
    bot: !r.isLegitClient,
    score: r.suspicionScore,
    // null for a client judged legitimate; 'unknown' for a bot with no kind.
    kind: r.isLegitClient ? null : rawKind ? clip(rawKind) : 'unknown',
    signals: (r.signals || [])
      .filter((s) => s.triggered)
      .slice(0, MAX_SIGNALS)
      .map((s) => clip(String(s.id))),
  };
  return { schema: CLIENT_SIDE_BOT_SIGNAL_PILOT_SCHEMA, data };
}

// One detection per page, shared by every plugin instance; each instance builds its own entity from it.
let detection: Promise<Detection> | undefined;

/**
 * Runs bot-signal's instant (non-behavioral) checks once per page and attaches the result to every event
 * after it resolves. Events fired before then carry no context. The checks read browser characteristics
 * (webdriver flag, automation globals, viewport, permissions, voice list) and make no network or storage
 * calls: activate the plugin only after consent where the site requires it.
 */
export function BotSignalPlugin(options: BotSignalPluginOptions = {}): BrowserPlugin {
  const pilot = options.mode === 'pilot';
  let context: Entity | undefined;
  return {
    activateBrowserPlugin: () => {
      if (!detection) {
        detection = detectInstantClientAsync(window as unknown as Parameters<typeof detectInstantClientAsync>[0]);
      }
      detection
        .then((r) => {
          const rawKind = r.automation && r.automation.kind ? String(r.automation.kind) : null;
          context = pilot ? pilotEntity(r, rawKind) : standardEntity(r, rawKind);
        })
        .catch((err) => LOG.error('BotSignalPlugin: detection failed', err));
    },
    contexts: () => (context ? [context] : []),
  };
}
