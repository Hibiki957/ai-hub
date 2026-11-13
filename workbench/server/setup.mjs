import { setup } from '../deploy/setup.mjs';
import { resolve } from 'node:path';
const root = process.argv[2];
if (!root) {
  console.error('Usage: npm run setup -- /absolute/private/aihub');
  process.exitCode = 1;
} else {
  const paths = await setup(resolve(root));
  console.log(JSON.stringify(paths, null, 2));
}
