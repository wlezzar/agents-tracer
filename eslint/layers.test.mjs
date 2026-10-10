import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { afterAll, describe, it } from 'vitest';

import { layersRule } from './layers.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const srcDir = '/repo/src';
const options = [
  {
    srcDir,
    layers: {
      model: { imports: [], node: false },
      util: { imports: [], node: ['node:path'] },
      adapters: { imports: ['model', 'adapters/*'], node: false },
      'adapters/*': { imports: ['model', 'util'], node: true },
      report: { imports: ['model', 'util'], node: false },
      view: { imports: ['model'], node: true },
      'viewer/client': { imports: [{ layer: 'view', typeOnly: true }], node: false },
      cli: { imports: '*', node: true },
    },
  },
];
const at = (path, code) => ({ filename: `${srcDir}/${path}`, code, options });
const fails = (path, code, messageId) => ({ ...at(path, code), errors: [{ messageId }] });

new RuleTester({ languageOptions: { parser: tseslint.parser } }).run('layers', layersRule, {
  valid: [
    at('report/summary.ts', "import { fmt } from '../util/index.js';"),
    at('report/summary.ts', "import type { Session } from '../model/index.js';"),
    at('report/summary.ts', "import { table } from './table.js';"),
    at('util/shell.ts', "import { basename } from 'node:path';"),
    at('adapters/claude-code/load.ts', "import { readFileSync } from 'node:fs';"),
    at('adapters/claude-code/load.ts', "import { parse } from './parse/records.js';"),
    at('adapters/claude-code/parse/records.ts', "import { shellKey } from '../../../util/index.js';"),
    at('adapters/registry.ts', "import { claudeCode } from './claude-code/index.js';"),
    at('viewer/client/main.ts', "import type { ViewData } from '../../view/types.js';"),
    at('viewer/client/main.ts', "import { ticks } from './time.js';"),
    at('cli/main.ts', "import { createRegistry } from '../adapters/registry.js';"),
    at('cli/main.ts', "export { main } from './run.js';"),
    at('report/summary.ts', 'const m = await import(`./table.js`);'),
  ],
  invalid: [
    fails('model/events.ts', "import { fmt } from '../util/index.js';", 'layer'),
    fails('model/events.ts', "import { readFileSync } from 'node:fs';", 'node'),
    fails('util/shell.ts', "import { readFileSync } from 'node:fs';", 'node'),
    fails('util/shell.ts', "import { basename } from 'path';", 'nodePrefix'),
    fails('report/summary.ts', "import { load } from '../adapters/claude-code/load.js';", 'layer'),
    fails('report/summary.ts', "export { main } from '../cli/main.js';", 'layer'),
    fails('report/summary.ts', "export * from '../view/build.js';", 'layer'),
    fails('report/summary.ts', "const m = await import('../cli/main.js');", 'layer'),
    fails('report/summary.ts', 'const m = await import(`../cli/main.js`);', 'layer'),
    fails('report/summary.ts', 'const m = await import(name);', 'dynamic'),
    fails('report/summary.ts', 'const m = await import(`../${layer}/main.js`);', 'dynamic'),
    fails('report/summary.ts', "type M = typeof import('../cli/main.js');", 'layer'),
    fails('report/summary.ts', "import chalk from 'chalk';", 'dependency'),
    fails('report/summary.ts', "import pkg from '../../package.json';", 'outside'),
    fails('adapters/claude-code/load.ts', "import { load } from '../other/load.js';", 'layer'),
    fails('adapters/claude-code/load.ts', "import { registry } from '../registry.js';", 'layer'),
    fails('viewer/client/main.ts', "import { buildView } from '../../view/build.js';", 'typeOnly'),
    fails('viewer/client/main.ts', "import { type ViewData } from '../../view/types.js';", 'typeOnly'),
    fails('viewer/client/main.ts', "import { fmt } from '../../util/index.js';", 'layer'),
    fails('main.ts', 'export const x = 1;', 'noLayer'),
  ],
});
