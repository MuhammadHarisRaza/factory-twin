/**
 * Server-side call to the configured AI agent endpoint (the copilot's language model).
 *
 * Runs only on the server — the Vercel function api/copilot.ts in production, the Vite dev server's
 * middleware locally (vite.config.ts). The API key is read from the server environment
 * (ALARA_API_KEY, ALARA_AGENT_URL) and is never sent to the browser. The browser posts the question
 * and a snapshot of the simulated plant figures; this module forwards them and returns the agent's
 * answer text only.
 */

export type AgentEnv = { url?: string; apiKey?: string };

export type AgentRequest = {
  question: string;
  /** Simulated plant figures and context the answer may use (built in the browser). */
  context: string;
  sessionId: string;
  conversationId?: string | null;
};

export type AgentResult =
  | { ok: true; text: string; conversationId: string | null; model: string | null }
  | { ok: false; status: number; error: string };

const MAX_QUESTION = 2000;
const MAX_CONTEXT = 12000;
const TIMEOUT_MS = 55_000;

export const agentConfigured = (env: AgentEnv) => !!(env.url && env.apiKey);

/** The message sent to the agent: how to treat the demo figures, then the figures, then the question. */
export function agentMessage(question: string, context: string) {
  return [
    'You are the copilot of a digital-twin demo of a representative ceramic tile plant.',
    'The plant figures below are SIMULATED demo data, not live plant data: say so when you use them, and never present them as measurements from the real plant.',
    'Use the figures for questions about the current state of the plant; use your own documents for questions about equipment, suppliers, manuals or contracts.',
    'If neither the figures nor your documents establish something, say that it cannot be established. Answer concisely in plain language.',
    '',
    '--- Simulated plant figures (demo) ---',
    context.slice(0, MAX_CONTEXT),
    '--- End of figures ---',
    '',
    `Question: ${question.slice(0, MAX_QUESTION)}`,
  ].join('\n');
}

/** Validates a request body from the browser (anything unexpected is rejected, not forwarded). */
export function parseAgentRequest(body: unknown): AgentRequest | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const question = typeof b.question === 'string' ? b.question.trim() : '';
  const sessionId = typeof b.sessionId === 'string' ? b.sessionId.trim() : '';
  if (!question || !/^[\w-]{6,80}$/.test(sessionId)) return null;
  return {
    question: question.slice(0, MAX_QUESTION),
    context: typeof b.context === 'string' ? b.context.slice(0, MAX_CONTEXT) : '',
    sessionId,
    conversationId: typeof b.conversationId === 'string' && /^[\w-]{1,80}$/.test(b.conversationId) ? b.conversationId : null,
  };
}

const ERRORS: Record<number, string> = {
  401: 'The agent rejected the API key (revoked, expired or wrong).',
  403: 'The API key does not belong to this agent deployment.',
  404: 'The agent deployment is unpublished or suspended.',
  429: 'The agent is rate-limited — try again in a moment.',
  503: 'The agent service is unavailable.',
};

export async function invokeAgent(env: AgentEnv, req: AgentRequest): Promise<AgentResult> {
  if (!agentConfigured(env)) return { ok: false, status: 503, error: 'No AI agent is configured on the server.' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(env.url!, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.apiKey! },
      body: JSON.stringify({
        message: agentMessage(req.question, req.context),
        sessionId: req.sessionId,
        conversationId: req.conversationId ?? undefined,
        metadata: { client: 'factory-twin-copilot', data: 'simulated-demo' },
        stream: false,
      }),
      signal: ctl.signal,
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: { response?: unknown; conversation_id?: unknown; metadata?: { model?: unknown } } } | null;
    if (!res.ok || !json?.success) return { ok: false, status: res.status || 502, error: ERRORS[res.status] ?? `The agent returned an error (HTTP ${res.status}).` };
    const text = typeof json.data?.response === 'string' ? json.data.response.trim() : '';
    if (!text) return { ok: false, status: 502, error: 'The agent returned an empty answer.' };
    return {
      ok: true,
      text,
      conversationId: typeof json.data?.conversation_id === 'string' ? json.data.conversation_id : null,
      model: typeof json.data?.metadata?.model === 'string' ? json.data.metadata.model : null,
    };
  } catch (e) {
    const aborted = e instanceof Error && e.name === 'AbortError';
    return { ok: false, status: 504, error: aborted ? 'The agent did not answer in time.' : 'The agent could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

/** One handler for both runtimes: GET reports whether an agent is configured, POST asks it. */
export async function handleCopilotRequest(env: AgentEnv, method: string, body: unknown): Promise<{ status: number; json: unknown }> {
  if (method === 'GET') return { status: 200, json: { configured: agentConfigured(env) } };
  if (method !== 'POST') return { status: 405, json: { ok: false, error: 'Method not allowed' } };
  const req = parseAgentRequest(body);
  if (!req) return { status: 400, json: { ok: false, error: 'Invalid request' } };
  const r = await invokeAgent(env, req);
  return r.ok ? { status: 200, json: r } : { status: r.status, json: r };
}
