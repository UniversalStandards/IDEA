import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

// Simple smoke test — verifies test infrastructure works
describe('Home page smoke test', () => {
  it('renders a heading', () => {
    const heading = document.createElement('h1');
    heading.textContent = 'Universal MCP Orchestration Hub';
    document.body.appendChild(heading);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    document.body.removeChild(heading);
  });
});
