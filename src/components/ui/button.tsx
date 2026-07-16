import type { ButtonHTMLAttributes } from "react";

import { cn } from "@/lib/utils/cn";

type Variant = "primary" | "secondary" | "ghost" | "outline" | "danger";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded-xl font-medium tracking-tight " +
  "transition-all duration-200 select-none focus-visible:outline-none " +
  "focus-visible:ring-2 focus-visible:ring-gold/50 focus-visible:ring-offset-2 " +
  "focus-visible:ring-offset-canvas disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary:
    "bg-gold text-on-gold hover:bg-gold-bright shadow-[0_4px_24px_-6px_rgba(227,178,60,0.55)] " +
    "hover:shadow-[0_6px_30px_-6px_rgba(227,178,60,0.7)] active:scale-[0.98]",
  secondary:
    "bg-surface-2 text-foreground border border-border hover:bg-elevated hover:border-border-strong",
  ghost: "text-muted hover:text-foreground hover:bg-surface",
  outline:
    "border border-border-strong text-foreground hover:bg-surface hover:border-gold/40",
  danger:
    "bg-danger/15 text-danger border border-danger/30 hover:bg-danger/25",
};

const sizes: Record<Size, string> = {
  sm: "h-9 px-3.5 text-sm",
  md: "h-11 px-5 text-sm",
  lg: "h-14 px-7 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(base, variants[variant], sizes[size], className)}
      {...props}
    />
  );
}
