import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { FOCUS_RING, INPUT_SIZES, INPUT_INVALID, cn } from '../../ui'

const MAX_SHOWN = 100
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/**
 * A searchable dropdown over a list of names that still takes any text (the
 * saved team editor's VolleyManager name: a value that is not in the list,
 * such as a name the schedule no longer has, is kept as typed).
 *
 * An input with role combobox: typing filters the list (accents and case
 * ignored), the chevron or ArrowDown opens it, ArrowUp/ArrowDown move,
 * Enter picks, Escape closes. `onChange(text)` on every keystroke, and
 * `onPick(name)` too when a name is picked from the list.
 *
 * Field gives it an id and aria-describedby (it passes them to the input).
 */
export default function SearchSelect({ value, onChange, onPick, options = [], listLabel, emptyText, openLabel, placeholder, maxLength, invalid, className, id: idProp, ...rest }) {
  const auto = useId()
  const id = idProp || `ss${auto}`
  const listId = `${id}-list`
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  // the text typed since the list opened filters it; opened by the chevron it shows everything
  const [filter, setFilter] = useState('')
  const wrap = useRef(null)
  const input = useRef(null)

  const shown = useMemo(() => {
    const q = fold(filter)
    const list = q ? options.filter((o) => fold(o).includes(q)) : options
    return list.slice(0, MAX_SHOWN)
  }, [options, filter])

  useEffect(() => {
    if (!open) return undefined
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
    }
  }, [open])

  const pick = (name) => {
    onChange?.(name)
    onPick?.(name)
    setOpen(false)
    setActive(-1)
  }
  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!open) { setOpen(true); setFilter(''); setActive(0); return }
      setActive((i) => Math.min(shown.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      if (open && active >= 0 && shown[active]) {
        e.preventDefault()
        pick(shown[active])
      }
    } else if (e.key === 'Escape') {
      if (open) {
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
      }
    }
  }

  const bad = invalid || rest['aria-invalid'] === true || rest['aria-invalid'] === 'true'
  return (
    <div ref={wrap} className={cn('relative', className)}>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 && shown[active] ? `${id}-o${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        maxLength={maxLength}
        onChange={(e) => { onChange?.(e.target.value); setFilter(e.target.value); setOpen(true); setActive(-1) }}
        onKeyDown={onKeyDown}
        className={cn(INPUT_SIZES.md, 'pr-9', bad && INPUT_INVALID)}
        {...rest}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={openLabel}
        title={openLabel}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { setFilter(''); setOpen((o) => !o); setActive(-1); input.current?.focus() }}
        className={cn('absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-stone-400 hover:text-stone-700', FOCUS_RING)}
      >
        <ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={listLabel}
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-stone-200 bg-white py-1 shadow-lg"
        >
          {shown.length === 0 ? (
            <li className="px-3 py-2 text-xs text-stone-500" role="presentation">{emptyText}</li>
          ) : shown.map((name, i) => (
            <li
              key={name}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={name === value}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(name)}
              onMouseEnter={() => setActive(i)}
              className={cn('cursor-pointer px-3 py-1.5 text-sm text-stone-800', i === active && 'bg-stone-100', name === value && 'font-semibold')}
            >
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
