import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HomePage from '../app/(marketing)/page';

// Test the actual marketing home page component
describe('HomePage', () => {
  it('renders the main heading', () => {
    render(<HomePage />);
    expect(
      screen.getByRole('heading', { level: 1, name: /Universal MCP Orchestration Hub/i })
    ).toBeInTheDocument();
  });

  it('renders navigation links', () => {
    render(<HomePage />);
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign in/i })).toBeInTheDocument();
  });
});
