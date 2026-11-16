import { defineConfig, devices } from '@playwright/test';

import {
  applyPlaywrightProxySafeEnv,
  createPlaywrightProxySafeEnv,
} from './tests/support/playwrightProxyEnv';

function deriveWorktreePort() {
  return Array.from(process.cwd()).reduce((hash, character) => {
    return (hash * 33 + character.charCodeAt(0)) % 200;
  }, 0);
}

const e2ePort = Number(process.env.E2E_PORT) || 5274 + deriveWorktreePort();
if (process.env.VITE_LOGIC_BRIDGE_PORT !== undefined) {
  process.env.LOGIC_BRIDGE_ORIGINS = `http://127.0.0.1:${e2ePort}`;
}
const safeProcessEnv = createPlaywrightProxySafeEnv(process.env);

applyPlaywrightProxySafeEnv(process.env);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  globalTimeout: process.env.CI ? 4 * 60 * 1000 : undefined, // 4 min hard cap in CI
  use: {
    baseURL: `http://127.0.0.1:${e2ePort}`,
    trace: 'on-first-retry',
    launchOptions: {
      env: safeProcessEnv,
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: `http://127.0.0.1:${e2ePort}`,
    reuseExistingServer: false,
    timeout: 60000,
    env: {
      ...safeProcessEnv,
      VITE_PORT: String(e2ePort),
      ...(process.env.VITE_LOGIC_BRIDGE_PORT !== undefined ? { VITE_LOGIC_BRIDGE_PORT: process.env.VITE_LOGIC_BRIDGE_PORT } : {}),
      ...(process.env.VITE_LOGIC_BRIDGE_VERIFIED_MODEL !== undefined ? { VITE_LOGIC_BRIDGE_VERIFIED_MODEL: process.env.VITE_LOGIC_BRIDGE_VERIFIED_MODEL } : {}),
    },
  },
});
