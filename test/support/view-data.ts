import type { ModelSpan, ToolSpan, ViewLane, ViewTurn } from '../../src/view/types.js';

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
