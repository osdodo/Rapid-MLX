import { test, expect } from '@playwright/test';
import { startStub } from './stub-server';

/**
 * Probes the COMPUTED palette, not class names.
 *
 * The tokens are wired through three layers (tokens.css `--background` ->
 * tailwind.css `@theme inline` -> a `bg-background` utility), and a mistake at
 * any one of them still typechecks, still lints, and still passes every unit
 * test. Only a real browser resolves the chain.
 */
test('shadcn neutral tokens resolve, and the dark variant flips them', async ({ page }) => {
  const stub = await startStub({});
  try {
    await page.goto(stub.baseURL);
    await expect(page.getByLabel('Message')).toBeVisible();

    const read = () =>
      page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const composer = document.querySelector('textarea[aria-label="Message"]')!;
        return {
          background: style.getPropertyValue('--background').trim(),
          primary: style.getPropertyValue('--primary').trim(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
          composerColor: getComputedStyle(composer).color,
        };
      });

    const light = await read();
    expect(light.background).toBe('oklch(1 0 0)');
    // Lightness only — the minifier drops the leading zero (`.205`), and the
    // hue/chroma are zero for every neutral token anyway.
    expect(lightnessOf(light.primary)).toBeCloseTo(0.205, 3);

    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    const dark = await read();
    expect(lightnessOf(dark.background)).toBeCloseTo(0.145, 3);
    // The whole point of the flip: near-black primary becomes near-white.
    expect(lightnessOf(dark.primary)).toBeCloseTo(0.922, 3);
    expect(dark.bodyBg).not.toBe(light.bodyBg);
    expect(dark.composerColor).not.toBe(light.composerColor);
  } finally {
    await stub.close();
  }
});

function lightnessOf(token: string): number {
  const match = /^oklch\(\s*([\d.]+)/.exec(token);
  if (!match?.[1]) throw new Error(`not an oklch token: ${token}`);
  return Number(match[1]);
}

/**
 * shadcn's component source styles a good deal of its dark appearance with
 * `dark:` utilities rather than with tokens — `dark:bg-input/30` on the
 * inputs, `dark:hover:bg-accent/50` on the ghost button. The palette flips on
 * TWO conditions here (an explicit attribute, and the OS preference when the
 * user has not chosen), so the variant has to cover both or those utilities
 * silently stay on their light values under a dark OS while everything around
 * them goes dark.
 */
test('the dark: variant fires on the OS preference, not only the attribute', async ({ page }) => {
  const stub = await startStub({});
  try {
    // A REAL element, not an injected probe div: Tailwind generates utilities
    // on demand by scanning the source, so a class invented in the test is
    // never in the bundle and would read as "the variant does not work".
    // The outline button carries `dark:bg-input/30`.
    const newChat = page.getByRole('button', { name: 'New chat' });
    const background = () =>
      newChat.evaluate((element) => getComputedStyle(element).backgroundColor);

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(stub.baseURL);
    await expect(newChat).toBeVisible();
    const light = await background();

    // No attribute set — this is the OS branch alone.
    await page.emulateMedia({ colorScheme: 'dark' });
    const osDark = await background();
    expect(osDark).not.toBe(light);

    // And an explicit light choice must survive a dark OS.
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
    expect(await background()).toBe(light);

    // The attribute branch on its own, under a light OS.
    await page.emulateMedia({ colorScheme: 'light' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    expect(await background()).toBe(osDark);
  } finally {
    await stub.close();
  }
});
