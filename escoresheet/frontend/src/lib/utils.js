import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge conditional class names and de-duplicate conflicting Tailwind classes.
 * Standard shadcn/ui helper: cn('px-2', condition && 'px-4') → 'px-4'.
 */
export function cn(...inputs) {
  return twMerge(clsx(inputs))
}
