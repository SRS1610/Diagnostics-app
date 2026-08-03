const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// packages/shared is consumed directly rather than mirrored by hand.
// The scaffold's package.json asserted the mobile app must duplicate
// shared types "due to Metro bundler constraints"; that isn't the case —
// Metro resolves a monorepo sibling given watchFolders plus explicit
// resolution, and every external import in shared (qrcode,
// react-native-html-to-pdf) is React Native-compatible.
//
// This matters most for reportRenderer.ts: it is ~450 lines of report
// layout that CLAUDE.md calls "the canonical render path", and keeping a
// hand-synced second copy of it in this package would guarantee the two
// drift, producing PDFs that disagree about what the audit says.
const workspaceRoot = path.resolve(__dirname, '../..');
const projectRoot = __dirname;

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
    extraNodeModules: {
      '@diagnostics/shared': path.resolve(workspaceRoot, 'packages/shared'),
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
