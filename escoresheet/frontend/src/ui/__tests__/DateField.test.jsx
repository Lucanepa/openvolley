// DateField / TimeField / DateTimeField: typed ISO fields with the kit's own
// popovers, which close on Escape, a tap outside, Done and a picked day (the
// native WebKitGTK date popup in the Linux desktop app could not be closed).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opt) => {
      if (typeof opt === 'string') return opt;
      if (opt && typeof opt.defaultValue === 'string') return opt.defaultValue.replace(/\{\{(\w+)\}\}/g, (_, k) => opt[k] ?? '');
      return key;
    },
    i18n: { language: 'en', resolvedLanguage: 'en' },
  }),
}));

import { DateField, TimeField, DateTimeField } from '../DateField.jsx';
import { Field } from '../Field.jsx';
import { Modal } from '../Modal.jsx';

// Today is Wednesday 7 October 2026 (Zürich).
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const flush = () => act(() => new Promise((r) => setTimeout(r, 5)));

function Controlled({ initial = '', onValue, Comp = DateField, ...props }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <Comp aria-label="Match date" value={v} onChange={(x) => { setV(x); onValue?.(x); }} {...props} />
      <output data-testid="value">{v}</output>
      <button type="button">elsewhere</button>
    </>
  );
}

const input = () => screen.getByLabelText('Match date');
const openCalendar = () => fireEvent.click(screen.getByRole('button', { name: 'Open calendar' }));
const dialog = () => screen.queryByRole('dialog');

/** A real tap on an element: press and release on it, then the click. */
function tap(el) {
  fireEvent.pointerDown(el);
  fireEvent.mouseDown(el);
  fireEvent.pointerUp(el);
  fireEvent.mouseUp(el);
  fireEvent.click(el);
}

describe('DateField: typing', () => {
  it('shows an ISO value as DD.MM.YYYY and reports ISO once the date is complete', () => {
    const onValue = vi.fn();
    render(<Controlled initial="2026-10-07" onValue={onValue} />);
    expect(input()).toHaveValue('07.10.2026');
    expect(input()).toHaveAttribute('type', 'text');
    expect(input()).toHaveAttribute('inputmode', 'numeric');

    fireEvent.change(input(), { target: { value: '1512' } });
    expect(input()).toHaveValue('15.12');
    expect(onValue).toHaveBeenLastCalledWith(''); // unfinished: empty, like a native field
    fireEvent.change(input(), { target: { value: '15122026' } });
    expect(input()).toHaveValue('15.12.2026');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-12-15');
  });

  it('takes an ISO date whole (autofill, paste) and tidies D.M.YYYY on blur', () => {
    render(<Controlled />);
    fireEvent.change(input(), { target: { value: '2026-08-01' } });
    expect(input()).toHaveValue('01.08.2026');
    expect(screen.getByTestId('value')).toHaveTextContent('2026-08-01');
    fireEvent.change(input(), { target: { value: '6.1.2027' } });
    fireEvent.blur(input());
    expect(input()).toHaveValue('06.01.2027');
    expect(screen.getByTestId('value')).toHaveTextContent('2027-01-06');
  });

  it('follows a value changed from outside', () => {
    const { rerender } = render(<DateField aria-label="Match date" value="2026-10-07" onChange={() => {}} />);
    rerender(<DateField aria-label="Match date" value="2027-03-01" onChange={() => {}} />);
    expect(input()).toHaveValue('01.03.2027');
    rerender(<DateField aria-label="Match date" value="" onChange={() => {}} />);
    expect(input()).toHaveValue('');
  });

  it('min / max: an out-of-range date turns the field red and blocks the form', () => {
    render(<Controlled min="2026-10-01" max="2026-10-31" />);
    fireEvent.change(input(), { target: { value: '30.09.2026' } });
    expect(screen.getByTestId('value')).toHaveTextContent('2026-09-30'); // kept, as natively
    fireEvent.blur(input());
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input().validationMessage).toBe('The earliest date is 01.10.2026.');
    fireEvent.change(input(), { target: { value: '15.10.2026' } });
    fireEvent.blur(input());
    expect(input()).not.toHaveAttribute('aria-invalid');
    expect(input().validationMessage).toBe('');
  });

  it('an impossible date reports empty and says how to type one', () => {
    render(<Controlled initial="2026-10-07" />);
    fireEvent.change(input(), { target: { value: '31.02.2026' } });
    fireEvent.blur(input());
    expect(screen.getByTestId('value')).toHaveTextContent(/^$/);
    expect(input()).toHaveAttribute('aria-invalid', 'true');
    expect(input().validationMessage).toBe('Enter a date as DD.MM.YYYY.');
  });

  it('works inside a kit Field: label, id and required reach the text input', () => {
    render(<Field label="Starts on"><DateField value="" onChange={() => {}} required data-testid="starts" /></Field>);
    const el = screen.getByLabelText('Starts on');
    expect(el).toBe(screen.getByTestId('starts'));
    expect(el).toBeRequired();
  });
});

describe('DateField: the calendar popover', () => {
  it('opens as a labelled dialog from an accessible button', () => {
    render(<Controlled initial="2026-10-07" />);
    const btn = screen.getByRole('button', { name: 'Open calendar' });
    expect(btn).toHaveAttribute('aria-haspopup', 'dialog');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    openCalendar();
    expect(dialog()).toHaveAttribute('aria-label', 'Calendar');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    // The chosen day has the focus and reads as a full date.
    const day = screen.getByRole('button', { name: /Wednesday.*7.*October.*2026/ });
    expect(day).toHaveFocus();
    expect(day).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Month')).toHaveValue('10');
    expect(screen.getByLabelText('Year')).toHaveValue('2026');
  });

  it('Escape closes it, focus goes back to the field, and the screen behind never sees the key', async () => {
    const behind = vi.fn();
    document.addEventListener('keydown', behind);
    render(<Controlled initial="2026-10-07" />);
    openCalendar();
    fireEvent.keyDown(screen.getByRole('button', { name: /\s7 October 2026/ }), { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(behind).not.toHaveBeenCalled();
    await flush();
    expect(input()).toHaveFocus();
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-07');
    document.removeEventListener('keydown', behind);
  });

  it('inside a kit Modal: Escape and a tap outside close the popover, not the modal', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Match">
        <Controlled initial="2026-10-07" />
      </Modal>,
    );
    openCalendar();
    expect(screen.getAllByRole('dialog')).toHaveLength(2);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    openCalendar();
    tap(screen.getByRole('dialog', { name: 'Calendar' }).parentElement);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a tap outside closes it without picking; a drag that ends outside does not', () => {
    render(<Controlled initial="2026-10-07" />);
    openCalendar();
    const layer = dialog().parentElement;
    // Press inside the panel, release on the layer: a drag, not a tap outside.
    fireEvent.pointerDown(dialog());
    fireEvent.mouseDown(dialog());
    fireEvent.pointerUp(layer);
    fireEvent.mouseUp(layer);
    fireEvent.click(layer);
    expect(dialog()).not.toBeNull();
    tap(layer);
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-07');
  });

  it('a click inside does not close it, and does not reach a clickable row around the field', () => {
    const rowClick = vi.fn();
    render(<div onClick={rowClick}><Controlled initial="2026-10-07" /></div>);
    openCalendar();
    rowClick.mockClear();
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(dialog()).not.toBeNull();
    expect(rowClick).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Month')).toHaveValue('11');
  });

  it('picking a day reports it as ISO and closes', async () => {
    render(<Controlled initial="2026-10-07" />);
    openCalendar();
    fireEvent.click(screen.getByRole('button', { name: /Friday.*23.*October.*2026/ }));
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-23');
    expect(input()).toHaveValue('23.10.2026');
    await flush();
    expect(input()).toHaveFocus();
  });

  it('Done closes and keeps the value; Clear empties it; Today picks today', () => {
    render(<Controlled initial="2026-10-07" />);
    openCalendar();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-07');

    openCalendar();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(dialog()).toBeNull();
    expect(input()).toHaveValue('');
    expect(screen.getByTestId('value')).toHaveTextContent(/^$/);

    openCalendar();
    fireEvent.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-07');
  });

  it('a required field offers no Clear', () => {
    render(<Controlled initial="2026-10-07" required />);
    openCalendar();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  it('keyboard: arrows move by day and week, PageDown by month, Enter picks', () => {
    render(<Controlled initial="2026-10-07" />);
    openCalendar();
    const focused = () => document.activeElement.getAttribute('data-iso');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(focused()).toBe('2026-10-08');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(focused()).toBe('2026-10-15');
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement, { key: 'ArrowUp' });
    expect(focused()).toBe('2026-10-07');
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(focused()).toBe('2026-10-05');
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(focused()).toBe('2026-10-11');
    fireEvent.keyDown(document.activeElement, { key: 'PageDown' });
    expect(focused()).toBe('2026-11-11');
    expect(screen.getByLabelText('Month')).toHaveValue('11');
    fireEvent.keyDown(document.activeElement, { key: 'PageUp', shiftKey: true });
    expect(focused()).toBe('2025-11-11');
    fireEvent.keyDown(document.activeElement, { key: 'Enter' });
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('value')).toHaveTextContent('2025-11-11');
  });

  it('Alt+ArrowDown in the field opens the calendar', () => {
    render(<Controlled initial="2026-10-07" />);
    fireEvent.keyDown(input(), { key: 'ArrowDown', altKey: true });
    expect(dialog()).not.toBeNull();
  });

  it('min / max: days outside are disabled and the keys stop at the bounds', () => {
    render(<Controlled initial="2026-10-07" min="2026-10-05" max="2026-10-09" />);
    openCalendar();
    expect(screen.getByRole('button', { name: /\s4 October 2026/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /\s10 October 2026/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /\s9 October 2026/ })).not.toBeDisabled();
    expect(screen.getByLabelText('Next month')).toBeDisabled();
    expect(screen.getByLabelText('Previous month')).toBeDisabled();
    fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
    expect(document.activeElement.getAttribute('data-iso')).toBe('2026-10-09');
  });

  it('a date of birth decades back is two selects away', () => {
    render(<Controlled initial="" />);
    openCalendar();
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: '1990' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: /Wednesday.*14.*February.*1990/ }));
    expect(screen.getByTestId('value')).toHaveTextContent('1990-02-14');
  });

  it('month names follow the app language', () => {
    render(<Controlled initial="2026-10-07" />);
    openCalendar();
    expect(within(screen.getByLabelText('Month')).getByRole('option', { name: 'October' })).toBeInTheDocument();
  });
});

describe('TimeField', () => {
  it('typing: "2045" is 20:45, unfinished is empty, H:MM is tidied on blur', () => {
    render(<Controlled Comp={TimeField} />);
    fireEvent.change(input(), { target: { value: '2045' } });
    expect(input()).toHaveValue('20:45');
    expect(screen.getByTestId('value')).toHaveTextContent('20:45');
    fireEvent.change(input(), { target: { value: '20:4' } });
    expect(screen.getByTestId('value')).toHaveTextContent(/^$/);
    fireEvent.change(input(), { target: { value: '930' } });
    fireEvent.blur(input());
    expect(input()).toHaveValue('09:30');
    expect(screen.getByTestId('value')).toHaveTextContent('09:30');
  });

  it('the popover: an hour keeps it open, a minute picks and closes, Escape closes', async () => {
    render(<Controlled Comp={TimeField} initial="20:47" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose time' }));
    expect(dialog()).toHaveAttribute('aria-label', 'Time');
    const minutes = within(screen.getByRole('group', { name: 'Minutes' }));
    // 5-minute steps, plus the typed 47.
    expect(minutes.getByRole('button', { name: ':45' })).toBeInTheDocument();
    expect(minutes.getByRole('button', { name: ':47' })).toHaveAttribute('aria-pressed', 'true');
    expect(minutes.queryByRole('button', { name: ':46' })).toBeNull();

    fireEvent.click(within(screen.getByRole('group', { name: 'Hours' })).getByRole('button', { name: '18' }));
    expect(screen.getByTestId('value')).toHaveTextContent('18:47');
    expect(dialog()).not.toBeNull();
    fireEvent.click(minutes.getByRole('button', { name: ':30' }));
    expect(screen.getByTestId('value')).toHaveTextContent('18:30');
    expect(dialog()).toBeNull();
    await flush();
    expect(input()).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Choose time' }));
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(screen.getByTestId('value')).toHaveTextContent('18:30');
  });

  it('a tap outside closes the time popover too', () => {
    render(<Controlled Comp={TimeField} initial="20:45" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose time' }));
    tap(dialog().parentElement);
    expect(dialog()).toBeNull();
  });

  it('min / max disable the times outside', () => {
    render(<Controlled Comp={TimeField} initial="08:00" min="08:00" max="22:00" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose time' }));
    const hours = within(screen.getByRole('group', { name: 'Hours' }));
    expect(hours.getByRole('button', { name: '07' })).toBeDisabled();
    expect(hours.getByRole('button', { name: '22' })).not.toBeDisabled();
    expect(hours.getByRole('button', { name: '23' })).toBeDisabled();
  });
});

describe('DateTimeField', () => {
  it('ISO in and out: YYYY-MM-DDTHH:MM, empty until both parts are there', () => {
    const onValue = vi.fn();
    render(<Controlled Comp={DateTimeField} initial="2026-10-07T20:45" onValue={onValue} />);
    const date = screen.getByLabelText('Match date – Date');
    const time = screen.getByLabelText('Match date – Time');
    expect(date).toHaveValue('07.10.2026');
    expect(time).toHaveValue('20:45');
    fireEvent.change(time, { target: { value: '' } });
    expect(onValue).toHaveBeenLastCalledWith('');
    fireEvent.change(time, { target: { value: '1815' } });
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-07T18:15');
    fireEvent.change(date, { target: { value: '08.10.2026' } });
    expect(screen.getByTestId('value')).toHaveTextContent('2026-10-08T18:15');
  });

  it('uncontrolled with onCommit: saves once the focus leaves the whole field', async () => {
    const onCommit = vi.fn();
    render(
      <>
        <DateTimeField aria-label="Start" defaultValue="2026-10-07T20:45" onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </>,
    );
    const time = screen.getByLabelText('Start – Time');
    time.focus();
    fireEvent.change(time, { target: { value: '2100' } });
    // Into the date: still inside the field.
    fireEvent.blur(time, { relatedTarget: screen.getByLabelText('Start – Date') });
    await flush();
    expect(onCommit).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'elsewhere' }).focus();
    fireEvent.blur(time, { relatedTarget: screen.getByRole('button', { name: 'elsewhere' }) });
    await flush();
    expect(onCommit).toHaveBeenCalledWith('2026-10-07T21:00');
  });
});
