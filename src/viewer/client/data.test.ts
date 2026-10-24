import { describe, expect, it } from 'vitest';

import { viewLane } from '../../../test/support/view-data.js';
import { isIndexData, isProjectsData, isViewData } from './data.js';

describe('the page data', () => {
  const view = {
    session: { id: 's1', title: null, cwd: null, file: '/x' },
    groups: [{ id: 'main', label: 'Session' }],
    lanes: [viewLane('main')],
    generated: 1,
    toolCategories: {},
    shellLabel: 'Shell',
  };

  it('is a session’s view, an index, or the projects', () => {
    expect(isViewData(view)).toBe(true);
    expect(isIndexData({ index: { projectDir: '/s', agent: 'Agent', sessions: [] } })).toBe(true);
    expect(isIndexData(view)).toBe(false);
    expect(isProjectsData({ root: { dir: '/r', agent: 'Agent', projects: [] } })).toBe(true);
    expect(isProjectsData(view)).toBe(false);
  });

  it('is neither when its shape is wrong', () => {
    for (const bad of [
      null,
      [],
      'x',
      { ...view, lanes: [] },
      { ...view, lanes: [{ id: 'main' }] },
      { ...view, shellLabel: 1 },
    ])
      expect(isViewData(bad)).toBe(false);
    for (const bad of [{ index: null }, { index: { projectDir: '/s', sessions: [] } }])
      expect(isIndexData(bad)).toBe(false);
    for (const bad of [
      { root: '/r' },
      { root: { dir: '/r', agent: 'Agent', projects: {} } },
      { root: { agent: 'A', projects: [] } },
    ])
      expect(isProjectsData(bad)).toBe(false);
  });
});
