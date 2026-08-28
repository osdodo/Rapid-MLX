import { expect, test } from '@playwright/test';
import { startStub } from './stub-server';

/**
 * The brand mark in the sidebar header.
 *
 * The geometry is copied verbatim from `RapidRMark.swift`, so the risk here is
 * not "is the path right" — it is the two ways an inlined SVG silently fails:
 * it renders at zero size, or it does not follow the theme and becomes an
 * invisible black shape on a dark surface. Both are measured rather than
 * asserted from class names.
 */

test('the mark renders at a real size beside the wordmark', async ({ page }) => {
  const stub = await startStub({});
  try {
    await page.goto(stub.baseURL);
    await expect(page.getByLabel('Message')).toBeVisible();
    await page.getByLabel('Open sidebar').click();

    const box = await page.locator('svg[viewBox="0 0 192 192"]').first().boundingBox();
    expect(box).not.toBeNull();
    // An SVG with no intrinsic size collapses; `em` sizing off the wordmark
    // should put this in the high-teens at the header's `text-lg`.
    expect(box!.width).toBeGreaterThan(12);
    expect(box!.height).toBeGreaterThan(12);
  } finally {
    await stub.close();
  }
});

test('the mark follows the theme rather than staying black', async ({ page }) => {
  const stub = await startStub({});
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(stub.baseURL);
    await expect(page.getByLabel('Message')).toBeVisible();
    await page.getByLabel('Open sidebar').click();

    const mark = page.locator('svg[viewBox="0 0 192 192"]').first();
    // `fill="currentColor"`, so the computed FILL is what matters — reading
    // `color` would pass even if the fill had been hard-coded.
    const fill = () => mark.evaluate((element) => getComputedStyle(element).fill);

    const light = await fill();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await fill();

    // Ink on a dark surface must not stay ink. The SVG's white background
    // `<rect>` is deliberately not reproduced for the same reason: it would be
    // a white tile in dark mode.
    expect(dark).not.toBe(light);
  } finally {
    await stub.close();
  }
});

test('the mark is decorative, so the product is announced once', async ({ page }) => {
  const stub = await startStub({});
  try {
    await page.goto(stub.baseURL);
    await expect(page.getByLabel('Message')).toBeVisible();
    await page.getByLabel('Open sidebar').click();

    // The wordmark beside it already carries the name; an unhidden mark would
    // have a screen reader read the product twice in a row.
    const hidden = await page
      .locator('svg[viewBox="0 0 192 192"]')
      .first()
      .getAttribute('aria-hidden');
    expect(hidden).toBe('true');
  } finally {
    await stub.close();
  }
});

/**
 * The sheet chrome, shared by every modal window (Model, Settings).
 *
 * Two things a class-name grep cannot check: that the close control is an icon
 * with an accessible name rather than the word "Done", and that two sheets
 * opened one after the other are the SAME size. The latter used to be a
 * `max-h`, so each sized to its own content — Settings ran to 630px while the
 * model picker sat at 259px, and switching between them made the dialog jump.
 */
test.describe('sheet chrome', () => {
  test.use({ viewport: { width: 1100, height: 900 }, hasTouch: false, isMobile: false });

  test('closes with an icon that still has an accessible name', async ({ page }) => {
    const stub = await startStub({ engineState: 'ready', model: 'qwen3-4b' });
    try {
      await page.goto(stub.baseURL);
      await expect(page.getByLabel('Message')).toBeVisible();
      await page.getByRole('button', { name: /^qwen3-4b/ }).first().click();

      const sheet = page.getByRole('dialog', { name: 'Model' });
      await expect(sheet).toBeVisible();
      // No visible "Done" text, but the control is still reachable by name.
      await expect(sheet.getByText('Done', { exact: true })).toHaveCount(0);
      const close = sheet.getByRole('button', { name: 'Close' });
      await expect(close).toBeVisible();

      await close.click();
      await expect(sheet).toBeHidden();
    } finally {
      await stub.close();
    }
  });

  test('every sheet is the same size on a desktop window', async ({ page }) => {
    const stub = await startStub({ engineState: 'ready', model: 'qwen3-4b' });
    try {
      await page.goto(stub.baseURL);
      await expect(page.getByLabel('Message')).toBeVisible();

      // The sheet zooms in, so a box read the instant it becomes visible is a
      // mid-animation value (measured 611.5 vs 608.9 for two sheets that both
      // settle at exactly the same size). Wait for it to stop changing.
      const settledBox = async (name: string) => {
        const dialog = page.getByRole('dialog', { name });
        await expect(dialog).toBeVisible();
        let last = -1;
        await expect
          .poll(async () => {
            const width = (await dialog.boundingBox())?.width ?? 0;
            const stable = width === last;
            last = width;
            return stable;
          })
          .toBe(true);
        return dialog.boundingBox();
      };

      await page.getByRole('button', { name: /^qwen3-4b/ }).first().click();
      const model = await settledBox('Model');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Model' })).toBeHidden();

      await page.getByRole('button', { name: 'Settings' }).click();
      const settings = await settledBox('Settings');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();

      // The search palette is built on `CommandDialog`, NOT on `Sheet`, so it
      // is the one most likely to drift — it shipped at 512 x 310 against the
      // sheets' 640 x 720. It shares the size through `SHEET_DESKTOP_SIZE`.
      await page.getByRole('button', { name: 'Search conversations' }).click();
      const search = await settledBox('Search conversations');

      expect(model).not.toBeNull();
      for (const [label, box] of [
        ['settings', settings],
        ['search', search],
      ] as const) {
        expect(box, label).not.toBeNull();
        expect(box!.width, label).toBe(model!.width);
        expect(box!.height, label).toBe(model!.height);
      }
    } finally {
      await stub.close();
    }
  });

  test('the model picker has no Refresh button', async ({ page }) => {
    const stub = await startStub({ engineState: 'ready', model: 'qwen3-4b' });
    try {
      await page.goto(stub.baseURL);
      await expect(page.getByLabel('Message')).toBeVisible();
      await page.getByRole('button', { name: /^qwen3-4b/ }).first().click();

      const sheet = page.getByRole('dialog', { name: 'Model' });
      await expect(sheet).toBeVisible();
      // Opening the sheet forces a catalog re-read instead, so the button was
      // a manual step for something that now happens on its own.
      await expect(sheet.getByRole('button', { name: /Refresh/ })).toHaveCount(0);
    } finally {
      await stub.close();
    }
  });

  test('a phone still gets a content-sized bottom sheet', async ({ page }) => {
    // The fixed height is `sm:`-scoped. Applied unconditionally it would push
    // a two-row picker up over most of a phone screen.
    await page.setViewportSize({ width: 390, height: 664 });
    const stub = await startStub({ engineState: 'ready', model: 'qwen3-4b' });
    try {
      await page.goto(stub.baseURL);
      await expect(page.getByLabel('Message')).toBeVisible();
      await page.getByLabel('Open sidebar').click();
      await page.getByRole('button', { name: /^qwen3-4b/ }).first().click();

      const box = await page.getByRole('dialog', { name: 'Model' }).boundingBox();
      expect(box).not.toBeNull();
      // Full-bleed and short — not the desktop's 720px block.
      expect(box!.width).toBe(390);
      expect(box!.height).toBeLessThan(500);
    } finally {
      await stub.close();
    }
  });
});
