import * as SliderPrimitive from '@radix-ui/react-slider';
import { cn } from '../../lib/cn';

export function Slider({
  className,
  label,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root> & { label: string }) {
  return (
    <SliderPrimitive.Root
      // h-6: the track is 4px but a bare slider is a hard target on a phone.
      className={cn('relative flex h-6 w-full touch-none items-center select-none', className)}
      {...props}
    >
      <SliderPrimitive.Track className="bg-line-soft relative h-1 w-full grow overflow-hidden rounded-full">
        <SliderPrimitive.Range className="bg-amber-deep absolute h-full" />
      </SliderPrimitive.Track>
      {/* The label goes on the Thumb, not the Root: Radix puts role="slider"
          here, so a name on the Root leaves the control anonymous. */}
      <SliderPrimitive.Thumb
        aria-label={label}
        className="border-amber-deep bg-card shadow-sm block size-4 rounded-full border-2 transition-transform active:scale-110"
      />
    </SliderPrimitive.Root>
  );
}
