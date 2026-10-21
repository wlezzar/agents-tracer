import type { ModelItem, Shape, Thread } from '../../view/types.js';

// What the conversation page's drawer shows of a thread's requests: the settings its model calls
// were sent with, the tools it called, and how one system prompt and set of tools differs from the
// one before it.

/** A thread's model calls, in order. */
export function modelCalls(t: Thread): ModelItem[] {
  return t.turns.flatMap((turn) => turn.items).filter((i) => i.type === 'model');
}

/** The settings a thread's calls were sent with: each distinct set, and how many calls had it, most first. */
export function settingsOf(t: Thread): { readonly label: string; readonly calls: number }[] {
  const counts = new Map<string, number>();
  for (const m of modelCalls(t)) {
    const r = m.request;
    if (r === null) continue;
    const label = [
      r.model,
      r.effort === null ? null : `effort ${r.effort}`,
      r.maxTokens === null ? null : `max ${r.maxTokens} tokens`,
      r.thinking === null ? null : `thinking ${r.thinking}`,
    ]
      .filter((x) => x !== null)
      .join(' · ');
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, calls]) => ({ label, calls })).sort((x, y) => y.calls - x.calls);
}

/** The names of the tools a thread called. */
export function calledTools(t: Thread): Set<string> {
  const names = new Set<string>();
  for (const m of modelCalls(t)) for (const b of m.blocks) if (b.type === 'tool') names.add(b.name);
  return names;
}

/** What changed from one system prompt and set of tools to the next, in a few words each. */
export function shapeChanges(from: Shape, to: Shape): string[] {
  const before = new Map(from.tools.map((t) => [t.name, t]));
  const after = new Set(to.tools.map((t) => t.name));
  const changes: string[] = [];
  const added = to.tools.filter((t) => !before.has(t.name)).map((t) => t.name);
  const removed = from.tools.filter((t) => !after.has(t.name)).map((t) => t.name);
  const loaded: string[] = [];
  const redefined: string[] = [];
  for (const t of to.tools) {
    const was = before.get(t.name);
    if (was === undefined) continue;
    if (was.deferred && !t.deferred) loaded.push(t.name);
    else if (was.description !== t.description || was.schema !== t.schema || was.deferred !== t.deferred)
      redefined.push(t.name);
  }
  if (added.length) changes.push(`added ${added.join(', ')}`);
  if (removed.length) changes.push(`removed ${removed.join(', ')}`);
  if (loaded.length) changes.push(`loaded ${loaded.join(', ')}`);
  if (redefined.length) changes.push(`redefined ${redefined.join(', ')}`);
  from.system.forEach((b, i) => {
    const now = to.system[i];
    if (now === undefined) changes.push(`dropped system block ${i + 1}`);
    else if (now.text !== b.text) changes.push(`changed system block ${i + 1}`);
  });
  if (to.system.length > from.system.length)
    changes.push(`added ${to.system.length - from.system.length} system blocks`);
  return changes;
}
