const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * watchFolders lets the app import the SHARED transfer engine (../shared/engine.js)
 * that lives at the repo root — one source of truth for desktop + mobile.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '../shared')],
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
