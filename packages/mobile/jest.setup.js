// jest.setup.js
//
// react-native-vision-camera is a native module with no JS-only
// fallback — importing it under Jest (no native runtime) throws. The
// smoke test only needs the navigation tree to mount, so stub the
// surface QrScannerView touches.

jest.mock('react-native-vision-camera', () => ({
  Camera: () => null,
  useCameraDevice: () => undefined,
  useCameraPermission: () => ({ hasPermission: false, requestPermission: jest.fn() }),
  useCodeScanner: (config) => config,
}));

// Likewise native-only. exists() resolving false models a fresh,
// unbound device — the state the smoke test should render.
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn().mockResolvedValue(false),
  readFile: jest.fn().mockResolvedValue('{}'),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
}));
