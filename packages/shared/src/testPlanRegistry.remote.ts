// testPlanRegistry.remote.ts
// Source: test_plan_return_keys.md — Remote mode
//
// Maps each TestPlanKey (as sent to/expected by the backend/Odoo) to its
// possible ReturnKey(s). Most map 1:1; a few TestPlanKeys have multiple
// ReturnKeys because they represent grouped or variant sub-tests
// (e.g. Digitizer has several test-pattern variants; Dual Call Test
// covers two SIM slots).
//
// Two entries use DYNAMIC child keys rather than a fixed list — see
// helper functions below.

export interface TestPlanEntry {
  testPlanKey: string;
  returnKeys: string[];
}

export const REMOTE_TEST_PLAN_REGISTRY: TestPlanEntry[] = [
  { testPlanKey: "MID Test", returnKeys: ["MID Test"] },
  { testPlanKey: "WiFi", returnKeys: ["WiFi"] },
  { testPlanKey: "Bluetooth", returnKeys: ["Bluetooth"] },
  { testPlanKey: "Factory Reset", returnKeys: ["Factory Reset"] },
  { testPlanKey: "GPS", returnKeys: ["GPS"] },
  { testPlanKey: "SW Version", returnKeys: ["SW Version"] },
  { testPlanKey: "Light Sensor", returnKeys: ["Light Sensor"] },
  { testPlanKey: "Proximity Sensor", returnKeys: ["Proximity Sensor"] },
  { testPlanKey: "NFC", returnKeys: ["NFC"] },
  { testPlanKey: "Manual NFC", returnKeys: ["NFC"] },
  { testPlanKey: "Advanced NFC", returnKeys: ["Advanced NFC"] },
  { testPlanKey: "Wireless Charging", returnKeys: ["Wireless Charging"] },
  { testPlanKey: "LCD", returnKeys: ["LCD"] },
  { testPlanKey: "Liquid Damage", returnKeys: ["Liquid Damage"] },
  { testPlanKey: "Glass Condition", returnKeys: ["Glass Condition"] },
  { testPlanKey: "Brightness", returnKeys: ["Brightness"] },
  { testPlanKey: "Failure Reasons", returnKeys: ["Failure Reasons", "hardstop"] },
  { testPlanKey: "Device Color", returnKeys: ["Device Color"] },
  { testPlanKey: "Country of origin", returnKeys: ["Country of origin"] },
  { testPlanKey: "Home Button", returnKeys: ["Home Button"] },
  { testPlanKey: "Menu Button", returnKeys: ["Menu Button"] },
  { testPlanKey: "Back Button", returnKeys: ["Back Button"] },
  { testPlanKey: "Power Button", returnKeys: ["Power Button"] },
  { testPlanKey: "Magnetic Shoulder Keys", returnKeys: ["Magnetic Left Shoulder", "Magnetic Right Shoulder"] },
  { testPlanKey: "Volume Up Button", returnKeys: ["Volume Up Button"] },
  { testPlanKey: "Volume Down Button", returnKeys: ["Volume Down Button"] },
  { testPlanKey: "Bixby Button", returnKeys: ["Bixby Button"] },
  { testPlanKey: "Alert Slider", returnKeys: ["Alert Slider"] },
  { testPlanKey: "Camera Control Button", returnKeys: ["Camera Control Button"] },
  { testPlanKey: "Vibration", returnKeys: ["Vibration"] },
  { testPlanKey: "Front Camera Focus", returnKeys: ["Front Camera Focus"] },
  { testPlanKey: "Rear Camera Focus", returnKeys: ["Rear Camera Focus"] },
  { testPlanKey: "Front Video Camera", returnKeys: ["Front Video Camera"] },
  { testPlanKey: "Rear Video Camera", returnKeys: ["Rear Video Camera"] },
  { testPlanKey: "Rear Cam to Gallery", returnKeys: ["Rear Cam to Gallery"] },
  { testPlanKey: "Front Camera", returnKeys: ["Front Camera"] },
  { testPlanKey: "Front Camera Quality", returnKeys: ["Front Camera Quality"] },
  { testPlanKey: "Rear Camera", returnKeys: ["Rear Camera"] },
  { testPlanKey: "Rear Camera Quality", returnKeys: ["Rear Camera Quality"] },
  { testPlanKey: "UltraWide Camera", returnKeys: ["UltraWide Camera"] },
  { testPlanKey: "UltraWide Camera Quality", returnKeys: ["UltraWide Camera Quality"] },
  { testPlanKey: "Telephoto Camera", returnKeys: ["Telephoto Camera"] },
  { testPlanKey: "Telephoto Camera Quality", returnKeys: ["Telephoto Camera Quality"] },
  { testPlanKey: "Macro Camera", returnKeys: ["Macro Camera"] },
  { testPlanKey: "Macro Camera Quality", returnKeys: ["Macro Camera Quality"] },
  { testPlanKey: "Capture Testername", returnKeys: ["Capture Testername"] },
  { testPlanKey: "Flashlight", returnKeys: ["Flashlight"] },
  { testPlanKey: "Loud Speaker", returnKeys: ["Loud Speaker"] },
  { testPlanKey: "Microphone", returnKeys: ["Microphone"] },
  { testPlanKey: "Video Microphone", returnKeys: ["Video Microphone"] },
  { testPlanKey: "Earpiece", returnKeys: ["Earpiece"] },
  { testPlanKey: "Force Touch", returnKeys: ["Force Touch"] },
  { testPlanKey: "Digitizer", returnKeys: ["Digitizer", "FullScreenBubbleTest", "fullScreenDigitizerBlocks", "Digitizer N Pattern", "Sam Digi", "Maze Digitizer"] },
  { testPlanKey: "MultiTouch", returnKeys: ["MultiTouch"] },
  { testPlanKey: "Fingerprint Sensor", returnKeys: ["Fingerprint Sensor"] },
  { testPlanKey: "Loudspeaker Ringtone", returnKeys: ["Loudspeaker Ringtone"] },
  { testPlanKey: "Loudspeaker Ringtone Left", returnKeys: ["Loudspeaker Ringtone Left"] },
  { testPlanKey: "Loudspeaker Ringtone Right", returnKeys: ["Loudspeaker Ringtone Right"] },
  { testPlanKey: "Loudspeaker Quality", returnKeys: ["Loudspeaker Quality"] },
  { testPlanKey: "Loudspeaker Quality Left", returnKeys: ["Loudspeaker Quality Left"] },
  { testPlanKey: "Loudspeaker Quality Right", returnKeys: ["Loudspeaker Quality Right"] },
  { testPlanKey: "Earpiece Ringtone", returnKeys: ["Earpiece Ringtone"] },
  { testPlanKey: "Speaker Cleaning", returnKeys: ["Speaker Cleaning"] },
  { testPlanKey: "Earpiece Quality", returnKeys: ["Earpiece Quality"] },
  { testPlanKey: "Bottom Mic Quality", returnKeys: ["Bottom Mic Quality"] },
  { testPlanKey: "Rear Mic Quality", returnKeys: ["Rear Mic Quality"] },
  { testPlanKey: "Headset Port", returnKeys: ["Headset Port"] },
  { testPlanKey: "Headset-Right", returnKeys: ["Headset-Right"] },
  { testPlanKey: "Headset-Left", returnKeys: ["Headset-Left"] },
  { testPlanKey: "Headset Volume Up", returnKeys: ["Headset Volume Up"] },
  { testPlanKey: "Headset Volume Down", returnKeys: ["Headset Volume Down"] },
  { testPlanKey: "Headset Media Button", returnKeys: ["Headset Media Button"] },
  { testPlanKey: "Headset USB-C Port", returnKeys: ["Headset USB-C Port"] },
  { testPlanKey: "Mic Recording", returnKeys: ["Mic Recording"] },
  { testPlanKey: "Accelerometer", returnKeys: ["Accelerometer"] },
  { testPlanKey: "Gyroscope", returnKeys: ["Gyroscope"] },
  { testPlanKey: "Screen Rotation", returnKeys: ["Screen Rotation"] },
  { testPlanKey: "Barometer", returnKeys: ["Barometer"] },
  { testPlanKey: "QR Test", returnKeys: ["QR Test"] },
  { testPlanKey: "Stylus", returnKeys: ["Stylus"] },
  { testPlanKey: "SPen", returnKeys: ["SPen"] },
  { testPlanKey: "Call Test", returnKeys: ["Sim Reader", "Network Connectivity"] },
  { testPlanKey: "Dual Call Test", returnKeys: ["SIM Reader 1", "Network Connectivity 1", "SIM Reader 2", "Network Connectivity 2"] },
  { testPlanKey: "Sim Reader", returnKeys: ["Sim Reader"] },
  { testPlanKey: "Sim Remove", returnKeys: ["Sim Remove"] },
  { testPlanKey: "Proximity Sensor WITH CALL", returnKeys: ["Proximity Sensor"] },
  { testPlanKey: "Proximity Sensor WITH Dual CALL", returnKeys: ["Proximity Sensor"] },
  { testPlanKey: "Secondary Light Sensor", returnKeys: ["Secondary Light Sensor"] },
  { testPlanKey: "Secondary LCD", returnKeys: ["Secondary LCD"] },
  { testPlanKey: "Secondary Glass Cracked", returnKeys: ["Secondary Glass Cracked"] },
  { testPlanKey: "Secondary Brightness", returnKeys: ["Secondary Brightness"] },
  { testPlanKey: "Secondary Front Camera Focus", returnKeys: ["Secondary Front Camera Focus"] },
  { testPlanKey: "Secondary Front Camera", returnKeys: ["Secondary Front Camera"] },
  { testPlanKey: "Secondary Front Camera Quality", returnKeys: ["Secondary Front Camera Quality"] },
  { testPlanKey: "Secondary Digitizer", returnKeys: ["Secondary Digitizer"] },
  { testPlanKey: "Secondary MultiTouch", returnKeys: ["Secondary MultiTouch"] },
  { testPlanKey: "Cover Screen LCD", returnKeys: ["Cover Screen LCD"] },
  { testPlanKey: "Cover Screen Digitizer", returnKeys: ["Cover Screen Digitizer"] },
  { testPlanKey: "Cosmetics", returnKeys: ["Cosmetics", "!@#$%|{shortKey}!@#$%|"] },
  { testPlanKey: "Grading", returnKeys: ["Grading"] },
  { testPlanKey: "felica", returnKeys: ["felica"] },
  { testPlanKey: "Custom Tests Start", returnKeys: ["Custom Tests Start"] },
  { testPlanKey: "Custom Tests", returnKeys: ["Custom Tests", "C-…"] },
  { testPlanKey: "SD Card Detect", returnKeys: ["SD Card Detect"] },
  { testPlanKey: "SD Card Remove", returnKeys: ["SD Card Remove"] },
  { testPlanKey: "Device Lock", returnKeys: ["Device Lock"] },
  { testPlanKey: "Notes", returnKeys: ["Notes"] },
  { testPlanKey: "LPN", returnKeys: ["LPN"] },
];

// --- Lookup helpers ---

/** Find a registry entry by its TestPlanKey. */
export function getTestPlanEntry(testPlanKey: string): TestPlanEntry | undefined {
  return REMOTE_TEST_PLAN_REGISTRY.find((e) => e.testPlanKey === testPlanKey);
}

/**
 * Resolve an incoming ReturnKey back to its parent TestPlanKey.
 * Handles the two dynamic-pattern cases (Custom Tests children, Cosmetics
 * children) in addition to normal exact matches.
 */
export function resolveTestPlanKeyFromReturnKey(returnKey: string): string | undefined {
  // Dynamic: Custom Tests children are prefixed "C-"
  if (returnKey.startsWith("C-")) return "Custom Tests";

  // Dynamic: Cosmetics children use the !@#$%|{shortKey}!@#$%| delimiter pattern
  if (/^!@#\$%\|.*!@#\$%\|$/.test(returnKey)) return "Cosmetics";

  const match = REMOTE_TEST_PLAN_REGISTRY.find((e) => e.returnKeys.includes(returnKey));
  return match?.testPlanKey;
}
