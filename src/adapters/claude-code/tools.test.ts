import { describe, expect, it } from 'vitest';

import { categoryOf, describeTool, inputText, toolPreview } from './tools.js';

// Expected previews and input texts are the prototype's (session-trace/trace.mjs toolPreview and
// inputText) for the same inputs.

const cwd = '/home/dev/shop';

describe('categoryOf', () => {
  it.each([
    ['Bash', 'shell'],
    ['Read', 'file'],
    ['Write', 'file'],
    ['Edit', 'file'],
    ['NotebookEdit', 'file'],
    ['Grep', 'search'],
    ['Glob', 'search'],
    ['WebFetch', 'web'],
    ['Agent', 'agent'],
    ['Task', 'agent'],
    ['Workflow', 'workflow'],
    ['Skill', 'skill'],
    ['AskUserQuestion', 'question'],
    ['TaskStop', 'task-control'],
    ['mcp__shop-db__query', 'other'],
    ['ToolSearch', 'other'],
    ['constructor', 'other'],
  ])('%s is %s', (name, category) => {
    expect(categoryOf(name)).toBe(category);
  });
});

describe('toolPreview', () => {
  it.each([
    ['Bash', { command: 'cd /home/dev/shop && pnpm test', description: 'Run the tests' }, 'Run the tests · pnpm test'],
    ['Bash', { command: 'pnpm dev', run_in_background: true }, 'pnpm dev  [background]'],
    ['Bash', { command: 'x'.repeat(80) }, `${'x'.repeat(69)}…`],
    ['Bash', {}, ''],
    ['Read', { file_path: '/home/dev/shop/src/a.ts' }, 'src/a.ts'],
    ['Read', { file_path: '/home/dev/shopping/a.ts' }, '/home/dev/shopping/a.ts'],
    ['Read', { file_path: '/etc/hosts' }, '/etc/hosts'],
    ['NotebookEdit', { notebook_path: '/home/dev/shop/nb.ipynb' }, 'nb.ipynb'],
    ['Write', {}, ''],
    ['Agent', { description: 'Review', subagent_type: 'Explore' }, 'Review (Explore)'],
    ['Task', { description: 'Review' }, 'Review'],
    ['Workflow', { name: 'add-tests', args: {} }, 'add-tests'],
    ['Workflow', { script: "export default { name: 'nightly', run() {} }" }, 'nightly'],
    ['Workflow', { scriptPath: '/home/dev/shop/wf.ts' }, 'inline script'],
    ['Skill', { skill: 'testing' }, 'testing'],
    ['WebFetch', { url: 'https://vitest.dev/', prompt: 'x' }, 'https://vitest.dev/'],
    ['Grep', { pattern: 'cartCount', path: '/home/dev/shop' }, 'cartCount'],
    ['Glob', { pattern: 'src/**/*.ts' }, 'src/**/*.ts'],
    ['AskUserQuestion', { questions: [{ question: 'Hide the  badge\nwhen empty?' }] }, 'Hide the badge when empty?'],
    ['AskUserQuestion', {}, ''],
    ['TaskStop', { task_id: 'bk1' }, '{"task_id":"bk1"}'],
    ['mcp__shop-db__query', { sql: 'select 1' }, '{"sql":"select 1"}'],
  ])('%s %j is %j', (name, input, preview) => {
    expect(toolPreview(name, input, cwd)).toBe(preview);
  });

  it('keys a described shell call’s command with the subcommands of the tools the options add', () => {
    const input = { command: 'cd infra && kubectl get pods', description: 'List the pods' };
    expect(toolPreview('Bash', input, cwd)).toBe('List the pods · kubectl');
    expect(toolPreview('Bash', input, cwd, { subcommandTools: ['kubectl'] })).toBe('List the pods · kubectl get');
    expect(describeTool('Bash', input, cwd, { subcommandTools: ['kubectl'] })).toMatchObject({
      preview: 'List the pods · kubectl get',
      shellCommand: 'cd infra && kubectl get pods',
    });
  });

  it('keeps paths absolute without a working directory', () => {
    expect(toolPreview('Read', { file_path: '/home/dev/shop/src/a.ts' }, undefined)).toBe('/home/dev/shop/src/a.ts');
  });
});

describe('inputText', () => {
  it('is the command of a shell call', () => {
    expect(inputText('Bash', { command: 'pnpm test', description: 'x' })).toBe('pnpm test');
    expect(inputText('Bash', {})).toBe('');
  });

  it('is the path and content of a write, and the path, old, and new text of an edit', () => {
    expect(inputText('Write', { file_path: '/a.ts', content: 'x' })).toBe('/a.ts\n\nx');
    expect(inputText('Write', {})).toBe('undefined\n\n');
    expect(inputText('Edit', { file_path: '/a.ts', old_string: 'a', new_string: 'b' })).toBe(
      '/a.ts\n\n--- old\na\n+++ new\nb',
    );
  });

  it('is pretty JSON otherwise', () => {
    expect(inputText('Read', { file_path: '/a.ts' })).toBe('{\n  "file_path": "/a.ts"\n}');
  });
});

describe('describeTool', () => {
  it('describes a shell call by its command, in the background or not', () => {
    expect(describeTool('Bash', { command: 'pnpm dev', description: 'Dev', run_in_background: true }, cwd)).toEqual({
      category: 'shell',
      preview: 'Dev · pnpm dev  [background]',
      inputText: 'pnpm dev',
      purpose: 'Dev',
      shellCommand: 'pnpm dev',
      runsInBackground: true,
    });
    expect(describeTool('Bash', { command: 'ls' }, cwd)).toEqual({
      category: 'shell',
      preview: 'ls',
      inputText: 'ls',
      shellCommand: 'ls',
    });
  });

  it('gives a task-control call the ids it stops', () => {
    expect(describeTool('TaskStop', { task_id: 'bk1' }, cwd)).toMatchObject({
      category: 'task-control',
      stops: ['bk1'],
    });
    expect(describeTool('TaskStop', {}, cwd)).toMatchObject({ stops: [] });
  });

  it("keeps any tool's description as its purpose", () => {
    expect(describeTool('Agent', { description: 'Review', prompt: 'p' }, cwd)).toEqual({
      category: 'agent',
      preview: 'Review',
      inputText: '{\n  "description": "Review",\n  "prompt": "p"\n}',
      purpose: 'Review',
    });
  });
});
