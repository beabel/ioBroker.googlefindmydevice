'use strict';

// Cross-platform copy of the .proto files next to the esbuild bundle, so
// pkg can embed them as assets and google-checkin.js's
// path.join(__dirname, 'proto', ...) still resolves correctly at runtime
// (esbuild keeps __dirname pointing at the bundle's own output directory).

const fs = require('node:fs');
const path = require('node:path');

const srcDir = path.join(__dirname, '..', 'node_modules', 'iobroker.googlefindmydevice', 'lib', 'proto');
const destDir = path.join(__dirname, '..', 'dist', 'proto');

fs.mkdirSync(destDir, { recursive: true });
for (const file of fs.readdirSync(srcDir)) {
  if (file.endsWith('.proto')) {
    fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  }
}

console.log(`Copied .proto files to ${destDir}`);
