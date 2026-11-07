import { expect, test } from '@playwright/test';
import { loadFreshApp, createProjectViaDialog, focusApplicationShell } from '../support/e2eStartup';

test.describe('Claude Code Terminal', () => {
  let codexConnections = 0;
  test.beforeEach(async ({ page }, testInfo) => {
    codexConnections = 0;
    if (testInfo.title === 'shows Codex installation help when the CLI is missing') {
      await page.routeWebSocket('**/ws/codex', socket => {
        socket.onMessage(() => socket.send(JSON.stringify({ type: 'codex-not-found' })));
      });
    }
    if (testInfo.title === 'keeps terminal output and connection when switching providers and reopening the panel') {
      await page.routeWebSocket('**/ws/codex', socket => {
        codexConnections += 1;
        socket.onMessage(message => {
          const control = JSON.parse(message.toString());
          if (control.type === 'init') socket.send('Codex session output\r\n');
        });
      });
    }
    await loadFreshApp(page);
    await createProjectViaDialog(page, 'Terminal Test', 128);
    await expect(page.getByTestId('dock-ai-assistant-toggle')).toBeVisible();
    await focusApplicationShell(page);
  });

  test('opens Claude Code terminal with Cmd+/', async ({ page }) => {
    await page.keyboard.press('Meta+Slash');
    await expect(page.getByTestId('claude-terminal')).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Claude Code Terminal' })).toBeVisible();
  });

  test('closes terminal with Cmd+/ toggle', async ({ page }) => {
    await page.keyboard.press('Meta+Slash');
    await expect(page.getByTestId('claude-terminal')).toBeVisible();

    await page.keyboard.press('Meta+Slash');
    await expect(page.getByTestId('claude-terminal')).not.toBeVisible();
  });

  test('closes other right panels when opening terminal', async ({ page }) => {
    // Open mixer first
    await page.evaluate(() => {
      (window as any).__uiStore.getState().setShowMixer(true);
    });

    // Open terminal
    await page.keyboard.press('Meta+Slash');

    // Mixer should be closed
    const mixerVisible = await page.evaluate(() => (window as any).__uiStore.getState().showMixer);
    expect(mixerVisible).toBe(false);

    // Terminal should be open
    await expect(page.getByTestId('claude-terminal')).toBeVisible();
  });

  test('shows connection status indicator', async ({ page }) => {
    await page.keyboard.press('Meta+Slash');
    await expect(page.getByTestId('claude-terminal')).toBeVisible();

    // Should show some connection status text (Connected, Connecting, or Disconnected)
    const terminalPanel = page.getByTestId('claude-terminal');
    const statusText = await terminalPanel.locator('text=/Connected|Connecting|Disconnected/').textContent();
    expect(statusText).toBeTruthy();
  });

  test('shows Codex installation help when the CLI is missing', async ({ page }) => {
    await page.getByTestId('dock-ai-assistant-toggle').click();
    await page.getByTestId('claude-terminal').getByLabel('AI assistant', { exact: true }).selectOption('codex');
    const codex = page.getByTestId('codex-terminal');
    await expect(codex.getByText('Codex not installed', { exact: true })).toBeVisible();
    await expect(codex.getByText('npm install -g @openai/codex', { exact: true })).toBeVisible();
  });

  test('keeps terminal output and connection when switching providers and reopening the panel', async ({ page }) => {
    await page.keyboard.press('Meta+Slash');
    const claude = page.getByTestId('claude-terminal');
    const codex = page.getByTestId('codex-terminal');
    await claude.getByLabel('AI assistant', { exact: true }).selectOption('codex');
    await expect(codex).toBeVisible();
    await expect(claude).toBeHidden();
    await expect(codex.getByText('Connected', { exact: true })).toBeVisible();
    await expect(codex.locator('.xterm-screen')).toBeVisible();
    await expect(codex.locator('.xterm-rows')).toContainText('Codex session output');
    await codex.getByLabel('AI assistant', { exact: true }).selectOption('claude');
    await expect(claude).toBeVisible();
    await claude.getByLabel('AI assistant', { exact: true }).selectOption('codex');
    await expect(codex).toBeVisible();
    await codex.getByRole('button', { name: 'Close Codex Terminal' }).click();
    await expect(codex).toBeHidden();
    await page.getByTestId('dock-ai-assistant-toggle').click();
    await expect(codex).toBeVisible();
    await expect(codex.getByLabel('AI assistant', { exact: true })).toHaveValue('codex');
    await expect(codex.locator('.xterm-rows')).toContainText('Codex session output');
    expect(codexConnections).toBe(1);
    for (const width of [1920, 1024, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      await expect(codex).toBeVisible();
      await page.screenshot({ path: `/tmp/ace-codex-terminal-${width}.png` });
    }
  });
});
