module.exports = function berryMobileBabel(api) {
  api.cache(true);
  // babel-preset-expo adds the Reanimated/Worklets plugin automatically.
  return { presets: ["babel-preset-expo"] };
};
