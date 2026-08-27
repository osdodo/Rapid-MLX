import * as RadioGroup from '@radix-ui/react-radio-group';
import { cn } from '../../lib/cn';

/**
 * A radio group styled as a segmented control.
 *
 * Radios rather than buttons, so arrow keys move between options and a screen
 * reader announces "2 of 3".
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange(value: T): void;
  className?: string;
}) {
  return (
    <RadioGroup.Root
      className={cn('bg-line-soft flex gap-0.5 rounded-sm p-0.5', className)}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      aria-label={label}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className="text-muted data-[state=checked]:bg-card data-[state=checked]:text-fg data-[state=checked]:shadow-sm flex-1 rounded-[6px] px-2 py-1.5 text-center text-[13px] transition-colors duration-150 data-[state=checked]:font-medium"
        >
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
