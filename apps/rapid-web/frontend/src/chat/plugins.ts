import {
  fetchPlugins,
  pluginToolDefinition,
  type PluginInfo,
  type PluginState,
} from '@/api/plugins';
import type { ToolCall, ToolDefinition } from '@/api/chat';
import { displaySafe, formatArguments, shortToolName } from './connectors';

/**
 * Plugin tools in the chat loop.
 *
 * A plugin is a pip-installed Python package running IN the server process, so
 * everything it supplies — tool names, descriptions, titles — is third-party
 * text that reaches an approval prompt. It goes through `displaySafe` for the
 * same reason connector strings do, and with more at stake: the user chose to
 * install the package, but not to have it word the dialog they are answering.
 *
 * Policy is separated from execution so the gate is testable without a stream,
 * matching `chat/tools.ts` and `chat/connectors.ts`.
 */

/**
 * What the model may be shown this round.
 *
 * Nothing from a disabled plugin even though the state still carries its
 * tools: the snapshot lists every INSTALLED plugin so the panel can offer the
 * switch, so "off" has to be enforced here rather than inferred from an empty
 * list. A plugin whose required settings are blank is also withheld — its
 * tools would only refuse, and advertising a tool that cannot run teaches the
 * model to keep trying it.
 */
export function advertisedPluginTools(state: PluginState | null): ToolDefinition[] {
  if (state === null) return [];
  return state.plugins
    .filter((plugin) => plugin.enabled && plugin.config_complete)
    .flatMap((plugin) => plugin.tools.filter((tool) => tool.enabled))
    .map(pluginToolDefinition);
}

/**
 * Whether `name` is a plugin tool.
 *
 * Checks every installed plugin, ignoring the switches, so a call to a
 * switched-off tool reaches the plugin refusal — which names the switch —
 * rather than the built-in path's "unknown tool".
 */
export function isPluginTool(state: PluginState | null, name: string): boolean {
  return state !== null && findTool(state, name) !== null;
}

export type PluginGate =
  | { kind: 'run' }
  | { kind: 'approve'; tool: string; source: string; short: string; args: string }
  | { kind: 'refuse'; reason: string };

/**
 * Decide whether one plugin call may run.
 *
 * The switches are re-checked here as well as on the server. Leaving a tool
 * out of the request body does not stop a malformed model emitting a call for
 * it, and a local refusal costs no round trip.
 */
export function gatePluginCall(call: ToolCall, state: PluginState | null): PluginGate {
  const name = call.function.name;
  const found = state === null ? null : findTool(state, name);
  if (found === null) {
    return { kind: 'refuse', reason: `unknown tool '${name}'. Answer directly instead.` };
  }

  const { plugin, tool } = found;
  if (!plugin.enabled) {
    return {
      kind: 'refuse',
      reason: `The '${plugin.title}' plugin is turned off in Settings → Tools; '${name}' was not run.`,
    };
  }
  if (!tool.enabled) {
    return {
      kind: 'refuse',
      reason: `tool '${name}' is turned off in Settings → Tools and was not run.`,
    };
  }
  if (!plugin.config_complete) {
    return {
      kind: 'refuse',
      reason: `The '${plugin.title}' plugin is not configured yet; '${name}' was not run.`,
    };
  }
  if (!tool.requires_approval || state!.granted_tools.includes(name)) return { kind: 'run' };

  return {
    kind: 'approve',
    tool: name,
    source: plugin.title,
    short: shortToolName(name),
    // The FULL arguments, not a capped preview: the sheet scrolls, and
    // truncating would let whatever is past the cutoff be approved unseen.
    args: call.function.arguments,
  };
}

/** The approval prompt's fields, every one of them escaped. */
export function approvalRequest(gate: Extract<PluginGate, { kind: 'approve' }>) {
  return {
    kind: 'tool' as const,
    tool: displaySafe(gate.tool),
    server: displaySafe(gate.source),
    short: displaySafe(gate.short),
    args: displaySafe(formatArguments(gate.args)),
  };
}

function findTool(
  state: PluginState,
  name: string,
): { plugin: PluginInfo; tool: PluginInfo['tools'][number] } | null {
  for (const plugin of state.plugins) {
    const tool = plugin.tools.find((entry) => entry.name === name);
    if (tool !== undefined) return { plugin, tool };
  }
  return null;
}

/**
 * The plugin state a turn runs against.
 *
 * Fetched per turn rather than per page: a plugin can be enabled or configured
 * mid-session, and a page-lifetime cache would hide it from the model until a
 * reload.
 */
export async function loadPluginState(): Promise<PluginState | null> {
  try {
    return await fetchPlugins();
  } catch {
    // A server that cannot answer has no plugins to offer; the turn still runs
    // with the built-ins.
    return null;
  }
}
