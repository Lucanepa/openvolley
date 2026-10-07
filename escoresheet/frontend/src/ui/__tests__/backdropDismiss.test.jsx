// Overlays close on a real tap on the backdrop, never on a drag that started
// inside the dialog. Regression for: selecting the whole password with the
// mouse closed the sign-in modal and went back to the homepage (the drag ended
// over the backdrop, which got the `click` as the common ancestor).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backdropDismiss } from '../backdropDismiss.js';
import { Modal } from '../Modal.jsx';
import { ConfirmDialog } from '../ConfirmDialog.jsx';
import { confirmDialog } from '../uiStore.js';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ signIn: vi.fn(), resetPassword: vi.fn() }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k, fallback) => (typeof fallback === 'string' ? fallback : _k), i18n: { language: 'en' } }),
}));

// eslint-disable-next-line import/first
import LoginModal from '../../components/auth/LoginModal.jsx';

function Overlay({ onClose, options }) {
  return (
    <div data-testid="backdrop" className="fixed inset-0" {...backdropDismiss(onClose, options)}>
      <div role="dialog" onClick={(e) => e.stopPropagation()}>
        <input aria-label="Password" type="password" defaultValue="hunter22" />
        <p>Some text</p>
      </div>
    </div>
  );
}

/** A mouse press on `down`, released on `up`; the click lands on their common ancestor. */
function mouseDrag(down, up, clickTarget) {
  fireEvent.pointerDown(down, { pointerType: 'mouse' });
  fireEvent.mouseDown(down);
  fireEvent.pointerUp(up, { pointerType: 'mouse' });
  fireEvent.mouseUp(up);
  fireEvent.click(clickTarget);
}

function tap(el) {
  mouseDrag(el, el, el);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

describe('backdropDismiss', () => {
  it('a drag from the input that ends on the backdrop does not close (mouse events)', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const input = screen.getByLabelText('Password');
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.mouseDown(input);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a drag from the input that ends on the backdrop does not close (pointer events)', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const input = screen.getByLabelText('Password');
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.pointerDown(input, { pointerType: 'mouse' });
    fireEvent.pointerUp(backdrop, { pointerType: 'mouse' });
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a press on the backdrop released inside the dialog does not close', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    mouseDrag(backdrop, screen.getByLabelText('Password'), backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('mousedown + mouseup + click on the backdrop closes', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('pointerdown + pointerup + click on the backdrop closes', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.pointerDown(backdrop, { pointerType: 'mouse' });
    fireEvent.pointerUp(backdrop, { pointerType: 'mouse' });
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a touch tap on the backdrop closes (pointer + compatibility mouse events)', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.pointerDown(backdrop, { pointerType: 'touch' });
    fireEvent.pointerUp(backdrop, { pointerType: 'touch' });
    fireEvent.mouseDown(backdrop);
    fireEvent.mouseUp(backdrop);
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a touch-drag selection that ends on the backdrop does not close', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const input = screen.getByLabelText('Password');
    const backdrop = screen.getByTestId('backdrop');
    fireEvent.pointerDown(input, { pointerType: 'touch' });
    fireEvent.pointerUp(backdrop, { pointerType: 'touch' });
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a click on the backdrop with no press recorded (synthetic) does not close', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    fireEvent.click(screen.getByTestId('backdrop'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close while text inside the overlay is selected', () => {
    const onClose = vi.fn();
    render(<Overlay onClose={onClose} />);
    const backdrop = screen.getByTestId('backdrop');
    const range = document.createRange();
    range.selectNodeContents(screen.getByText('Some text'));
    window.getSelection().addRange(range);
    tap(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    window.getSelection().removeAllRanges();
    tap(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('enabled: false never closes; stopPropagation option stops every click', () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    const { rerender } = render(
      <div onClick={outer}><Overlay onClose={onClose} options={{ enabled: false, stopPropagation: true }} /></div>,
    );
    const backdrop = screen.getByTestId('backdrop');
    tap(backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
    rerender(<div onClick={outer}><Overlay onClose={onClose} /></div>);
    tap(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(outer).toHaveBeenCalledTimes(1);
  });
});

describe('LoginModal backdrop', () => {
  it('selecting the password with a drag that ends on the backdrop keeps the modal open', () => {
    const onClose = vi.fn();
    const { container } = render(<LoginModal open onClose={onClose} onSwitchToSignUp={() => {}} />);
    const password = container.querySelector('input[type="password"]');
    fireEvent.change(password, { target: { value: 'secret-password' } });
    const backdrop = container.firstChild;
    mouseDrag(password, backdrop, backdrop);
    expect(onClose).not.toHaveBeenCalled();
    expect(password.value).toBe('secret-password');
  });

  it('a tap on the backdrop still closes it', () => {
    const onClose = vi.fn();
    const { container } = render(<LoginModal open onClose={onClose} onSwitchToSignUp={() => {}} />);
    tap(container.firstChild);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('kit Modal and ConfirmDialog backdrops', () => {
  it('Modal: a drag out of the input does not close, a tap does', () => {
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Edit">
        <input aria-label="Name" />
      </Modal>,
    );
    const backdrop = screen.getByLabelText('Name').closest('.fixed');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000); // past the 400ms open guard
    mouseDrag(screen.getByLabelText('Name'), backdrop, backdrop);
    expect(onClose).not.toHaveBeenCalled();
    tap(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
    Date.now.mockRestore();
  });

  it('ConfirmDialog (askText): a drag out of the input does not cancel, a tap does', async () => {
    render(<ConfirmDialog />);
    let result;
    await act(async () => {
      confirmDialog({ title: 'Name?', input: { label: 'Name', defaultValue: 'abc' } }).then((v) => { result = v; });
    });
    const input = screen.getByRole('textbox');
    const backdrop = input.closest('.fixed');
    const later = Date.now() + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await act(async () => { mouseDrag(input, backdrop, backdrop); });
    expect(screen.queryByTestId('confirm-dialog')).not.toBeNull();
    expect(result).toBeUndefined();
    await act(async () => { tap(backdrop); });
    expect(result).toBe(false);
    Date.now.mockRestore();
  });
});
