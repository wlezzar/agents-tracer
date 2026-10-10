import type { Session } from '../model/index.js';
import { analyzeTranscript } from './analyze.js';
import { MAIN, type AgentAnalysis, type AnalyzeOptions, type SessionAnalysis, type ToolRun } from './types.js';

/**
 * Analyzes a session's main transcript and every agent's, and places each agent: the transcript
 * whose tool result launched it, and whether that is another agent.
 */
export function analyzeSession(session: Session, options: AnalyzeOptions = {}): SessionAnalysis {
  const main = analyzeTranscript(session.main, options);
  const analyzed = session.agents.map((agent) => ({ agent, analysis: analyzeTranscript(agent.transcript, options) }));

  const parents = new Map<string, string>(); // agent id -> the id of the transcript that launched it
  const launchers = new Map<string, ToolRun>(); // agent id -> the main transcript's call that launched it
  for (const run of main.tools) {
    const id = run.launches.agentId;
    if (!id) continue;
    parents.set(id, MAIN);
    launchers.set(id, run);
  }
  for (const { agent, analysis } of analyzed) {
    for (const run of analysis.tools) {
      const id = run.launches.agentId;
      if (id) parents.set(id, agent.id);
    }
  }

  const agents = analyzed.map(({ agent, analysis }): AgentAnalysis => {
    const parent = parents.get(agent.id) ?? (agent.group ? MAIN : null);
    const launcher = launchers.get(agent.id);
    return {
      agent,
      analysis,
      parent,
      nested: parent !== null && parent !== MAIN,
      ...(launcher && { launcher }),
    };
  });
  return { session, main, agents };
}
