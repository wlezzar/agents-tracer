// The view: the data the viewer reads, its builder, and the viewer's page with that data.

export { clip } from '../util/index.js';
export { buildView, viewSession, type ViewOptions } from './build.js';
export { CONVERSATION_TEXT, conversationView, viewConversation, type ConversationViewOptions } from './conversation.js';
export { DATA_PLACEHOLDER, renderHtml, viewerTemplate } from './render.js';
export type {
  ConversationData,
  IndexData,
  IndexSession,
  ModelSpan,
  PageData,
  ProjectsData,
  ShellTuple,
  ToolSpan,
  ViewCompaction,
  ViewData,
  ViewGroup,
  ViewLane,
  ViewProject,
  ViewProjectSession,
  ViewSegment,
  ViewSession,
  ViewSpan,
  ViewStats,
  ViewTurn,
} from './types.js';
