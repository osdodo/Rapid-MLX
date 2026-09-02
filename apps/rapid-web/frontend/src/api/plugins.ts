import { requestJson } from './client';
import type { ToolDefinition } from './chat';

/**
 * Plugins: pip-installed Python packages that contribute tools to this server.
 *
 * Kept off `/api/tools` because that response is cached for the page's whole
 * lifetime — the built-in catalogue is constant for the process, whereas every
 * switch here changes at runtime from the settings panel.
 *
 * Every mutating call answers the WHOLE snapshot rather than an
 * acknowledgement, so the panel cannot render a switch it just flipped beside
 * a tool list from before it.
 */

/** One declared setting, rendered generically by the panel. */
export interface PluginConfigField {
  key: string;
  label: string;
  kind: 'string' | 'secret' | 'number' | 'boolean' | 'enum';
  required: boolean;
  help: string;
  placeholder: string;
  choices?: { value: string; label: string }[];
  /** Absent for a secret — see `has_value`. */
  value?: unknown;
  /**
   * Whether a secret is stored. A secret NEVER travels back, not even masked:
   * a mask the form could round-trip becomes the stored value the first time
   * someone forgets to strip it.
   */
  has_value?: boolean;
}

export interface PluginToolInfo {
  /** Namespaced `plugin__tool`. */
  name: string;
  /** The tool half, for display where the group already names the plugin. */
  short: string;
  /**
   * What to call this tool on the settings screen.
   *
   * Resolved by the server, which falls back to the bare name — so this is
   * always something true, and the page needs no fallback of its own.
   */
  title: string;
  description: string;
  parameters: unknown;
  requires_approval: boolean;
  enabled: boolean;
}

export interface PluginInfo {
  name: string;
  title: string;
  description: string;
  version: string;
  /** Off by default. A plugin is Python running in this process. */
  enabled: boolean;
  /** Every required setting has a value. False means its tools will refuse. */
  config_complete: boolean;
  has_router: boolean;
  tools: PluginToolInfo[];
  config: PluginConfigField[];
}

export interface PluginLoadError {
  /** The entry point's name — a plugin that failed to import has no title. */
  name: string;
  message: string;
}

export interface PluginState {
  plugins: PluginInfo[];
  load_errors: PluginLoadError[];
  granted_tools: string[];
  disabled_tools: string[];
}

export function fetchPlugins(): Promise<PluginState> {
  return requestJson<PluginState>('/api/plugins');
}

/** The switches. Every field is optional; only what is sent is changed. */
export function updatePluginSettings(patch: {
  plugin?: string;
  enabled?: boolean;
  tool?: string;
  tool_enabled?: boolean;
  grant?: boolean;
  reset_grants?: boolean;
  config?: Record<string, unknown>;
}): Promise<PluginState> {
  return requestJson<PluginState>('/api/plugins/settings', {
    method: 'POST',
    body: patch,
  });
}

/** A plugin tool in the shape the chat request body takes. */
export function pluginToolDefinition(tool: PluginToolInfo): ToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      // The plugin owns the schema; the server already refused any that is not
      // a JSON Schema object, because the engine rejects the whole tools array
      // over one malformed entry.
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  };
}
