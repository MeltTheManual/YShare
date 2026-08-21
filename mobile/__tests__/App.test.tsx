/**
 * @format
 */

import React from 'react';
import ReactTestRenderer from 'react-test-renderer';
import {Linking} from 'react-native';
import App from '../App';

// 30s, not the 5s default: the first run on a cold Jest cache has to transform the
// whole app and every native mock, which took ~14s on a clean machine and made this
// suite fail only on first run (and only in CI). The assertion is unchanged.
test('renders correctly', async () => {
  await ReactTestRenderer.act(() => {
    ReactTestRenderer.create(<App />);
  });
}, 30000);

test('shows an invalid connection-link error on the landing screen', async () => {
  jest.spyOn(Linking, 'getInitialURL').mockResolvedValueOnce('yshare://connect/#v1/offer/YS1.bad');
  let view: ReactTestRenderer.ReactTestRenderer;
  await ReactTestRenderer.act(async () => {
    view = ReactTestRenderer.create(<App />);
    await Promise.resolve();
  });
  const text = JSON.stringify(view!.toJSON());
  expect(text).toContain('that YShare connection link is invalid or incomplete');
}, 30000);
