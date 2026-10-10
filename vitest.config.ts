import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Most tests pre-roll seven simulated days (≈1 s each); allow headroom on a busy machine.
export default mergeConfig(viteConfig, defineConfig({ test: { testTimeout: 30_000 } }));
