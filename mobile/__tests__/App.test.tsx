/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import App from '../App';

// 30s, not the 5s default: the first run on a cold Jest cache has to transform the
// whole app and every native mock, which took ~14s on a clean machine and made this
// suite fail only on first run (and only in CI). The assertion is unchanged.
test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
}, 30000);
