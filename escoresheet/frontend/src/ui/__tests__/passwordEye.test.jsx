import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Input } from '../Input.jsx';

describe('Input type=password', () => {
  it('has a show/hide eye that toggles the field type', () => {
    const { container } = render(<Input type="password" aria-label="Password" defaultValue="hunter22" />);
    const field = container.querySelector('input');
    expect(field.type).toBe('password');
    fireEvent.click(screen.getByTestId('password-eye'));
    expect(field.type).toBe('text');
    expect(field.value).toBe('hunter22');
    fireEvent.click(screen.getByTestId('password-eye'));
    expect(field.type).toBe('password');
  });
  it('plain inputs get no eye', () => {
    render(<Input type="text" aria-label="Name" />);
    expect(screen.queryByTestId('password-eye')).toBeNull();
  });
});
