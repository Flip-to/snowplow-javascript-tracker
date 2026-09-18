import { Options } from '@wdio/types';
import { config as defaultConfig } from './wdio.default.conf';

// Runs the same suite as wdio.local.conf against a headless Chrome on a CI runner, so the browser
// tests are not gated on a Saucelabs subscription this fork does not have.
//
// No chromedriver service: the package.json pin cannot track the Chrome the runner ships, so
// WebdriverIO's own driver management is left to fetch a matching one at run time.
export const config: Partial<Options.Testrunner> = {
  ...defaultConfig,

  maxInstances: 2,
  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    },
  ],
  specFileRetries: 1,
  logLevel: 'warn',
  services: [
    [
      'static-server',
      {
        folders: [{ mount: '/', path: './test/pages' }],
        port: 8080,
      },
    ],
    'shared-store',
  ],
};
