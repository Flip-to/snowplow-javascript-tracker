/*
 * Copies the built lite bundle next to the surface fixture, which loads ./sp.lite.js.
 *
 * It fails rather than leaving whatever was there before. A build that fails part way through
 * still prints a SUCCESS line for the operations that did pass, and the stale artifact from an
 * earlier branch then gets measured as if it were the new one. That happened three times while
 * this comparison was being built.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, '..', '..', 'dist', 'sp.lite.js');
const target = path.resolve(__dirname, '..', 'pages', 'sp.lite.js');

if (!fs.existsSync(source)) {
  console.error(`No bundle at ${source}. Run the package build before the surface test.`);
  process.exit(1);
}

const bytes = fs.readFileSync(source);
fs.writeFileSync(target, bytes);

const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
console.log(`surface bundle: ${bytes.length} bytes, sha256 ${sha}, built ${fs.statSync(source).mtime.toISOString()}`);
