import { describe, expect, it, vi } from 'vitest';
import { agentMessage, handleCopilotRequest, parseAgentRequest } from './agent';

const env = { url: 'https://agent.example/invoke', apiKey: 'secret-key' };

describe('copilot agent proxy', () => {
  it('reports whether an agent is configured, without exposing the key', async () => {
    expect(await handleCopilotRequest(env, 'GET', null)).toEqual({ status: 200, json: { configured: true } });
    expect(await handleCopilotRequest({}, 'GET', null)).toEqual({ status: 200, json: { configured: false } });
    expect(JSON.stringify(await handleCopilotRequest(env, 'GET', null))).not.toContain('secret-key');
  });

  it('rejects malformed requests before calling the agent', async () => {
    expect(parseAgentRequest({ question: '', sessionId: 'abcdef' })).toBeNull();
    expect(parseAgentRequest({ question: 'Why?', sessionId: 'bad id!' })).toBeNull();
    expect((await handleCopilotRequest(env, 'POST', { foo: 1 })).status).toBe(400);
    expect((await handleCopilotRequest(env, 'DELETE', null)).status).toBe(405);
  });

  it('labels the plant figures as simulated in the message', () => {
    const m = agentMessage('What is the OEE?', 'OEE: 91.8 %');
    expect(m).toMatch(/SIMULATED demo data, not live plant data/);
    expect(m).toContain('OEE: 91.8 %');
    expect(m.trim().endsWith('Question: What is the OEE?')).toBe(true);
  });

  it('forwards the key in a header only and returns the answer text', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, data: { response: 'OEE is 91.8 % (simulated).', conversation_id: 'c1', metadata: { model: 'm' } } }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await handleCopilotRequest(env, 'POST', { question: 'What is the OEE?', context: 'OEE: 91.8 %', sessionId: 'twin-abc123' });
    expect(r).toEqual({ status: 200, json: { ok: true, text: 'OEE is 91.8 % (simulated).', conversationId: 'c1', model: 'm' } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(env.url);
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret-key');
    expect(String(init.body)).not.toContain('secret-key');
    vi.unstubAllGlobals();
  });

  it('maps agent errors to plain reasons', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false }, { status: 401 })));
    const r = await handleCopilotRequest(env, 'POST', { question: 'Hi', sessionId: 'twin-abc123' });
    expect(r.status).toBe(401);
    expect((r.json as { error: string }).error).toMatch(/rejected the API key/);
    vi.unstubAllGlobals();
  });
});
