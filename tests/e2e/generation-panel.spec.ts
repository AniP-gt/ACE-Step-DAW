/**
 * Covered story ids:
 * - GEN-001, GEN-002
 *
 * Persona: user invoking AI generation
 * Workflow summary: open and interact with the generation panel around the
 * prompt-to-content workflow.
 * Why this test exists: covers the visible AI generation surface tied to the
 * matrix generation stories.
 * Left to other layers: backend-dependent success quality and human music judgment.
 */
import { expect, test } from '@playwright/test';
import { dismissWelcomeOverlay } from '../support/e2eStartup';

test.describe('Generation Panel @critical', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/health', (route) => route.fulfill({ json: { status: 'ok' } }));
    await page.route('**/api/v1/model_inventory', (route) => route.fulfill({
      json: { data: { models: [{ name: 'acestep-v15-turbo', is_loaded: true, is_default: true }], lm_models: [] } },
    }));
    await dismissWelcomeOverlay(page);
    const inventoryLoaded = page.waitForResponse('**/api/v1/model_inventory');
    await page.goto('/');
    await inventoryLoaded;
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof (window as any).__store !== 'undefined');
    await page.evaluate(() => {
      const browserWindow = window as unknown as {
        __store: {
          getState: () => {
            createProject: (params: { name: string; bpm: number; keyScale: string }) => void;
            addTrack: (trackName: string) => { id: string };
            setShowGenerationPanel: (value: boolean) => void;
          };
        };
      };

      browserWindow.__store.getState().createProject({
        name: 'Generation Panel Test',
        bpm: 128,
        keyScale: 'E minor',
      });
      browserWindow.__store.getState().addTrack('drums');
      browserWindow.__store.getState().setShowGenerationPanel(true);
    });
  });

  test('submits the visible custom generation controls through the shared pipeline', async ({ page }, testInfo) => {
    await page.route('**/api/release_task', (route) => route.fulfill({
      json: { data: { task_id: 'generation-panel-task', status: 'queued' } },
    }));
    await page.route('**/api/query_result', (route) => route.fulfill({
      json: { data: [{ task_id: 'generation-panel-task', status: 0, result: '[]' }] },
    }));

    await expect(page.getByLabel('Generate panel', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Custom', exact: true }).click();
    const form = page.getByTestId('full-song-form');
    await form.getByRole('combobox', { name: 'Generation prompt' }).fill('glassy future garage with vocal chops');
    await form.getByRole('button', { name: 'Add house style tag', exact: true }).click();
    await form.getByRole('checkbox', { name: 'Auto', exact: true }).uncheck();
    await form.getByRole('spinbutton').first().fill('48');
    await form.getByRole('slider', { name: 'Generation temperature' }).fill('0.4');
    await form.getByRole('checkbox', { name: 'Rand', exact: true }).uncheck();
    await form.getByRole('spinbutton').nth(1).fill('1234');
    await form.getByRole('checkbox', { name: /Match project/ }).check();
    await form.getByRole('checkbox', { name: 'Instrumental', exact: true }).check();
    await form.getByRole('checkbox', { name: 'Split to stems', exact: true }).uncheck();

    const requestPromise = page.waitForRequest('**/api/release_task');
    await page.getByRole('button', { name: 'Generate Full Song', exact: true }).click();
    const request = await requestPromise;
    const body = request.postDataBuffer();
    expect(body).not.toBeNull();
    const payload = await new Response(new Uint8Array(body ?? []), {
      headers: { 'content-type': request.headers()['content-type'] },
    }).formData();
    const fields = Object.fromEntries([...payload.entries()].filter(([, value]) => typeof value === 'string'));
    await testInfo.attach('submitted-generation-payload', {
      body: JSON.stringify(fields, null, 2), contentType: 'application/json',
    });
    expect(fields).toMatchObject({
      task_type: 'text2music',
      prompt: 'house. glassy future garage with vocal chops',
      lyrics: '[Instrumental]',
      bpm: '128', key_scale: 'E minor', time_signature: '4',
      audio_duration: '48', guidance_scale: '0.4',
      seed: '1234', use_random_seed: 'false', batch_size: '1',
    });
    await expect(page.getByLabel('Generate panel', { exact: true })).toBeHidden();
  });
});
