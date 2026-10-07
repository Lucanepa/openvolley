// The player drag image is the disc alone: a box-shadow is cut off at the
// element's square box in the browser's snapshot and shows as a grey square
// behind the circle (owner report, desktop app).
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setPlayerDragImage } from '../dragImage.js';

function dragStart() {
  const setDragImage = vi.fn();
  return { e: { dataTransfer: { setDragImage } }, setDragImage };
}

describe('setPlayerDragImage', () => {
  afterEach(() => vi.useRealTimers());

  it('sets a round 50px disc without a shadow, held at its centre', () => {
    vi.useFakeTimers();
    const { e, setDragImage } = dragStart();
    setPlayerDragImage(e, 10, { bg: '#4ade80', text: '#000', ring: '#fff' });

    expect(setDragImage).toHaveBeenCalledTimes(1);
    const [disc, x, y] = setDragImage.mock.calls[0];
    // in the DOM when the browser snapshots it
    expect(disc.isConnected).toBe(true);
    expect(disc.textContent).toBe('10');
    expect(disc.style.borderRadius).toBe('50%');
    expect(disc.style.boxSizing).toBe('border-box');
    expect(disc.style.width).toBe('50px');
    expect(disc.style.height).toBe('50px');
    expect(disc.style.boxShadow).toBe('');
    expect([x, y]).toEqual([25, 25]);

    vi.runAllTimers();
    expect(disc.isConnected).toBe(false);
  });

  it('does nothing where dataTransfer has no setDragImage', () => {
    expect(() => setPlayerDragImage({ dataTransfer: {} }, 7, { bg: '#000', text: '#fff' })).not.toThrow();
    expect(() => setPlayerDragImage({}, 7)).not.toThrow();
  });

  it('is the only drag image the scoreboard builds', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/Scoreboard.jsx'), 'utf8');
    const own = src.split('\n').filter(line => line.includes('setDragImage(') && !line.includes('setPlayerDragImage('));
    expect(own).toEqual([]);
  });
});
