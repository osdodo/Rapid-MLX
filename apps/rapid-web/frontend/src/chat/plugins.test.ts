import { describe, expect, it } from 'vitest';
import type { PluginInfo, PluginState, PluginToolInfo } from '@/api/plugins';
import type { ToolCall, ToolDefinition } from '@/api/chat';
import {
  advertisedPluginTools,
  approvalRequest,
  gatePluginCall,
  isPluginTool,
  type PluginGate,
} from './plugins';
import { withoutShadowedTools } from './turn';

function tool(patch: Partial<PluginToolInfo> = {}): PluginToolInfo {
  return {
    name: 'demo__echo',
    short: 'echo',
    title: 'Echo',
    description: 'Echo the text back.',
    parameters: { type: 'object', properties: {} },
    requires_approval: false,
    enabled: true,
    ...patch,
  };
}

function plugin(patch: Partial<PluginInfo> = {}): PluginInfo {
  return {
    name: 'demo',
    title: 'Demo',
    description: 'A plugin.',
    version: '1.0.0',
    enabled: true,
    config_complete: true,
    has_router: false,
    tools: [tool()],
    config: [],
    ...patch,
  };
}

function state(patch: Partial<PluginState> = {}): PluginState {
  return {
    plugins: [plugin()],
    load_errors: [],
    granted_tools: [],
    disabled_tools: [],
    ...patch,
  };
}

function call(name = 'demo__echo', args = '{}'): ToolCall {
  return { id: 'call_1', type: 'function', function: { name, arguments: args } };
}

function definition(name: string): ToolDefinition {
  return { type: 'function', function: { name, description: '', parameters: {} } };
}

function approve(gate: PluginGate) {
  if (gate.kind !== 'approve') throw new Error(`expected approve, got ${gate.kind}`);
  return gate;
}

describe('advertisedPluginTools', () => {
  it('offers an enabled, configured plugin', () => {
    expect(advertisedPluginTools(state()).map((t) => t.function.name)).toEqual(['demo__echo']);
  });

  it('offers nothing without a state', () => {
    expect(advertisedPluginTools(null)).toEqual([]);
  });

  it('withholds a disabled plugin even though the snapshot still lists it', () => {
    // The snapshot names every INSTALLED plugin so the panel can offer the
    // switch, so "off" cannot be inferred from an empty tool list.
    expect(advertisedPluginTools(state({ plugins: [plugin({ enabled: false })] }))).toEqual([]);
  });

  it('withholds a plugin whose required settings are blank', () => {
    // Its tools would only refuse, and advertising one that cannot run
    // teaches the model to keep trying it.
    expect(
      advertisedPluginTools(state({ plugins: [plugin({ config_complete: false })] })),
    ).toEqual([]);
  });

  it('withholds one switched-off tool while keeping its siblings', () => {
    const state_ = state({
      plugins: [plugin({ tools: [tool(), tool({ name: 'demo__other', enabled: false })] })],
    });

    expect(advertisedPluginTools(state_).map((t) => t.function.name)).toEqual(['demo__echo']);
  });

  it('substitutes a legal schema for an absent one', () => {
    // The engine rejects the whole tools array over one malformed entry.
    const state_ = state({ plugins: [plugin({ tools: [tool({ parameters: null })] })] });

    expect(advertisedPluginTools(state_)[0]?.function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('isPluginTool', () => {
  it('claims a tool this state knows', () => {
    expect(isPluginTool(state(), 'demo__echo')).toBe(true);
  });

  it('claims a switched-off tool too', () => {
    // So the call reaches the plugin refusal, which names the switch, rather
    // than the built-in path's "unknown tool".
    const off = state({ plugins: [plugin({ enabled: false })] });

    expect(isPluginTool(off, 'demo__echo')).toBe(true);
  });

  it('does not claim a name it has never seen', () => {
    expect(isPluginTool(state(), 'weather')).toBe(false);
    expect(isPluginTool(null, 'demo__echo')).toBe(false);
  });
});

describe('gatePluginCall', () => {
  it('runs an enabled tool that needs no approval', () => {
    expect(gatePluginCall(call(), state())).toEqual({ kind: 'run' });
  });

  it('refuses a name nothing provides', () => {
    const gate = gatePluginCall(call('ghost'), state());

    expect(gate.kind).toBe('refuse');
  });

  it('refuses when the plugin is off, naming the plugin', () => {
    const gate = gatePluginCall(call(), state({ plugins: [plugin({ enabled: false })] }));

    expect(gate).toMatchObject({ kind: 'refuse' });
    expect(gate.kind === 'refuse' && gate.reason).toContain('Demo');
  });

  it('refuses when the tool alone is off', () => {
    const off = state({ plugins: [plugin({ tools: [tool({ enabled: false })] })] });
    const gate = gatePluginCall(call(), off);

    expect(gate.kind === 'refuse' && gate.reason).toContain('turned off');
  });

  it('refuses when required settings are blank', () => {
    const gate = gatePluginCall(call(), state({ plugins: [plugin({ config_complete: false })] }));

    expect(gate.kind === 'refuse' && gate.reason).toContain('not configured');
  });

  it('asks for approval when the tool requires it', () => {
    const gated = state({ plugins: [plugin({ tools: [tool({ requires_approval: true })] })] });
    const gate = approve(gatePluginCall(call(), gated));

    expect(gate).toMatchObject({ tool: 'demo__echo', short: 'echo', source: 'Demo' });
  });

  it('does not ask again once the tool is granted', () => {
    const gated = state({
      plugins: [plugin({ tools: [tool({ requires_approval: true })] })],
      granted_tools: ['demo__echo'],
    });

    expect(gatePluginCall(call(), gated)).toEqual({ kind: 'run' });
  });

  it('passes the arguments through uncapped', () => {
    // The sheet scrolls. Truncating would let whatever is past the cutoff be
    // approved unseen, which is what the gate exists to prevent.
    const args = JSON.stringify({ text: 'x'.repeat(5000) });
    const gated = state({ plugins: [plugin({ tools: [tool({ requires_approval: true })] })] });
    const gate = approve(gatePluginCall(call('demo__echo', args), gated));

    expect(gate.args).toBe(args);
  });

  it('refuses everything without a state', () => {
    expect(gatePluginCall(call(), null).kind).toBe('refuse');
  });
});

describe('approvalRequest', () => {
  it('escapes every plugin-supplied field', () => {
    // A pip package words this dialog: a bidi override in a title or tool
    // name can make the prompt read as something the user trusts.
    const gated = state({
      plugins: [
        plugin({
          title: 'Ev\u202eli',
          tools: [tool({ name: 'demo__ec\u200bho', short: 'ec\u200bho', requires_approval: true })],
        }),
      ],
    });
    const request = approvalRequest(approve(gatePluginCall(call('demo__ec\u200bho'), gated)));

    expect(request.kind).toBe('tool');
    expect(request.server).not.toContain('\u202e');
    expect(request.tool).not.toContain('\u200b');
    expect(request.short).not.toContain('\u200b');
  });

  it('escapes the newlines pretty-printing introduced', () => {
    // Approval metadata keeps the STRICT policy — every control character
    // escaped, because a forged line break could disguise what is being
    // approved. Identical to the connector prompt, which escapes the same
    // way. The dialog therefore shows one long line, not indented JSON.
    const gated = state({ plugins: [plugin({ tools: [tool({ requires_approval: true })] })] });
    const gate = approve(gatePluginCall(call('demo__echo', '{"text":"hi"}'), gated));

    expect(approvalRequest(gate).args).toBe('{\\u{A}  "text": "hi"\\u{A}}');
  });

  it('escapes a forged line break in the arguments', () => {
    // Approval metadata keeps the strict policy: a forged break could
    // disguise what is being approved.
    const gated = state({ plugins: [plugin({ tools: [tool({ requires_approval: true })] })] });
    const gate = approve(gatePluginCall(call('demo__echo', 'not json\u2028here'), gated));

    expect(approvalRequest(gate).args).not.toContain('\u2028');
  });
});

describe('withoutShadowedTools', () => {
  it('keeps the first of two entries with the same name', () => {
    // Precedence is the caller's array order: built-in, then plugin, then
    // connector.
    const kept = withoutShadowedTools([
      { ...definition('jira__search'), function: { name: 'jira__search', description: 'plugin', parameters: {} } },
      { ...definition('jira__search'), function: { name: 'jira__search', description: 'connector', parameters: {} } },
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]?.function.description).toBe('plugin');
  });

  it('drops the loser entirely rather than shadowing it', () => {
    // Advertising two entries that resolve to one implementation is how
    // someone ends up debugging a tool that "runs but returns the wrong
    // thing", and the engine would also see a duplicate function name.
    const names = withoutShadowedTools([
      definition('weather'),
      definition('demo__echo'),
      definition('weather'),
    ]).map((t) => t.function.name);

    expect(names).toEqual(['weather', 'demo__echo']);
    expect(names.filter((name) => name === 'weather')).toHaveLength(1);
  });

  it('leaves a list with no collisions alone', () => {
    const all = [definition('weather'), definition('demo__echo'), definition('fs__read')];

    expect(withoutShadowedTools(all)).toEqual(all);
  });

  it('handles an empty list', () => {
    expect(withoutShadowedTools([])).toEqual([]);
  });
});
