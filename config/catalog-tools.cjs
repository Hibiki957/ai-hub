// Legacy web projection of the same base inventory used by the native app.
// No tool execution, credential reads or personal preference writes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadTools(catalogPath = path.join(__dirname, 'tool-catalog.json')) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (catalog.schemaVersion !== 1 || !['cli', 'apps', 'web', 'pathEntries'].every(key => Array.isArray(catalog[key]))) {
    throw new Error('Invalid shared tool catalog');
  }
  const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
  const basePaths = catalog.pathEntries.map(expand);
  return {
    cli: catalog.cli.map(entry => ({
      id: entry.name, name: entry.title, cmd: expand(entry.command),
      ...((entry.pathPrepend || []).length ? { environment: { PATH: [...new Set([...entry.pathPrepend.map(expand), ...basePaths])].join(path.delimiter) } } : {}),
    })),
    apps: catalog.apps.map(entry => ({ id: entry.id, name: entry.name, path: expand(entry.path) })),
    web: catalog.web,
    defaultPATH: basePaths.join(path.delimiter),
  };
}
module.exports = { loadTools };
