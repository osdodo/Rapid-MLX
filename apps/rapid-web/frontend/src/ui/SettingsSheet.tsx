import { useStore } from '../state/store';
import type { Settings } from '../state/types';
import { Sheet } from './Sheet';
import { Segmented } from './primitives/Segmented';
import { Slider } from './primitives/Slider';

export function SettingsSheet({
  open,
  onClose,
  engineInfo,
}: {
  open: boolean;
  onClose(): void;
  engineInfo: string;
}) {
  const settings = useStore((state) => state.settings);
  const update = useStore((state) => state.updateSettings);

  return (
    <Sheet open={open} onClose={onClose} title="Settings">
      <div className="flex flex-col gap-5 px-4 pt-3.5 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <Field
          label="System prompt"
          hint="Prepended to every turn, in this browser only."
          control={
            <textarea
              id="system"
              className="border-line bg-card focus:border-brand w-full resize-y rounded-md border px-3 py-2.5 leading-normal"
              value={settings.system}
              onChange={(event) => update({ system: event.target.value })}
              placeholder="You are a helpful assistant."
              rows={3}
            />
          }
        />

        <SliderField
          id="temperature"
          label="Temperature"
          hint="Lower is more deterministic; higher is more varied."
          value={settings.temperature}
          min={0}
          max={2}
          step={0.05}
          format={(value) => value.toFixed(2)}
          onChange={(temperature) => update({ temperature })}
        />

        <SliderField
          id="top-p"
          label="Top P"
          hint="Nucleus sampling cutoff."
          value={settings.topP}
          min={0.05}
          max={1}
          step={0.05}
          format={(value) => value.toFixed(2)}
          onChange={(topP) => update({ topP })}
        />

        <SliderField
          id="max-tokens"
          label="Max tokens"
          hint="Upper bound on the length of a single reply."
          value={settings.maxTokens}
          min={256}
          max={16384}
          step={256}
          format={(value) => String(value)}
          onChange={(maxTokens) => update({ maxTokens })}
        />

        <Field
          label="Appearance"
          hint="Auto follows your device's light or dark setting."
          control={
            <Segmented<Settings['theme']>
              label="theme"
              value={settings.theme}
              options={[
                { value: 'auto', label: 'Auto' },
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
              ]}
              onChange={(theme) => update({ theme })}
            />
          }
        />

        <Field
          label="Maths"
          hint="Switch to source if formulas render as run-together text."
          control={
            <Segmented<Settings['mathRendering']>
              label="math"
              value={settings.mathRendering}
              options={[
                { value: 'mathml', label: 'Typeset' },
                { value: 'source', label: 'Source' },
              ]}
              onChange={(mathRendering) => update({ mathRendering })}
            />
          }
        />

        <Field label="Engine" hint={engineInfo} control={null} />
      </div>
    </Sheet>
  );
}

function Field({
  label,
  hint,
  control,
}: {
  label: string;
  hint: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[13.5px] font-medium">{label}</span>
      {control}
      <span className="text-muted text-xs">{hint}</span>
    </div>
  );
}

function SliderField({
  id,
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format(value: number): string;
  onChange(value: number): void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-[13.5px] font-medium" htmlFor={id}>
        {label} <span className="font-mono text-muted ml-1 text-xs">{format(value)}</span>
      </label>
      <Slider
        id={id}
        label={label}
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => next !== undefined && onChange(next)}
      />
      <span className="text-muted text-xs">{hint}</span>
    </div>
  );
}
