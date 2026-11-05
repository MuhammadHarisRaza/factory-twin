/**
 * Browser side of the AI agent: posts a question with a snapshot of the simulated plant to
 * /api/copilot (the server holds the agent URL and key — src/server is never bundled). The snapshot
 * is the rule-based answer's figures plus the headline KPIs and open issues, all labelled simulated,
 * so the agent answers from the same demo numbers the workspaces show.
 */
import { attentionEvents, overviewKpis } from '../../intel/kpis';
import type { CopilotAnswer } from '../../intel/copilot';
import type { SimState } from '../../sim/engine';
import { resolvePeriod } from '../../sim/metrics';
import { formatClock, formatDay } from '../../sim/time';
import { FACTORY, LINE } from '../../model/plant';

export type AgentReply = { ok: true; text: string; conversationId: string | null } | { ok: false; error: string };

/** Whether the server has an agent configured (null while unknown / unreachable). */
export async function agentAvailable(): Promise<boolean | null> {
  try {
    const r = await fetch('/api/copilot', { method: 'GET', cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as { configured?: unknown };
    return j.configured === true;
  } catch {
    return null;
  }
}

/** The simulated figures sent with a question (plain text, labelled as simulated demo data). */
export function agentContext(
  sim: SimState,
  rule: CopilotAnswer,
  ctx: { workspace: string; periodLabel: string; eventId: string | null; equipmentId: string | null; stageId: string | null; vehicleId?: string | null },
): string {
  const lines: string[] = [];
  lines.push(`Plant: ${FACTORY.name} (representative plant, simulated) · ${LINE.name}`);
  lines.push(`Plant time (simulated clock): ${formatDay(sim.minute)} ${formatClock(sim.minute)}`);
  lines.push(`Asked from: ${ctx.workspace} · period ${ctx.periodLabel}`);
  const focus = [ctx.eventId && `event ${ctx.eventId}`, ctx.equipmentId && `equipment ${ctx.equipmentId}`, ctx.stageId && `stage ${ctx.stageId}`, ctx.vehicleId && `vehicle ${ctx.vehicleId}`].filter(Boolean);
  if (focus.length) lines.push(`In focus: ${focus.join(', ')}`);
  lines.push('');
  lines.push('Headline KPIs (current shift, simulated):');
  for (const k of overviewKpis(sim, resolvePeriod('shift', sim.minute)))
    lines.push(`- ${k.label}: ${k.unavailable ? `unavailable (${k.unavailable})` : `${k.display}${k.unit ? ` ${k.unit}` : ''}`}${k.target ? ` · ${k.target}` : ''}${k.status ? ` · ${k.status.label}` : ''}`);
  const open = attentionEvents(sim).slice(0, 8);
  lines.push('');
  lines.push(open.length ? 'Open issues needing attention (simulated events):' : 'Open issues needing attention: none.');
  for (const e of open) lines.push(`- ${e.id} · ${e.severity} · ${e.title}`);
  lines.push('');
  lines.push("The twin's rule-based analysis of this question (built from the simulated records):");
  for (const s of rule.sections) lines.push(`[${s.kind}] ${s.text}`);
  if (rule.facts.length) {
    lines.push('');
    lines.push('Figures used:');
    for (const f of rule.facts) lines.push(`- ${f.label}: ${f.value}`);
  }
  return lines.join('\n');
}

export async function askAgent(req: { question: string; context: string; sessionId: string; conversationId: string | null }): Promise<AgentReply> {
  try {
    const r = await fetch('/api/copilot', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const j = (await r.json().catch(() => null)) as { ok?: boolean; text?: unknown; conversationId?: unknown; error?: unknown } | null;
    if (r.ok && j?.ok && typeof j.text === 'string') return { ok: true, text: j.text, conversationId: typeof j.conversationId === 'string' ? j.conversationId : null };
    return { ok: false, error: typeof j?.error === 'string' ? j.error : r.status === 404 ? 'The AI agent route is not available on this deployment.' : `The AI agent request failed (HTTP ${r.status}).` };
  } catch {
    return { ok: false, error: 'The AI agent could not be reached.' };
  }
}

/** A fresh session id for a conversation (the agent keeps its own memory per session). */
export const newSessionId = () => `twin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
