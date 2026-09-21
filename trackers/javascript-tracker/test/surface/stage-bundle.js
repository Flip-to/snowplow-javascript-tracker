/*
 * Copies the built lite bundle next to the surface fixture, which loads ./sp.lite.js, and logs what
 * it copied so a failing comparison names the artifact it measured.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const source = path.resolve(__dirname, '..', '..', 'dist', 'sp.lite.js');
const target = path.resolve(__dirname, '..', 'pages', 'sp.lite.js');

fs.copyFileSync(source, target);

const bytes = fs.readFileSync(source);
const sha = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
console.log(`surface bundle: ${bytes.length} bytes, sha256 ${sha}, built ${fs.statSync(source).mtime.toISOString()}`);
