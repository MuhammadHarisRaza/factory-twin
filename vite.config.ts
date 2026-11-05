import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { handleCopilotRequest } from './server/agent';

/**
 * The dev server answers /api/copilot the way the Vercel function does (api/copilot.ts), with the
 * agent URL and key from .env.local — read here on the server, never exposed to the browser (no
 * VITE_ prefix).
 */
function copilotApi(): Plugin {
  let env: Record<string, string> = {};
  return {
    name: 'copilot-api',
    configResolved(config) {
      env = loadEnv(config.mode, config.envDir || config.root, '');
    },
    configureServer(server) {
      server.middlewares.use('/api/copilot', async (incoming, res) => {
        // Node's request stream (this project has no @types/node, so its shape is declared here).
        const req = incoming as unknown as { method?: string; on: (ev: string, fn: (chunk?: unknown) => void) => void };
        const raw = await new Promise<string>((resolve) => {
          let s = '';
          req.on('data', (c) => (s += String(c)));
          req.on('end', () => resolve(s));
          req.on('error', () => resolve(''));
        });
        let body: unknown = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = null;
        }
        const r = await handleCopilotRequest({ url: env.ALARA_AGENT_URL, apiKey: env.ALARA_API_KEY }, req.method ?? 'GET', body);
        res.statusCode = r.status;
        res.setHeader('content-type', 'application/json');
        res.setHeader('cache-control', 'no-store');
        res.end(JSON.stringify(r.json));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), copilotApi()],
  // three.js alone is ~600 kB; the scene is already split into its own lazy chunk.
  build: { chunkSizeWarningLimit: 1000 },
});
