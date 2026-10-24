import type { Adapter, AgentTranscript, Group, LoadOptions, Session } from '../../model/index.js';
import {
  defaultRoot,
  defaultStore,
  findSubagents,
  isSubagentFile,
  listSessions,
  listStores,
  readTranscript,
  resolve,
  sessionVersion,
  workflowSummary,
} from './store.js';
import { SHELL_TOOL } from './tools.js';

// The Claude Code adapter: reads the transcripts Claude Code keeps under ~/.claude/projects.

export const CLAUDE_CODE_ID = 'claude-code';

/** What Claude Code calls a group of agents: a workflow run. */
const WORKFLOW = 'Workflow';

/**
 * The session in a transcript file: a session's own transcript with its subagents and the
 * workflow runs they ran in, or a subagent's transcript alone.
 */
export function loadSession(file: string, options: LoadOptions = {}): Session {
  const main = readTranscript(file, options);
  const base = { adapter: CLAUDE_CODE_ID, main, shellToolName: SHELL_TOOL };
  if (isSubagentFile(file)) return { ...base, agents: [], groups: [] };
  const found = findSubagents(file);
  const agents: AgentTranscript[] = found.map(({ file: agentFile, agentId, meta, workflow }) => ({
    id: agentId,
    transcript: readTranscript(agentFile, options),
    background: meta.requestShape === 'background',
    group: workflow ?? null,
    ...(meta.description !== undefined && { description: meta.description }),
    ...(meta.workflowPhase !== undefined && { phase: meta.workflowPhase }),
    ...(meta.agentType !== undefined && { agentType: meta.agentType }),
  }));
  const runs = [...new Set(found.flatMap((f) => (f.workflow === undefined ? [] : [f.workflow])))];
  const groups: Group[] = runs.map((runId) => {
    const w = workflowSummary(file, runId);
    return {
      id: runId,
      kind: WORKFLOW,
      label: `${WORKFLOW} ${w.workflowName ?? ''}`.trim(),
      ...(w.workflowName !== undefined && { name: w.workflowName }),
      ...(w.status !== undefined && { status: w.status }),
      ...(w.durationMs !== undefined && { durationMs: w.durationMs }),
      ...(w.totalTokens !== undefined && { totalTokens: w.totalTokens }),
      ...(w.totalToolCalls !== undefined && { totalToolCalls: w.totalToolCalls }),
    };
  });
  return { ...base, agents, groups };
}

export const claudeCode: Adapter = {
  id: CLAUDE_CODE_ID,
  displayName: 'Claude Code',
  defaultStore,
  defaultRoot,
  listStores,
  listSessions,
  resolve,
  load: loadSession,
  version: sessionVersion,
};
