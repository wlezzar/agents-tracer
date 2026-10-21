// Links between a session's timeline and its conversation: a page's hash names a lane (a thread,
// by the same id) and a tool call or a model call in it, as `#lane=main&tool=<id>` or
// `#lane=<agent>&model=<message id>`; the conversation's also names any item of a turn by the
// turn's number and the item's index in it, as `#lane=main&item=3.5`.

/** What a link points at. */
export type Target =
  | { readonly lane: string; readonly tool: string }
  | { readonly lane: string; readonly model: string }
  | { readonly lane: string; readonly item: string }
  | { readonly lane: string };

/** The hash that points at `target`. */
export function targetHash(target: Target): string {
  return `#${new URLSearchParams(Object.entries(target)).toString()}`;
}

/** What a page's hash points at; null for a hash that names no lane. */
export function parseTarget(hash: string): Target | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const lane = params.get('lane');
  if (!lane) return null;
  const tool = params.get('tool');
  if (tool) return { lane, tool };
  const model = params.get('model');
  if (model) return { lane, model };
  const item = params.get('item');
  if (item && /^\d+\.\d+$/.test(item)) return { lane, item };
  return { lane };
}
