import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Most tests pre-roll seven simulated days (≈1 s each); allow headroom on a busy machine and run at most
// half the CPUs in parallel (simulation-heavy files otherwise starve each other into timeouts).
export default mergeConfig(viteConfig, defineConfig({ test: { testTimeout: 30_000, hookTimeout: 120_000, maxWorkers: '50%' } }));
