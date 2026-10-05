import { cva } from 'class-variance-authority'
import { cn } from '@/ui/cn.js'
import { FOCUS_RING } from '@/ui/Button.jsx'

/**
 * shadcn/ui-style Button on cva, re-skinned to the volleyui recipes
 * (bg-red-600 is the Swiss Volley brand red, see src/ui/tokens.css).
 *
 * New code should prefer `Button` from src/ui (the volleyui kit); this file
 * only keeps the shadcn API for anything that already uses it.
 * Courtside rule: the default size keeps the >= 44px touch target (h-11).
 * On the scoreboard use `dark` or `success`, never a brand-red fill (R4).
 */
export const buttonVariants = cva(
  cn('inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors disabled:pointer-events-none select-none', FOCUS_RING),
  {
    variants: {
      variant: {
        default: 'rounded-xl bg-red-600 text-white font-semibold hover:bg-red-700 disabled:bg-stone-300',
        destructive: 'rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:bg-stone-300',
        success: 'rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50',
        dark: 'rounded-xl bg-slate-900 text-white font-semibold hover:bg-slate-800 disabled:bg-stone-200 disabled:text-stone-400',
        outline: 'rounded-lg border border-stone-300 bg-white text-stone-700 hover:bg-stone-50 disabled:opacity-50',
        secondary: 'rounded-lg border border-stone-200 bg-white text-stone-600 hover:bg-stone-100 disabled:opacity-50',
        toolbar: 'rounded-lg border border-stone-200 bg-white text-stone-700 shadow-sm hover:bg-stone-50',
        dangerSoft: 'rounded-lg border border-red-100 bg-red-50 text-red-600 shadow-sm hover:bg-red-100',
        ghost: 'rounded-xl text-stone-700 hover:bg-stone-100 disabled:opacity-50',
        link: 'text-red-600 underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-11 min-h-11 px-4',
        sm: 'h-9 px-3',
        lg: 'h-12 px-6 text-base',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  }
)

export function Button({ className, variant, size, type = 'button', ...props }) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

export default Button
