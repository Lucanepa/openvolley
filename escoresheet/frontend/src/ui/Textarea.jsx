// Textarea.
//   md  RcMeetingsAdmin.tsx:159 (notes), + resize-y as in SurveyPage.tsx:193
//   sm  App.tsx:8312 (a note inside a dense row: text-xs, px-2.5 py-1.5)
//   prose  adds leading-relaxed for long editable text, AdminConsole.tsx:3374
import { cn } from './cn.js';
import { INPUT_INVALID } from './Input.jsx';

export const TEXTAREA_SIZES = {
  md: 'w-full px-3 py-2 text-sm rounded-lg border border-stone-300 bg-white text-stone-800 focus:outline-none focus:ring-2 focus:ring-red-500 resize-y',
  sm: 'w-full resize-y rounded-lg border border-stone-300 bg-white px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-red-500',
};

/**
 * @param {object} props
 * @param {'sm'|'md'} [props.size]
 * @param {boolean} [props.prose] leading-relaxed for paragraphs of text
 * @param {boolean} [props.invalid]
 */
export function Textarea({ size = 'md', prose, invalid, rows = 4, className, ...rest }) {
  const bad = invalid || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true';
  return (
    <textarea
      rows={rows}
      aria-invalid={bad || undefined}
      className={cn(TEXTAREA_SIZES[size], prose && 'leading-relaxed', bad && INPUT_INVALID, className)}
      {...rest}
    />
  );
}

export default Textarea;
