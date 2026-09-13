import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98]',
  {
    variants: {
      variant: {
        default:
          'bg-indigo-600 text-white shadow hover:bg-indigo-500 shadow-indigo-500/20 hover:shadow-indigo-500/30',
        destructive:
          'bg-rose-600 text-white shadow hover:bg-rose-500 shadow-rose-500/20',
        outline:
          'border border-slate-700 bg-slate-900/50 hover:bg-slate-800 hover:text-white text-slate-200',
        secondary:
          'bg-slate-800 text-slate-100 hover:bg-slate-700 shadow-sm',
        ghost:
          'hover:bg-slate-800/80 hover:text-white text-slate-300',
        link:
          'text-indigo-400 underline-offset-4 hover:underline',
        success:
          'bg-emerald-600 text-white shadow hover:bg-emerald-500 shadow-emerald-500/20',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-xs',
        lg: 'h-10 rounded-md px-6 text-base',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
