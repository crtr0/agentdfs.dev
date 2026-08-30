import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold",
  {
    variants: {
      variant: {
        neutral: "border-neutral-300 bg-white text-neutral-700",
        active: "border-lime-400 bg-lime-200 text-lime-950",
        accepted: "border-emerald-300 bg-emerald-50 text-emerald-800",
        missed: "border-red-300 bg-red-50 text-red-800",
        final: "border-blue-300 bg-blue-50 text-blue-800",
      },
    },
    defaultVariants: { variant: "neutral" },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
