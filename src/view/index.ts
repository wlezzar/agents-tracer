// The view: the data the viewer reads, its builder, and the viewer's page with that data.

export { buildView, clip, viewSession, type ViewOptions } from './build.js';
export { DATA_PLACEHOLDER, renderHtml, viewerTemplate } from './render.js';
export type {
  IndexData,
  IndexSession,
  ModelSpan,
  PageData,
  ShellTuple,
  ToolSpan,
  ViewCompaction,
  ViewData,
  ViewGroup,
  ViewLane,
  ViewSegment,
  ViewSession,
  ViewSpan,
  ViewStats,
  ViewTurn,
} from './types.js';
