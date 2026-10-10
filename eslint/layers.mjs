// The `agents-tracer/layers` rule: keeps the layers of src/ in their dependency direction
// (docs/architecture.md). Each file belongs to the layer named by its first directory under src/,
// except that each adapter (src/adapters/<id>/) and the viewer's client (src/viewer/client/) are
// layers of their own. A file may import its own layer, the layers its entry allows, and the Node
// built-ins its entry allows; nothing else: no other layer, no file outside src/, and no package,
// since agents-tracer has no runtime dependencies.

import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * @typedef {object} LayerRule
 * @property {readonly (string | { layer: string; typeOnly: true })[] | '*'} imports Layers it may
 *   import: a layer name, `adapters/*` for any adapter, or `{ layer, typeOnly: true }` for
 *   `import type` only. `*` allows every layer.
 * @property {readonly string[] | boolean} node The Node built-ins it may import (`node:` names),
 *   or `true` for all of them, or `false` for none.
 */

/** @typedef {{ srcDir: string; layers: Record<string, LayerRule> }} Options */

const builtins = new Set(builtinModules);

/** The layer of a path relative to src/, or undefined for one outside it. */
export function layerOf(relativePath) {
  if (relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)) return undefined;
  const parts = relativePath.split(sep);
  const [first, second] = parts;
  if (first === 'adapters' && parts.length >= 3) return `adapters/${second}`;
  if (first === 'viewer' && second === 'client' && parts.length >= 3) return 'viewer/client';
  return parts.length >= 2 ? first : `(src/${first})`;
}

function matches(pattern, layer) {
  return pattern === layer || (pattern === 'adapters/*' && layer.startsWith('adapters/'));
}

/** @type {import('eslint').Rule.RuleModule} */
export const layersRule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the layers of src/ in their dependency direction.' },
    schema: [
      {
        type: 'object',
        properties: { srcDir: { type: 'string' }, layers: { type: 'object' } },
        required: ['srcDir', 'layers'],
        additionalProperties: false,
      },
    ],
    messages: {
      noLayer: 'src/{{path}} belongs to no layer; put it in a directory of src/ named in eslint.config.mjs.',
      layer: 'The {{from}} layer may not import the {{to}} layer ({{source}}); see docs/architecture.md.',
      typeOnly: 'The {{from}} layer may import the {{to}} layer only with `import type` ({{source}}).',
      outside: 'Code in src/ may not import files outside src/ ({{source}}).',
      node: 'The {{from}} layer may not import the Node built-in {{source}}.',
      nodePrefix: 'Import Node built-ins with the node: prefix ({{source}}).',
      dependency: 'agents-tracer has no runtime dependencies; {{source}} is not a Node built-in.',
      dynamic: 'Import a module by a plain string, so that its layer can be checked.',
    },
  },
  create(context) {
    /** @type {Options} */
    const { srcDir, layers } = context.options[0];
    const filename = context.filename;
    const from = layerOf(relative(srcDir, filename));
    if (from === undefined) return {};
    // Each adapter's directory is a layer of its own, which `adapters/*` describes.
    const rule = layers[from] ?? (from.startsWith('adapters/') ? layers['adapters/*'] : undefined);
    if (rule === undefined) {
      return {
        Program(node) {
          context.report({
            node,
            messageId: 'noLayer',
            data: { path: relative(srcDir, filename) },
          });
        },
      };
    }

    function check(node, source, typeOnly) {
      if (typeof source !== 'string') return;
      const report = (messageId, data = {}) => context.report({ node, messageId, data: { from, source, ...data } });
      if (source.startsWith('node:') || builtins.has(source.split('/')[0] ?? '')) {
        if (!source.startsWith('node:')) return report('nodePrefix');
        if (rule.node === true) return;
        if (rule.node === false || !rule.node.includes(source)) return report('node');
        return;
      }
      if (!source.startsWith('.')) return report('dependency');
      const to = layerOf(relative(srcDir, resolve(dirname(filename), source)));
      if (to === undefined) return report('outside');
      if (to === from || rule.imports === '*') return;
      for (const allowed of rule.imports) {
        if (typeof allowed === 'string') {
          if (matches(allowed, to)) return;
        } else if (matches(allowed.layer, to)) {
          if (!typeOnly) report('typeOnly', { to });
          return;
        }
      }
      report('layer', { to });
    }

    return {
      ImportDeclaration(node) {
        check(node.source, node.source.value, node.importKind === 'type');
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node.source.value, node.exportKind === 'type');
      },
      ExportAllDeclaration(node) {
        check(node.source, node.source.value, node.exportKind === 'type');
      },
      ImportExpression(node) {
        const { source } = node;
        if (source.type === 'Literal') check(source, source.value, false);
        else if (source.type === 'TemplateLiteral' && source.expressions.length === 0)
          check(source, source.quasis[0]?.value.cooked, false);
        else context.report({ node: source, messageId: 'dynamic' });
      },
      TSImportType(node) {
        // typescript-eslint 8 names the literal `source`; older versions wrap it in `argument`.
        const literal = 'source' in node ? node.source : node.argument?.literal;
        if (literal?.type === 'Literal') check(literal, literal.value, true);
      },
    };
  },
};

export const plugin = { meta: { name: 'agents-tracer' }, rules: { layers: layersRule } };
