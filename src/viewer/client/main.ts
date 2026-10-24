// The viewer's browser client, bundled by scripts/build.ts into dist/viewer/viewer.html: it reads
// the data the page embeds and shows a store's index of sessions, every project of a root, one
// session's timeline, or one session's conversation.

import { App } from './app.js';
import { readColors } from './colors.js';
import { ConversationPage } from './conversation.js';
import { isConversationData, isIndexData, isProjectsData, readPageData } from './data.js';
import { renderIndex } from './indexPage.js';
import { renderProjects } from './projectsPage.js';

const data = readPageData();
if (isIndexData(data)) {
  readColors();
  renderIndex(data);
} else if (isProjectsData(data)) {
  renderProjects(data);
} else if (isConversationData(data)) {
  new ConversationPage(data).start();
} else {
  new App(data).start();
}
