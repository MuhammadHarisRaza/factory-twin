/**
 * Vercel function: /api/copilot — the browser's only route to the AI agent. The API key stays in the
 * project's environment variables (ALARA_API_KEY, ALARA_AGENT_URL) and is never returned.
 */
import { handleCopilotRequest } from '../server/agent';

declare const process: { env: Record<string, string | undefined> };

const env = () => ({ url: process.env.ALARA_AGENT_URL, apiKey: process.env.ALARA_API_KEY });

const reply = (r: { status: number; json: unknown }) => Response.json(r.json, { status: r.status, headers: { 'cache-control': 'no-store' } });

export async function GET() {
  return reply(await handleCopilotRequest(env(), 'GET', null));
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  return reply(await handleCopilotRequest(env(), 'POST', body));
}
