import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-indigo-600/30 text-indigo-300 border-indigo-500/40',
        secondary:
          'border-transparent bg-slate-800 text-slate-300',
        destructive:
          'border-transparent bg-rose-950/60 text-rose-300 border-rose-800/40',
        outline:
          'text-slate-300 border-slate-700',
        success:
          'border-transparent bg-emerald-950/60 text-emerald-300 border-emerald-800/40',
        warning:
          'border-transparent bg-amber-950/60 text-amber-300 border-amber-800/40',
        dedup:
          'border-transparent bg-purple-950/60 text-purple-300 border-purple-800/40',
        canonical:
          'border-transparent bg-cyan-950/60 text-cyan-300 border-cyan-800/40',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
