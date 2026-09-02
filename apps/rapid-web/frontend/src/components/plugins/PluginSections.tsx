import { useEffect, useState } from 'react';
import { Puzzle, Wrench } from 'lucide-react';
import {
  fetchPlugins,
  updatePluginSettings,
  type PluginConfigField,
  type PluginInfo,
  type PluginState,
  type PluginToolInfo,
} from '@/api/plugins';
import { asApiError } from '@/api/errors';
import { displaySafe } from '@/chat/connectors';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { Segmented } from '../common/Segmented';
import {
  SettingsRow,
  SettingsRowDivider,
  SettingsSection,
} from '../common/SettingsSection';
import { Switch } from '../common/Switch';

/**
 * Settings → Tools, plugin half.
 *
 * One section per installed plugin rather than a page of its own: a plugin's
 * tools are tools, and splitting them from the built-ins would make "which
 * tools can the model use" a question with two answers in two places.
 *
 * Everything here is server state. Unlike the built-ins — whose switches live
 * in `settings.enabledTools` — plugin switches are NOT mirrored into
 * localStorage: that array is three hardcoded names with no migration, so a
 * plugin tool would default off there as well as on the server, which is a
 * double gate the user cannot reason about.
 */
export function PluginSections() {
  const [state, setState] = useState<PluginState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PluginInfo | null>(null);

  useEffect(() => {
    let live = true;
    fetchPlugins()
      .then((next) => live && setState(next))
      .catch(() => live && setState({ plugins: [], load_errors: [], granted_tools: [], disabled_tools: [] }));
    return () => {
      live = false;
    };
  }, []);

  const run = (patch: Parameters<typeof updatePluginSettings>[0]) => {
    setError(null);
    updatePluginSettings(patch)
      .then(setState)
      .catch((cause: unknown) => setError(asApiError(cause).message));
  };

  if (state === null) return null;
  if (state.plugins.length === 0 && state.load_errors.length === 0) return null;

  return (
    <>
      {state.load_errors.length > 0 ? (
        <SettingsSection title="Plugins that could not load">
          <div className="flex flex-col gap-2">
            {state.load_errors.map((entry, index) => (
              <p key={`${entry.name}-${index}`} className="text-muted-foreground m-0 text-xs">
                <span className="font-mono">{displaySafe(entry.name || '?')}</span>{' '}
                {displaySafe(entry.message)}
              </p>
            ))}
          </div>
        </SettingsSection>
      ) : null}

      {error ? (
        <p role="alert" className="bg-destructive/10 text-destructive m-0 rounded-lg px-4 py-3 text-xs">
          {error}
        </p>
      ) : null}

      {state.plugins.map((plugin) => (
        <PluginGroup
          key={plugin.name}
          plugin={plugin}
          granted={state.granted_tools}
          onEnable={(on) => (on ? setConfirming(plugin) : run({ plugin: plugin.name, enabled: false }))}
          onToolEnable={(tool, on) => run({ tool, tool_enabled: on })}
          onConfig={(config) => run({ plugin: plugin.name, config })}
        />
      ))}

      {/* The confirm is wired to the enable, not wrapped around it, so a
          cancelled dialog leaves the switch off rather than momentarily on. */}
      <ConfirmDialog
        open={confirming !== null}
        title={`Turn on ${confirming?.title ?? ''}?`}
        body={
          'A plugin is a Python package installed on this Mac. Its code runs inside ' +
          'this server, with the same access to your files, this access token and the ' +
          'network that rmlx-web itself has. Only turn on plugins you installed ' +
          'yourself and trust.'
        }
        confirmLabel="Turn on"
        onConfirm={() => {
          if (confirming) run({ plugin: confirming.name, enabled: true });
          setConfirming(null);
        }}
        onCancel={() => setConfirming(null)}
      />
    </>
  );
}

function PluginGroup({
  plugin,
  granted,
  onEnable,
  onToolEnable,
  onConfig,
}: {
  plugin: PluginInfo;
  granted: string[];
  onEnable(next: boolean): void;
  onToolEnable(tool: string, next: boolean): void;
  onConfig(config: Record<string, unknown>): void;
}) {
  const version = plugin.version ? ` ${plugin.version}` : '';
  const subtitle = displaySafe(plugin.description);

  return (
    <SettingsSection
      title={displaySafe(plugin.title)}
      // Omitted rather than passed as undefined: `exactOptionalPropertyTypes`.
      {...(subtitle ? { subtitle } : {})}
    >
      <SettingsRow
        title="Enable this plugin"
        description={`${displaySafe(plugin.name)}${version} — Python running inside this server.`}
        control={
          <Switch
            label={`Enable ${plugin.title}`}
            checked={plugin.enabled}
            onChange={onEnable}
          />
        }
      />

      {plugin.enabled && !plugin.config_complete ? (
        <>
          <SettingsRowDivider />
          <p role="status" className="bg-warning/10 m-0 rounded-md px-3 py-2 text-xs">
            Fill in the required settings below — until then this plugin's tools are not
            offered to the model.
          </p>
        </>
      ) : null}

      {plugin.enabled && plugin.config.length > 0 ? (
        <>
          <SettingsRowDivider />
          <ConfigForm fields={plugin.config} onSave={onConfig} />
        </>
      ) : null}

      {plugin.enabled && plugin.tools.length > 0 ? (
        <>
          <SettingsRowDivider />
          <div className="flex flex-col gap-4">
            {plugin.tools.map((tool) => (
              <PluginToolRow
                key={tool.name}
                tool={tool}
                granted={granted.includes(tool.name)}
                onChange={(on) => onToolEnable(tool.name, on)}
              />
            ))}
          </div>
        </>
      ) : null}
    </SettingsSection>
  );
}

/**
 * One tool: switch, human name, and the wire identifier on request.
 *
 * Leads with the TITLE rather than the identifier, matching the built-in
 * rows. `mine__search` in a monospaced face is an implementation detail
 * presented as a heading, and the description under it is written for the
 * MODEL — it carries calling conventions, so it reads as documentation. Both
 * stay available, behind a disclosure, because someone debugging a prompt
 * needs them.
 */
function PluginToolRow({
  tool,
  granted,
  onChange,
}: {
  tool: PluginToolInfo;
  granted: boolean;
  onChange(next: boolean): void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Wrench className="text-muted-foreground mt-px size-4 shrink-0" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-sm leading-none font-medium">{displaySafe(tool.title)}</span>
            {tool.requires_approval ? (
              <span className="text-muted-foreground text-xs">
                {granted ? 'Always allowed' : 'You approve each call'}
              </span>
            ) : null}
          </div>
        </div>
        <Switch label={tool.name} checked={tool.enabled} onChange={onChange} />
      </div>

      {/* Indented to the text column, so it lines up under what it expands. */}
      <details className="pl-[26px]">
        <summary className="text-muted-foreground w-fit cursor-pointer text-xs">Details</summary>
        <div className="bg-muted/50 mt-1.5 flex flex-col gap-1.5 rounded-md p-3">
          {/* Exactly the string the model receives. */}
          <p className="text-muted-foreground m-0 text-xs">{displaySafe(tool.description)}</p>
          <code className="text-muted-foreground/70 text-[11px]">{displaySafe(tool.name)}</code>
        </div>
      </details>
    </div>
  );
}

/**
 * The generic settings form, rendered from what the plugin declared.
 *
 * Held as a local draft with an explicit Save rather than saving per
 * keystroke: a partially typed API key is not a value worth writing to disk,
 * and every write is a whole-document rewrite.
 *
 * A secret starts EMPTY even when one is stored, because the server never
 * sends it back. An untouched secret field is omitted from the patch, which
 * the server reads as "leave unchanged"; clearing it explicitly sends "".
 */
function ConfigForm({
  fields,
  onSave,
}: {
  fields: PluginConfigField[];
  onSave(config: Record<string, unknown>): void;
}) {
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const valueOf = (field: PluginConfigField): unknown =>
    field.key in draft ? draft[field.key] : field.kind === 'secret' ? '' : field.value;

  const set = (key: string, value: unknown) => setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex flex-col gap-4">
      {fields.map((field) => (
        <div key={field.key} className="flex flex-col gap-1.5">
          <label htmlFor={`plugin-${field.key}`} className="text-sm leading-none font-medium">
            {displaySafe(field.label)}
            {field.required ? <span className="text-muted-foreground"> (required)</span> : null}
          </label>
          <FieldControl field={field} value={valueOf(field)} onChange={(v) => set(field.key, v)} />
          {field.help ? (
            <p className="text-muted-foreground m-0 text-xs">{displaySafe(field.help)}</p>
          ) : null}
          {field.kind === 'secret' ? (
            <p className="text-muted-foreground m-0 text-[11px]">
              {field.has_value
                ? 'A value is saved. Type to replace it, or leave blank to keep it.'
                : 'Not set.'}
            </p>
          ) : null}
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="outline"
          disabled={Object.keys(draft).length === 0}
          onClick={() => {
            onSave(draft);
            setDraft({});
          }}
        >
          Save settings
        </Button>
      </div>
    </div>
  );
}

function FieldControl({
  field,
  value,
  onChange,
}: {
  field: PluginConfigField;
  value: unknown;
  onChange(next: unknown): void;
}) {
  const id = `plugin-${field.key}`;

  if (field.kind === 'boolean') {
    return (
      <Switch label={field.label} checked={value === true} onChange={onChange} />
    );
  }

  if (field.kind === 'enum') {
    const choices = field.choices ?? [];
    // Segmented above three options stops being scannable and starts
    // overflowing a phone-width panel.
    if (choices.length <= 3) {
      return (
        <Segmented
          label={field.label}
          value={typeof value === 'string' ? value : (choices[0]?.value ?? '')}
          options={choices.map((choice) => ({ value: choice.value, label: choice.label }))}
          onChange={onChange}
        />
      );
    }
    return (
      <select
        id={id}
        className={cn(
          'border-input focus-visible:border-ring h-9 w-full rounded-md border bg-transparent px-3',
          'text-base outline-none md:text-sm',
        )}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {choices.map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.kind === 'number') {
    return (
      <Input
        id={id}
        type="number"
        value={typeof value === 'number' ? String(value) : ''}
        placeholder={field.placeholder}
        onChange={(event) => {
          const next = event.target.value;
          // An empty box is not zero. Sending 0 for a cleared field would
          // silently set a real value the user did not choose.
          onChange(next === '' ? null : Number(next));
        }}
      />
    );
  }

  return (
    <Input
      id={id}
      type={field.kind === 'secret' ? 'password' : 'text'}
      value={typeof value === 'string' ? value : ''}
      placeholder={field.placeholder}
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** The icon the Tools panel puts beside the plugin block. */
export const PluginIcon = Puzzle;
