import { expect, test as base } from '@playwright/test';
import { startStub, chatFrame, type Scenario } from './stub-server';

/**
 * The "jump to latest" button must track the CURRENT transcript.
 *
 * It is driven by React state, and state survives a conversation switch. So
 * scrolling up in a long chat and then starting a new one left the button
 * floating over an empty page with nothing above it to jump past. The fix
 * recomputes the flag from the DOM on every commit rather than only when a
 * scroll event happens to fire.
 */

type Stub = Awaited<ReturnType<typeof startStub>>;

const test = base.extend<{ scenario: Partial<Scenario>; stub: Stub }>({
  scenario: [
    {
      frameDelayMs: 40,
      chatFrames: Array.from({ length: 40 }, (_, i) => chatFrame(`Line ${i}.\n\n`)),
    },
    { option: true },
  ],
  stub: async ({ scenario }, use) => {
    const stub = await startStub(scenario);
    await use(stub);
    await stub.close();
  },
});

test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 700 } });

test('is absent on a conversation with nothing to scroll', async ({ page, stub }) => {
  await page.goto(stub.baseURL);
  await expect(page.getByLabel('Message')).toBeVisible();

  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
});

test('does not survive into a new, empty conversation', async ({ page, stub }) => {
  await page.goto(stub.baseURL);
  await page.getByLabel('Message').fill('write a long answer');
  await page.getByRole('button', { name: 'Send' }).click();

  const log = page.getByRole('log');
  await expect
    .poll(() => log.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(200);

  // Scroll up: the button is meant to appear here.
  await log.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toBeVisible();

  // Start a new chat WITHOUT scrolling back down first.
  await page.locator('aside').getByRole('button', { name: 'New chat' }).click();

  // Nothing to jump to any more, so nothing to offer.
  await expect(page.getByRole('button', { name: 'Jump to latest' })).toHaveCount(0);
});
