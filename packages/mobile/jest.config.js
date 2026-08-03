module.exports = {
  preset: '@react-native/jest-preset',
  // @react-navigation and react-native-vision-camera ship untranspiled
  // ESM. The RN preset's default transformIgnorePatterns doesn't cover
  // them, so Jest hits "Unexpected token 'export'" without this.
  transformIgnorePatterns: [
    'node_modules/(?!(?:@react-native|react-native|@react-navigation|react-native-vision-camera|react-native-screens|react-native-safe-area-context)/)',
  ],
  setupFiles: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    // packages/shared is consumed directly (see metro.config.js). Jest
    // babel-transforms its compiled output, which injects @babel/runtime
    // helper imports that cannot resolve from the shared package's own
    // directory — point them at this package's copy.
    '^@babel/runtime/(.*)$': '<rootDir>/node_modules/@babel/runtime/$1',
  },
};
