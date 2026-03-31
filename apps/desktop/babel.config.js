module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    ["@babel/plugin-proposal-decorators", { legacy: true }],
    [
      "module-resolver",
      {
        root: ["./"],
        alias: {
          "@": "./src",
        },
      },
    ],
  ],
};
