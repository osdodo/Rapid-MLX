import { expect, test } from '@playwright/test';
import { startStub, toolCallFrames } from './stub-server';

/**
 * Plugin tools in the chat loop.
 *
 * A plugin is a pip-installed package that contributes tools to the server.
 * The gate logic is covered far more cheaply in unit tests; what only a
 * browser can prove is that a plugin tool crosses the same round trip a
 * built-in does — advertised on the request, dispatched to `/api/tools/call`,
 * rendered in a chip — and that its approval prompt reaches the screen.
 */

const READY = { engineState: 'ready' as const, model: 'qwen3-4b' };

function pluginState(overrides: { requiresApproval?: boolean } = {}) {
  return {
    plugins: [
      {
        name: 'demo',
        title: 'Demo',
        description: 'A plugin.',
        version: '1.0.0',
        enabled: true,
        config_complete: true,
        has_router: false,
        tools: [
          {
            name: 'demo__echo',
            short: 'echo',
            title: 'Echo',
            description: 'Echo the text back.',
            parameters: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
            requires_approval: overrides.requiresApproval ?? false,
            enabled: true,
          },
        ],
        config: [],
      },
    ],
    load_errors: [],
    granted_tools: [],
    disabled_tools: [],
  };
}

async function send(page: import('@playwright/test').Page, text: string) {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send' }).click();
}

test('a plugin tool is advertised, runs, and its answer informs the reply', async ({ page }) => {
  const stub = await startStub({
    ...READY,
    plugins: pluginState(),
    chatFrames: [
      toolCallFrames([{ id: 'call_1', name: 'demo__echo', arguments: '{"text":"hi"}' }]),
      [`data: ${JSON.stringify({ choices: [{ delta: { content: 'It said >> hi.' } }] })}\n\n`],
    ],
    toolResults: { demo__echo: { content: '>> hi' } },
  });
  try {
    await page.goto(stub.baseURL);
    await send(page, 'echo hi');

    await expect(page.getByText('It said >> hi.')).toBeVisible();

    // The chip shows the NAMESPACED name, which is what the model emitted and
    // what the request body carried.
    const chip = page.getByText('demo__echo', { exact: true }).first();
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page.getByText('>> hi', { exact: true })).toBeVisible();

    // Dispatched through the shared tool route, not a plugin-specific one —
    // that route is where the `advertised` gate lives.
    expect(stub.scenario.toolCalls).toHaveLength(1);
    expect(stub.scenario.toolCalls[0]?.name).toBe('demo__echo');

    const advertised = (
      stub.scenario.chatRequests[0]?.tools as Array<{ function: { name: string } }>
    ).map((tool) => tool.function.name);
    expect(advertised).toContain('demo__echo');
    // Beside the built-ins rather than instead of them.
    expect(advertised).toContain('weather');
  } finally {
    await stub.close();
  }
});

test('an approval-required plugin tool prompts, and Always allow persists', async ({ page }) => {
  const stub = await startStub({
    ...READY,
    plugins: pluginState({ requiresApproval: true }),
    chatFrames: [
      toolCallFrames([{ id: 'call_1', name: 'demo__echo', arguments: '{"text":"hi"}' }]),
      [`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done.' } }] })}\n\n`],
    ],
    toolResults: { demo__echo: { content: '>> hi' } },
  });
  try {
    await page.goto(stub.baseURL);
    await send(page, 'echo hi');

    // Named by its short name and by where it came from: "run echo?" is
    // unanswerable without knowing whose.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Run echo?');
    await expect(dialog).toContainText('Demo');

    // Nothing ran while the prompt was open.
    expect(stub.scenario.toolCalls).toHaveLength(0);

    await page.getByRole('button', { name: 'Always allow' }).click();

    await expect(page.getByText('Done.')).toBeVisible();
    expect(stub.scenario.toolCalls[0]?.name).toBe('demo__echo');

    // The grant is written through, so the next turn does not ask again.
    expect(stub.scenario.pluginPatches).toContainEqual({
      tool: 'demo__echo',
      grant: true,
    });
  } finally {
    await stub.close();
  }
});

test('declining a plugin tool tells the model rather than failing silently', async ({ page }) => {
  const stub = await startStub({
    ...READY,
    plugins: pluginState({ requiresApproval: true }),
    chatFrames: [
      toolCallFrames([{ id: 'call_1', name: 'demo__echo', arguments: '{"text":"hi"}' }]),
      [`data: ${JSON.stringify({ choices: [{ delta: { content: 'Understood.' } }] })}\n\n`],
    ],
  });
  try {
    await page.goto(stub.baseURL);
    await send(page, 'echo hi');

    await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: "Don't allow" }).click();

    await expect(page.getByText('Understood.')).toBeVisible();

    // The turn continues with a result row saying why, rather than leaving
    // the call unanswered — the wire shape needs one result per call id.
    expect(stub.scenario.toolCalls).toHaveLength(0);
    const followUp = stub.scenario.chatRequests[1]?.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(followUp.some((turn) => turn.role === 'tool' && turn.content.includes('declined'))).toBe(
      true,
    );
  } finally {
    await stub.close();
  }
});
