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
