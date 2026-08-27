import { useStore } from '@/state/store';
import type { Settings } from '@/state/types';
import { Sheet } from './Sheet';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Segmented } from './Segmented';

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
      <div className="flex flex-col gap-6 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <Field
          label="System prompt"
          htmlFor="system"
          hint="Prepended to every turn, in this browser only."
          control={
            <Textarea
              id="system"
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
              className="w-full"
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
              className="w-full"
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
  htmlFor,
  hint,
  control,
}: {
  label: string;
  htmlFor?: string;
  hint: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {htmlFor ? (
        <Label htmlFor={htmlFor}>{label}</Label>
      ) : (
        <span className="text-sm leading-none font-medium">{label}</span>
      )}
      {control}
      <span className="text-muted-foreground text-xs">{hint}</span>
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
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>
        {label}
        <span className="text-muted-foreground font-mono text-xs font-normal">{format(value)}</span>
      </Label>
      <Slider
        id={id}
        aria-label={label}
        className="py-2"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => next !== undefined && onChange(next)}
      />
      <span className="text-muted-foreground text-xs">{hint}</span>
    </div>
  );
}
