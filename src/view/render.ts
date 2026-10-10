import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { isRecord } from '../util/index.js';
import type { PageData } from './types.js';

// The viewer's page with its data: the built viewer (dist/viewer/viewer.html, which scripts/build.ts
// writes from src/viewer/) with the data's JSON in place of its placeholder.

/** What the data replaces in the viewer: the content of its `<script id="trace-data">`. */
export const DATA_PLACEHOLDER = '"__TRACE_DATA__"';

/** Where the built viewer is, beside the built view module: dist/viewer/viewer.html. */
const VIEWER = new URL('../viewer/viewer.html', import.meta.url);

/** The built viewer's page, with its data placeholder. Throws when the viewer is not built. */
export function viewerTemplate(): string {
  try {
    return readFileSync(VIEWER, 'utf8');
  } catch (err) {
    if (isRecord(err) && err['code'] === 'ENOENT')
      throw new Error(`the viewer is not built: no ${fileURLToPath(VIEWER)}; run pnpm build`, { cause: err });
    throw err;
  }
}

/**
 * The viewer's page for `data`: `template` (the built viewer by default) with the data's JSON in
 * place of the placeholder. Every `<` of the JSON is escaped, so nothing in the data can end the
 * script block, and the JSON is inserted as it is, `$` sequences included.
 */
export function renderHtml(data: PageData, template: string = viewerTemplate()): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  if (!template.includes(DATA_PLACEHOLDER)) throw new Error(`the viewer has no ${DATA_PLACEHOLDER} placeholder`);
  return template.replace(DATA_PLACEHOLDER, () => json);
}
