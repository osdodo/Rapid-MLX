import { expect, test } from '@playwright/test';
import { startStub } from './stub-server';

test('diag', async ({ page }) => {
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });
  const stub = await startStub({});
  try {
    await page.goto(stub.baseURL);
    await expect(page.getByLabel('Message')).toBeVisible();

    // Skip the drawer entirely: trigger the palette by keyboard.
    await page.keyboard.press('Meta+k');
    await page.waitForTimeout(800);
    const viaKey = await page.evaluate(() => document.querySelectorAll('input[placeholder]').length);
    console.log('VIA CMD-K inputs:', viaKey);

    await page.getByLabel('Open sidebar').click();
    await page.getByRole('button', { name: 'Search conversations' }).click();
    for (const ms of [200, 500, 1000, 2000]) {
      await page.waitForTimeout(ms);
      const n = await page.evaluate(() => document.querySelectorAll('[cmdk-root]').length);
      console.log(`after ~${ms}ms cumulative: cmdk-root=${n}`);
    }
  } finally {
    await stub.close();
  }
});
