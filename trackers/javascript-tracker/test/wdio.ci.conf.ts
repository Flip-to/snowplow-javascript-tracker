import { Options } from '@wdio/types';
import { config as defaultConfig } from './wdio.default.conf';

function getFullPath(p: string): string {
  return process.cwd() + '/' + p;
}

// Runs the suite against a headless Chrome on a CI runner, so the browser tests are not gated on a
// Saucelabs subscription this fork does not have.
//
// No chromedriver service: the package.json pin cannot track the Chrome the runner ships, so
// WebdriverIO's own driver management fetches a matching one at run time.
export const config: Partial<Options.Testrunner> = {
  ...defaultConfig,

  // The event surface golden is recorded on headless Chrome, so the spec that compares against it
  // only runs here. The Sauce config would put it on Firefox and Safari against that recording.
  specs: [(defaultConfig.specs?.[0] as string[]).concat([getFullPath('test/surface/*.test.ts')])],

  capabilities: [
    {
      browserName: 'chrome',
      'goog:chromeOptions': {
        args: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      },
    },
  ],
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
