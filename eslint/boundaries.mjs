// The adapter boundary: what each agent calls its tools, files, and record fields, which only the
// adapters may name (any adapter: another agent may have a tool of the same name). eslint.config.mjs
// turns every entry into no-restricted-syntax selectors for the rest of src/, and
// test/boundaries.test.ts checks the files of src/ that ESLint does not read, such as the viewer's
// template. When an adapter is added, add its entry here (docs/adapters.md).

/** @typedef {import('./boundaries.d.mts').Boundary} Boundary */

/** @type {Readonly<Record<string, Boundary>>} */
export const boundaries = {
  'claude-code': {
    agent: 'Claude Code',
    words:
      /\b(Bash|AskUserQuestion|TaskStop|NotebookEdit|WebFetch|run_in_background|subagent_type|toolUseResult|isCompactSummary|compactMetadata|aiTitle|isMeta|tool_use_id|file_path|notebook_path|queued_command)\b|task-notification|\.claude\b|jsonl/,
    tools: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'NotebookEdit',
      'Grep',
      'Glob',
      'WebFetch',
      'Agent',
      'Task',
      'Workflow',
      'Skill',
      'AskUserQuestion',
      'TaskStop',
    ],
  },
};

/** The call methods that look a value up or test membership: an argument to one is matched. */
const lookups = /^(includes|has|get|indexOf|lastIndexOf)$/.source;

/**
 * The `no-restricted-syntax` entries that keep every adapter's vocabulary out of the code they
 * apply to: its words in any string literal, template text, or object key, and its tool names
 * wherever a value is matched against one (a comparison, a switch case, a lookup, a membership
 * list, a lookup table's key, a computed member). A tool name elsewhere, such as the UI word
 * 'Agent' in a table's headings, is allowed.
 *
 * @param {Readonly<Record<string, Boundary>>} all
 */
export function boundarySelectors(all) {
  return Object.entries(all).flatMap(([id, { agent, words, tools }]) => {
    const word = words.source;
    const name = `^(${tools.join('|')})$`;
    const where = `src/adapters/${id}`;
    return [
      ...[
        `Literal[value=/${word}/]`,
        `TemplateElement[value.raw=/${word}/]`,
        `Property > Identifier.key[name=/${word}/]`,
      ].map((selector) => ({
        selector,
        message: `${agent}'s tool names, files, and records belong in ${where}; read the neutral model instead.`,
      })),
      ...[
        `BinaryExpression[operator=/^[!=]==?$/] > Literal[value=/${name}/]`,
        `SwitchCase > Literal.test[value=/${name}/]`,
        `CallExpression[callee.property.name=/${lookups}/] > Literal.arguments[value=/${name}/]`,
        `CallExpression[callee.property.name=/${lookups}/] > MemberExpression.callee > ArrayExpression.object > Literal[value=/${name}/]`,
        `NewExpression[callee.name=/^(Set|Map)$/] ArrayExpression > Literal[value=/${name}/]`,
        `Property > Identifier.key[name=/${name}/]`,
        `Property > Literal.key[value=/${name}/]`,
        `MemberExpression[computed=true] > Literal.property[value=/${name}/]`,
      ].map((selector) => ({
        selector,
        message: `${agent}'s tool names belong in ${where}; match a tool's category (desc.category) instead.`,
      })),
    ];
  });
}
