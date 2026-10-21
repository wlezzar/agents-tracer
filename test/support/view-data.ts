import type {
  ConversationBlock,
  ConversationItem,
  ConversationTurn,
  ModelItem,
  ModelSpan,
  ToolBlock,
  ToolSpan,
  ViewLane,
  ViewTurn,
} from '../../src/view/types.js';

// Builders of view data for the tests of the viewer's client (src/viewer/client/).

export function toolSpan(s: number, e: number, extra: Partial<ToolSpan> = {}): ToolSpan {
  return {
    t: 't',
    s,
    e,
    ms: e - s,
    name: 'read',
    pv: '',
    desc: '',
    in: '',
    out: '',
    err: false,
    intr: false,
    async: false,
    bgEnd: null,
    agent: null,
    run: null,
    turn: 1,
    cat: 'file',
    id: `t${s}`,
    ...extra,
  };
}

export function modelSpan(s: number, e: number, extra: Partial<ModelSpan> = {}): ModelSpan {
  return {
    t: 'm',
    s,
    e,
    ms: e - s,
    syn: false,
    out: null,
    cr: null,
    cw: null,
    stop: null,
    think: false,
    text: '',
    tools: [],
    sum: '',
    turn: 1,
    id: `m${s}`,
    ...extra,
  };
}

export function turn(n: number, ts: number, end: number, extra: Partial<ViewTurn> = {}): ViewTurn {
  return { n, ts, end, kind: 'you', text: `turn ${n}`, calls: 0, tools: 0, b: [], ...extra };
}

export function viewLane(id: string, extra: Partial<ViewLane> = {}): ViewLane {
  return {
    id,
    label: id,
    group: 'main',
    parent: null,
    title: null,
    seg: [],
    spans: [],
    turns: [],
    buckets: [],
    bash: [],
    stats: {
      wall: 0,
      active: 0,
      model: 0,
      tools: 0,
      you: 0,
      calls: 0,
      toolCalls: 0,
      out: null,
      cacheRead: null,
      cacheWrite: null,
      models: [],
      compactions: [],
    },
    ...extra,
  };
}

/** A tool call of the conversation page's data. */
export function toolBlock(id: string, extra: Partial<ToolBlock> = {}): ToolBlock {
  return {
    type: 'tool',
    id,
    name: 'read',
    category: 'file',
    preview: '',
    purpose: '',
    detail: '',
    input: '',
    output: '',
    status: 'ok',
    async: false,
    start: 0,
    end: 1000,
    ms: 1000,
    images: 0,
    tokens: 0,
    permission: null,
    agent: null,
    ...extra,
  };
}

/** A model call of the conversation page's data. */
export function modelItem(id: string, blocks: readonly ConversationBlock[], extra: Partial<ModelItem> = {}): ModelItem {
  return {
    type: 'model',
    id,
    ts: 0,
    start: 0,
    end: 1000,
    ms: 1000,
    model: 'model-a',
    synthetic: false,
    error: false,
    stop: 'end_turn',
    context: null,
    out: null,
    blocks,
    ...extra,
  };
}

/** A turn of the conversation page's data. */
export function conversationTurn(
  n: number,
  items: readonly ConversationItem[],
  extra: Partial<ConversationTurn> = {},
): ConversationTurn {
  return { n, kind: n === 0 ? null : 'you', ts: 0, end: 0, active: 0, items, ...extra };
}
