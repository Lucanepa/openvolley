import { describe, it, expect, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import React, { useRef } from 'react';
import { usePinchZoom } from '../usePinchZoom';

function Sheet({ zoom, setZoom, preview }: { zoom: number; setZoom: (z: number) => void; preview?: (z: number, moving: boolean) => boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  usePinchZoom({ scrollRef, boxRef, zoom, setZoom, preview, min: 0.2, max: 3 });
  return <div ref={scrollRef} data-testid="scroller"><div ref={boxRef} /></div>;
}

const finger = (clientX: number, clientY = 100) => ({ clientX, clientY });
const touch = (el: Element, type: string, touches: Array<{ clientX: number; clientY: number }>) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: touches });
  el.dispatchEvent(e);
  return e;
};
const frame = () => act(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))));

describe('usePinchZoom', () => {
  it('spreading two fingers to twice the distance doubles the zoom', async () => {
    const setZoom = vi.fn();
    const { getByTestId } = render(<Sheet zoom={0.67} setZoom={setZoom} />);
    const el = getByTestId('scroller');
    const started = touch(el, 'touchstart', [finger(100), finger(200)]);
    expect(started.defaultPrevented).toBe(true);
    touch(el, 'touchmove', [finger(50), finger(250)]);
    await frame();
    expect(setZoom).toHaveBeenLastCalledWith(1.34);
  });

  it('stops at the limits', async () => {
    const setZoom = vi.fn();
    const { getByTestId } = render(<Sheet zoom={1} setZoom={setZoom} />);
    const el = getByTestId('scroller');
    touch(el, 'touchstart', [finger(100), finger(110)]);
    touch(el, 'touchmove', [finger(0), finger(1000)]);
    await frame();
    expect(setZoom).toHaveBeenLastCalledWith(3);
    touch(el, 'touchend', [finger(0)]);
    touch(el, 'touchstart', [finger(0), finger(1000)]);
    touch(el, 'touchmove', [finger(500), finger(501)]);
    await frame();
    expect(setZoom).toHaveBeenLastCalledWith(0.2);
  });

  it('one finger is left to scroll the page', async () => {
    const setZoom = vi.fn();
    const { getByTestId } = render(<Sheet zoom={1} setZoom={setZoom} />);
    const el = getByTestId('scroller');
    const started = touch(el, 'touchstart', [finger(100)]);
    const moved = touch(el, 'touchmove', [finger(150)]);
    await frame();
    expect(started.defaultPrevented).toBe(false);
    expect(moved.defaultPrevented).toBe(false);
    expect(setZoom).not.toHaveBeenCalled();
  });

  it('a finger lifted ends the pinch: the other one does not zoom', async () => {
    const setZoom = vi.fn();
    const { getByTestId } = render(<Sheet zoom={1} setZoom={setZoom} />);
    const el = getByTestId('scroller');
    touch(el, 'touchstart', [finger(100), finger(200)]);
    touch(el, 'touchend', [finger(100)]);
    touch(el, 'touchmove', [finger(150)]);
    await frame();
    expect(setZoom).not.toHaveBeenCalled();
  });

  it('with a preview: the fingers move the drawn sheet only, the zoom is set once when they lift', async () => {
    const setZoom = vi.fn();
    const preview = vi.fn(() => true);
    const { getByTestId } = render(<Sheet zoom={0.67} setZoom={setZoom} preview={preview} />);
    const el = getByTestId('scroller');
    touch(el, 'touchstart', [finger(100), finger(200)]);
    touch(el, 'touchmove', [finger(75), finger(225)]);
    await frame();
    touch(el, 'touchmove', [finger(50), finger(250)]);
    await frame();
    expect(preview).toHaveBeenLastCalledWith(1.34, true);
    expect(setZoom).not.toHaveBeenCalled();
    touch(el, 'touchend', [finger(50)]);
    expect(preview).toHaveBeenLastCalledWith(1.34, false);
    expect(setZoom).toHaveBeenCalledTimes(1);
    expect(setZoom).toHaveBeenCalledWith(1.34);
  });
});
