import { describe, expect, it } from 'vitest';

import { DATA_PLACEHOLDER, renderHtml, viewerTemplate } from './render.js';
import type { IndexData } from './types.js';

const template = `<p>before $&</p><script id="trace-data" type="application/json">${DATA_PLACEHOLDER}</script><p>after</p>`;

const index = (projectDir: string): IndexData => ({ index: { projectDir, agent: 'Agent', sessions: [] } });

describe('renderHtml', () => {
  it('puts the data’s JSON in place of the placeholder', () => {
    const html = renderHtml(index('/home/dev'), template);
    expect(html).toBe(
      '<p>before $&</p><script id="trace-data" type="application/json">{"index":{"projectDir":"/home/dev","agent":"Agent","sessions":[]}}</script><p>after</p>',
    );
  });

  it('escapes every < so the data cannot end the script, and keeps $ sequences as they are', () => {
    const html = renderHtml(index('</script><script>alert(1)</script> $& $1 $$'), template);
    expect(html).not.toContain('</script><script>alert');
    expect(html).toContain('"\\u003c/script>\\u003cscript>alert(1)\\u003c/script> $& $1 $$"');
    const json = /application\/json">(.*)<\/script><p>after/.exec(html)?.[1] ?? '';
    expect(JSON.parse(json)).toEqual(index('</script><script>alert(1)</script> $& $1 $$'));
  });

  it('refuses a template without the placeholder', () => {
    expect(() => renderHtml(index('/'), '<html></html>')).toThrow('the viewer has no "__TRACE_DATA__" placeholder');
  });
});

describe('viewerTemplate', () => {
  it('says to build when the viewer is not built beside the code', () => {
    // From src/, the built viewer would be src/viewer/viewer.html, which only dist/ has.
    expect(() => viewerTemplate()).toThrow(/^the viewer is not built: no .*viewer\.html; run pnpm build$/);
  });
});
