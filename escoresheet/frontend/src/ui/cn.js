// Class-name helper: clsx for conditionals, tailwind-merge so a later class
// wins over an earlier one of the same group (`cn('h-9', big && 'h-11')`).
// Port of svrz_rc src/lib/utils.ts:1-6.
//
// kit: tailwind-merge does not know the custom `shadow-card` / `shadow-card-lg`
// utilities from tokens.css. With the stock twMerge (svrz_rc's),
// `cn('shadow-card', 'shadow-none')` keeps both classes and the card stays
// shadowed. Registering the two names in the shadow scale fixes that.
// Checked against tailwind-merge 3.7.
import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      shadow: ['card', 'card-lg'],
    },
  },
});

export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

export default cn;
