// src/config/index.ts
//
// API_BASE_URL is hardcoded for now — react-native-config (or similar)
// would be the standard way to make this environment-configurable, but
// that's a new native dependency beyond the pre-approved list in
// README.md, so it's flagged here rather than added silently. Ask
// before adding it.
//
// 10.0.2.2 is the Android emulator's alias for the host machine's
// localhost; iOS Simulator can reach the host directly as localhost. A
// physical device needs the host's real LAN IP instead of either.

import { Platform } from 'react-native';

export const API_BASE_URL = Platform.select({
  android: 'http://10.0.2.2:4000',
  default: 'http://localhost:4000',
});
