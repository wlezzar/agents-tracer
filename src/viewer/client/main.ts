// The viewer's browser client, bundled by scripts/build.ts into dist/viewer/viewer.html: it reads
// the data the page embeds and shows either a store's index of sessions or one session.

import { App } from './app.js';
import { readColors } from './colors.js';
import { isIndexData, readPageData } from './data.js';
import { renderIndex } from './indexPage.js';

const data = readPageData();
if (isIndexData(data)) {
  readColors();
  renderIndex(data);
} else {
  new App(data).start();
}
