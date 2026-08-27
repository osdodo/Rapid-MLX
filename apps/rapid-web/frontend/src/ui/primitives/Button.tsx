import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

const button = cva(
  'inline-flex items-center justify-center gap-2 shrink-0 font-medium transition-[background-color,transform,opacity] duration-150 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97]',
  {
    variants: {
      variant: {
        primary: 'bg-amber text-[#241a08] font-semibold hover:bg-amber-deep',
        brand: 'bg-brand text-on-brand hover:opacity-90',
        ghost: 'text-fg hover:bg-line-soft',
        quiet: 'text-brand hover:bg-brand-tint',
        danger: 'bg-danger text-white hover:opacity-90',
        icon: 'text-muted hover:bg-line-soft hover:text-fg',
      },
      size: {
        sm: 'h-8 px-2.5 rounded-sm text-sm',
        md: 'h-10 px-4 rounded-md text-sm',
        lg: 'h-11 px-5 rounded-md text-[15px]',
        // Square, for an icon on its own. [&_svg]:size-[18px] saves every
        // call site sizing the glyph.
        square: 'size-[34px] rounded-sm [&_svg]:size-[18px]',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(button({ variant, size }), className)} {...props} />;
}
