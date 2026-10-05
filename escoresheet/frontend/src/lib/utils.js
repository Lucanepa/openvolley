/**
 * Merge conditional class names and de-duplicate conflicting Tailwind classes.
 * cn('px-2', condition && 'px-4') → 'px-4'.
 *
 * One cn for the whole app: the volleyui kit's (src/ui/cn.js), which also
 * knows the custom shadow-card / shadow-card-lg utilities.
 */
export { cn } from '../ui/cn.js'
