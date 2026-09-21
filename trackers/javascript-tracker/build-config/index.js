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

  // Once per build, not inside writeBundle: rollup.config shares this plugins array across the
  // sp.js and sp.lite.js configs, so a hook here runs twice per build.
  TAG_FILES.forEach((tagFile) =>
    writeWhitelabelTag(
      path.join(TAG_SOURCE_DIR, tagFile),
      path.join(TAG_OUTPUT_DIR, tagFile),
      defaultNamespace,
      whitelabelNamespace
    )
  );

  plugins.unshift(replace({ [defaultNamespace]: whitelabelNamespace, preventAssignment: true, delimiters: ['', ''] }), {
    name: 'rollup-plugin-fix-whitelabel-tag',
    writeBundle(options) {
      snowplowLogMessage(
        `Snowplow whitelabel build created at ${options.file}. You can find the whitelabel loader under ${TAG_OUTPUT_DIR}/tag{.min}.js`
      );
    },
  });
}

// Reads the pristine loader and writes the whitelabelled copy elsewhere, so the sources under
// ./tags are never modified. Rewriting them in place was not idempotent: a whitelabel namespace
// containing the default one gained a prefix on every write.
function writeWhitelabelTag(sourcePath, outputPath, oldNamespace, whitelabelNamespace) {
  const content = fs.readFileSync(path.resolve(sourcePath), { encoding: 'utf-8' });
  const resolvedOutput = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  // A replacer function, not a string: $&, $`, $' and $$ are special in a replacement and $ is a
  // legal identifier character, so --whitelabel='ft$&Ns' would otherwise expand.
  fs.writeFileSync(resolvedOutput, content.replace(new RegExp(oldNamespace, 'g'), () => whitelabelNamespace));
}
