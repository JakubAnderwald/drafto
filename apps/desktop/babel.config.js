module.exports = {
  presets: ["module:@react-native/babel-preset"],
  plugins: [
    ["@babel/plugin-proposal-decorators", { legacy: true }],
    [
      "module:react-native-dotenv",
      {
        envName: "APP_ENV",
        moduleName: "@env",
        path: ".env",
        safe: false,
        allowUndefined: true,
      },
    ],
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
