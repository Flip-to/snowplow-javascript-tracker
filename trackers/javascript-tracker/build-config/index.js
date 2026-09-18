import replace from '@rollup/plugin-replace';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

const SNOWPLOW_HEX = '#9f62dd';
const snowplowLogMessage = (message) => console.log(chalk.hex(SNOWPLOW_HEX).bold(message));

const TAG_SOURCE_DIR = './tags';
const TAG_OUTPUT_DIR = './dist';
const TAG_FILES = ['tag.js', 'tag.min.js'];

export function whitelabelBuild(cmdlineArgs, plugins) {
  const whitelabelNamespace = cmdlineArgs.whitelabel;
  const defaultNamespace = 'GlobalSnowplowNamespace';

  // Prevent unrecognized option warning on whitelabel
  delete cmdlineArgs.whitelabel;
  plugins.unshift(replace({ [defaultNamespace]: whitelabelNamespace, preventAssignment: true, delimiters: ['', ''] }), {
    name: 'rollup-plugin-fix-whitelabel-tag',
    writeBundle(options) {
      TAG_FILES.forEach((tagFile) =>
        writeWhitelabelTag(
          path.join(TAG_SOURCE_DIR, tagFile),
          path.join(TAG_OUTPUT_DIR, tagFile),
          defaultNamespace,
          whitelabelNamespace
        )
      );
      snowplowLogMessage(
        `Snowplow whitelabel build created at ${options.file}. You can find the whitelabel loader under ${TAG_OUTPUT_DIR}/tag{.min}.js`
      );
    },
  });
}

// Reads the pristine loader and writes the whitelabelled copy elsewhere, so the sources under
// ./tags are never modified. Rewriting them in place was not idempotent: a whitelabel namespace
// containing the default one gained a prefix on every build.
function writeWhitelabelTag(sourcePath, outputPath, oldNamespace, whitelabelNamespace) {
  const content = fs.readFileSync(path.resolve(sourcePath), { encoding: 'utf-8' });
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  fs.writeFileSync(resolvedOutput, content.replace(new RegExp(oldNamespace, 'g'), whitelabelNamespace));
}
