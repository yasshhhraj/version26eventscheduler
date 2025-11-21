import React from 'react';
import { render, screen } from '@testing-library/react';
import App from './App';

test('renders schedule heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /schedule/i, level: 1 })).toBeInTheDocument();
});
