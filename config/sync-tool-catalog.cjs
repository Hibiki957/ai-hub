#!/usr/bin/env node
// Materialize build/legacy compatibility files; edit tool-catalog.json only.
const fs = require('node:fs');
const path = require('node:path');
const { loadTools } = require('./catalog-tools.cjs');
const root = path.dirname(__dirname);
const source = fs.readFileSync(path.join(__dirname, 'tool-catalog.json'), 'utf8');
const { defaultPATH, ...projection } = loadTools();
const outputs = [
  [path.join(__dirname, 'tools.json'), JSON.stringify(projection, null, 2) + '\n'],
  [path.join(root, 'native-app/Sources/AIHub/Resources/ToolCatalog.json'), source],
  [path.join(root, 'native-app/Sources/AIHub/Resources/Integrations.json'), fs.readFileSync(path.join(__dirname, 'integrations.json'), 'utf8')],
];
for (const [target, content] of outputs) {
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) throw new Error(`Stale generated catalog: ${target}`);
  } else if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {
    const pending = `${target}.pending-${process.pid}`;
    fs.writeFileSync(pending, content);
    fs.renameSync(pending, target);
  }
}
console.log(process.argv.includes('--check') ? 'Shared catalog projections match.' : 'Shared catalog projections synchronized.');
