// Static assets bundled into the app binary. Fonts land in
// android/app/src/main/assets/fonts via `npx react-native-asset`
// (rerun it after adding a font; the next Gradle build embeds them).
module.exports = {
  project: {
    android: {},
  },
  assets: ['./assets/fonts'],
};
