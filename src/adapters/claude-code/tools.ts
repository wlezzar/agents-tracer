import { relative } from 'node:path';

import type { LoadOptions, ToolCategory, ToolDescription } from '../../model/index.js';
import { isRecord, jsText, looseText, oneLine, shellKey } from '../../util/index.js';

// How Claude Code's tools read to the neutral layers: each tool's category, its one-line preview,
// and its input as a person reads it. Ported from the prototype's toolPreview and inputText; the
// loose reads (`looseText`, truthiness) keep its output for inputs of unexpected types.

/** Claude Code's name for its shell tool, which titles the shell breakdown. */
export const SHELL_TOOL = 'Bash';

const categories: Readonly<Record<string, ToolCategory>> = {
  Bash: 'shell',
  Read: 'file',
  Write: 'file',
  Edit: 'file',
  NotebookEdit: 'file',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'web',
  Agent: 'agent',
  Task: 'agent',
  Workflow: 'workflow',
  Skill: 'skill',
  AskUserQuestion: 'question',
  TaskStop: 'task-control',
};

/** The names of the tools Claude Code describes by category; any other tool is `other`. */
export const TOOL_NAMES: readonly string[] = Object.keys(categories);

/** The category of the tool Claude Code calls `name`; `other` for any tool it does not know. */
export function categoryOf(name: string): ToolCategory {
  return Object.hasOwn(categories, name) ? (categories[name] ?? 'other') : 'other';
}

/**
 * How a call of the tool `name` with `input` reads, in a transcript whose working directory is
 * `cwd`; `options.subcommandTools` shape the shell keys its preview shows.
 */
export function describeTool(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string | undefined,
  options: LoadOptions = {},
): ToolDescription {
  const category = categoryOf(name);
  const description = input['description'];
  return {
    category,
    preview: toolPreview(name, input, cwd, options),
    inputText: inputText(name, input),
    ...(typeof description === 'string' && { purpose: description }),
    ...(category === 'shell' && {
      shellCommand: looseText(input['command']),
      ...(Boolean(input['run_in_background']) && { runsInBackground: true }),
    }),
    ...(category === 'task-control' && { stops: stopsOf(input) }),
    ...fileOf(name, input),
  };
}

/** The file a file tool's call reads or writes. */
function fileOf(name: string, input: Readonly<Record<string, unknown>>): Pick<ToolDescription, 'file'> {
  if (categoryOf(name) !== 'file') return {};
  const path = input['file_path'] ?? input['notebook_path'];
  return typeof path === 'string' && path ? { file: { path, access: name === 'Read' ? 'read' : 'write' } } : {};
}

/** The task ids a `TaskStop` call stops. */
function stopsOf(input: Readonly<Record<string, unknown>>): string[] {
  const id = input['task_id'];
  return typeof id === 'string' ? [id] : [];
}

/** One line that says what the call did; the prototype's toolPreview, with a missing value empty. */
export function toolPreview(
  name: string,
  input: Readonly<Record<string, unknown>>,
  cwd: string | undefined,
  options: LoadOptions = {},
): string {
  switch (name) {
    case 'Bash': {
      const description = input['description'];
      const command = input['command'];
      return (
        (description
          ? `${oneLine(looseText(description), 60)} · ${shellKey(looseText(command), options)}`
          : oneLine(looseText(command), 70)) + (input['run_in_background'] ? '  [background]' : '')
      );
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const path = input['file_path'] ?? input['notebook_path'];
      if (typeof path !== 'string') return looseText(path);
      return path && cwd && path.startsWith(cwd + '/') ? relative(cwd, path) : path;
    }
    case 'Agent':
    case 'Task': {
      const type = input['subagent_type'];
      return `${looseText(input['description'])}${type ? ` (${looseText(type)})` : ''}`;
    }
    case 'Workflow': {
      const workflow = input['name'];
      if (workflow != null) return looseText(workflow);
      const script = input['script'];
      const named = typeof script === 'string' ? /name:\s*['"]([^'"]+)/.exec(script)?.[1] : undefined;
      return oneLine(named ?? 'inline script');
    }
    case 'Skill':
      return looseText(input['skill']);
    case 'WebFetch':
      return looseText(input['url']);
    case 'Grep':
    case 'Glob':
      return looseText(input['pattern']);
    case 'AskUserQuestion': {
      const questions = input['questions'];
      const first: unknown = Array.isArray(questions) ? questions[0] : undefined;
      return oneLine(looseText(isRecord(first) ? first['question'] : undefined), 70);
    }
    default:
      return oneLine(JSON.stringify(input), 70);
  }
}

/**
 * The call's input as a person reads it: the shell command; a written file's path and content; an
 * edit's path with its old and new text; otherwise the input as pretty-printed JSON.
 */
export function inputText(name: string, input: Readonly<Record<string, unknown>>): string {
  switch (name) {
    case 'Bash':
      return looseText(input['command']);
    case 'Write':
      return `${jsText(input['file_path'])}\n\n${looseText(input['content'])}`;
    case 'Edit':
      return `${jsText(input['file_path'])}\n\n--- old\n${looseText(input['old_string'])}\n+++ new\n${looseText(input['new_string'])}`;
    default:
      return JSON.stringify(input, null, 2);
  }
}
