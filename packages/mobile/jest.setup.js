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

// Native module; its real import also constructs a NativeEventEmitter at
// load time, which throws outside a native runtime.
jest.mock('react-native-device-info', () => ({
  getBrand: jest.fn().mockReturnValue('TestBrand'),
  getModel: jest.fn().mockReturnValue('TestModel'),
}));

jest.mock('@react-native-ml-kit/text-recognition', () => ({
  recognize: jest.fn().mockResolvedValue({ text: '', blocks: [] }),
}));

// The library ships its own mock for exactly this purpose.
jest.mock('react-native-sensors', () => require('react-native-sensors/mock'));
