import { useState, type ReactNode } from 'react';
import { HardDrive, MessageSquare, Palette } from 'lucide-react';
import { useStore } from '@/state/store';
import type { Settings } from '@/state/types';
import { SHEET_DESKTOP_SIZE } from './Sheet';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DialogOverlay, DialogPortal } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import { Segmented } from './Segmented';
import { ModelManagement } from '@/components/models/ModelManagement';

/**
 * The settings window: a category rail on the left, one panel on the right.
 *
 * Mirrors `rapid-mac`'s `SettingsView`, including the rule that makes the
 * layout hold together — the panel area is ONE scroll container whose content
 * is swapped, so switching category cannot make the window resize.
 *
 * Below `sm:` the rail becomes a horizontal strip above the panel: a 200px
 * rail beside a phone-width panel leaves nothing for the panel.
 */

export const CATEGORIES = ['models', 'chat', 'appearance'] as const;
export type SettingsCategory = (typeof CATEGORIES)[number];

const CATEGORY_META: Record<
  SettingsCategory,
  { title: string; icon: ReactNode }
> = {
  models: { title: 'Models', icon: <HardDrive /> },
  chat: { title: 'Chat', icon: <MessageSquare /> },
  appearance: { title: 'Appearance', icon: <Palette /> },
};

export function SettingsSheet({
  open,
  onClose,
  engineInfo,
  initialCategory = 'models',
}: {
  open: boolean;
  onClose(): void;
  engineInfo: string;
  initialCategory?: SettingsCategory;
}) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
        // Reopening lands on whichever category the caller asked for, not
        // wherever the last visit ended: the model button and the footer
        // button mean different things.
        else setCategory(initialCategory);
      }}
    >
      <DialogPortal>
        <DialogOverlay className="z-20" />
        <DialogPrimitive.Content
          className={cn(
            'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-x-0 bottom-0 z-20 flex max-h-[88dvh] flex-col rounded-t-xl border-t shadow-lg duration-200',
            'data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom',
            'sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:zoom-in-95 sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=open]:slide-in-from-bottom-0',
            SHEET_DESKTOP_SIZE,
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl sm:border',
          )}
          aria-label="Settings"
        >
          <header className="flex shrink-0 items-center gap-2 border-b py-3 pr-3 pl-4">
            <DialogPrimitive.Title className="m-0 min-w-0 flex-1 text-base leading-none font-semibold">
              Settings
            </DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground size-8"
                aria-label="Close"
                title="Close"
              >
                <X />
              </Button>
            </DialogPrimitive.Close>
          </header>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <CategoryRail value={category} onChange={setCategory} />
            {/* One scroll container per window, not per panel: a panel that
                owns its own scroller re-anchors to the top on every switch
                and loses the position of the one being returned to. */}
            <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              {category === 'models' ? (
                <ModelManagement open={open} onClose={onClose} />
              ) : category === 'chat' ? (
                <ChatPanel />
              ) : (
                <AppearancePanel engineInfo={engineInfo} />
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </DialogPrimitive.Root>
  );
}

function CategoryRail({
  value,
  onChange,
}: {
  value: SettingsCategory;
  onChange(next: SettingsCategory): void;
}) {
  return (
    <nav
      className="bg-muted/40 flex shrink-0 gap-1 overflow-x-auto border-b p-2 sm:w-[184px] sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-r sm:border-b-0"
      aria-label="Settings categories"
    >
      {CATEGORIES.map((category) => {
        const meta = CATEGORY_META[category];
        const selected = category === value;
        return (
          <button
            key={category}
            type="button"
            // `aria-current`, not `aria-selected`: these are navigation
            // buttons, and `aria-selected` is only meaningful inside a
            // tablist/listbox role this deliberately does not claim.
            aria-current={selected ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm font-medium whitespace-nowrap transition-colors outline-none',
              'focus-visible:ring-ring/50 focus-visible:ring-[3px]',
              selected
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              'sm:w-full',
            )}
            onClick={() => onChange(category)}
          >
            <span className="[&_svg]:size-4 [&_svg]:shrink-0">{meta.icon}</span>
            {meta.title}
          </button>
        );
      })}
    </nav>
  );
}

function ChatPanel() {
  const settings = useStore((state) => state.settings);
  const update = useStore((state) => state.updateSettings);

  return (
    <PanelBody>
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
    </PanelBody>
  );
}

function AppearancePanel({ engineInfo }: { engineInfo: string }) {
  const settings = useStore((state) => state.settings);
  const update = useStore((state) => state.updateSettings);

  return (
    <PanelBody>
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
    </PanelBody>
  );
}

function PanelBody({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6 px-4 pt-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
      {children}
    </div>
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
