// customerProfile.ts
//
// Lets an admin define a named customer profile with its own subset of
// required tests, and lets a technician load that profile in the mobile
// app by entering its PIN at session start. See CLAUDE.md "Customer
// profiles & PIN-based test sets" for the security caveat on PINs and
// the fallback-behavior decision this still needs.

export interface TestCatalogEntry {
  testId: string;
  label: string;
  component: string; // matches COMPONENT_MAP grouping in reportRenderer.ts
}

// Canonical list of test definitions the app can run. Keep this in sync
// with COMPONENT_MAP in reportRenderer.ts — same testIds, same grouping.
export const TEST_CATALOG: TestCatalogEntry[] = [
  { testId: "lcd", label: "Display (LCD)", component: "Display & Touchscreen" },
  { testId: "digitizer", label: "Touch Digitizer", component: "Display & Touchscreen" },
  { testId: "multitouch", label: "Multi-touch", component: "Display & Touchscreen" },
  { testId: "home_button", label: "Home Button", component: "Buttons & Physical Controls" },
  { testId: "power_button", label: "Power Button", component: "Buttons & Physical Controls" },
  { testId: "volume_up", label: "Volume Up", component: "Buttons & Physical Controls" },
  { testId: "volume_down", label: "Volume Down", component: "Buttons & Physical Controls" },
  { testId: "camera_front", label: "Front Camera", component: "Camera System" },
  { testId: "camera_back", label: "Back Camera", component: "Camera System" },
  { testId: "flashlight", label: "Flashlight", component: "Camera System" },
  { testId: "loud_speaker", label: "Loudspeaker", component: "Audio — Speakers & Microphones" },
  { testId: "microphone", label: "Microphone", component: "Audio — Speakers & Microphones" },
  { testId: "earpiece", label: "Earpiece", component: "Audio — Speakers & Microphones" },
  { testId: "speaker", label: "Speaker Confirmation", component: "Audio — Speakers & Microphones" },
  { testId: "headset_port", label: "Headset Port", component: "Ports & Connectors" },
  { testId: "sd_card", label: "SD Card", component: "Ports & Connectors" },
  { testId: "charging_port", label: "Charging Port", component: "Battery & Charging" },
  { testId: "light_sensor", label: "Light Sensor", component: "Sensors" },
  { testId: "proximity_sensor", label: "Proximity Sensor", component: "Sensors" },
  { testId: "accelerometer", label: "Accelerometer", component: "Sensors" },
  { testId: "gyroscope", label: "Gyroscope", component: "Sensors" },
  { testId: "fingerprint_sensor", label: "Fingerprint Sensor", component: "Sensors" },
  { testId: "battery_health", label: "Battery Health", component: "Battery & Charging" },
  { testId: "battery_charge_level", label: "Charge Level", component: "Battery & Charging" },
  { testId: "wireless_charging", label: "Wireless Charging", component: "Battery & Charging" },
  { testId: "wifi", label: "Wi-Fi", component: "Wireless Radios" },
  { testId: "bluetooth", label: "Bluetooth", component: "Wireless Radios" },
  { testId: "gps", label: "GPS", component: "Wireless Radios" },
  { testId: "nfc", label: "NFC", component: "Wireless Radios" },
  { testId: "sim_reader", label: "SIM Reader", component: "Cellular & SIM" },
  { testId: "network_connectivity", label: "Network Connectivity", component: "Cellular & SIM" },
  { testId: "country_of_origin", label: "Country of Origin", component: "Housing & Cosmetics" },
  { testId: "device_color", label: "Device Color", component: "Housing & Cosmetics" },
  { testId: "cosmetics", label: "Cosmetics", component: "Housing & Cosmetics" },
  { testId: "cosmetic_grading", label: "Cosmetic Grading (AI-assisted)", component: "Housing & Cosmetics" },
  { testId: "liquid_damage", label: "Liquid Damage", component: "Housing & Cosmetics" },
  { testId: "glass_condition", label: "Glass Condition", component: "Housing & Cosmetics" },
];

export interface CustomerProfile {
  profileId: string;
  tenantId: string; // NEW — which tenant this profile belongs to; ALL queries
                     // for profiles/PINs must be scoped to a tenantId, never
                     // global, or one tenant's technician could scan another
                     // tenant's profile QR and load their test config
  customerName: string;
  pin: string; // 4–6 digits, unique WITHIN the tenant (see CLAUDE.md — this
               // changes the earlier "globally unique" PIN decision)
  enabledTestIds: string[];
  createdAt: string;
  updatedAt: string;
}

// Prefixed so the camera scanner can tell a profile QR apart from other
// codes it might see (device barcodes later in the flow use raw digits/
// text with no prefix) — see CLAUDE.md "Profile QR scanning". Payload
// now encodes BOTH tenantId and PIN, not just the PIN — see the note on
// PIN scope below.
const PROFILE_QR_PREFIX = "DIAGPROFILE:";

export function generateProfileQrPayload(profile: CustomerProfile): string {
  return `${PROFILE_QR_PREFIX}${profile.tenantId}:${profile.pin}`;
}

/**
 * Extracts {tenantId, pin} from a scanned QR payload. Returns null if
 * the scanned code isn't a profile QR at all, or is malformed — the
 * caller should treat that as a failed scan, not silently try to
 * resolve garbage.
 *
 * UPDATED under multi-tenancy: the QR now carries the tenant along with
 * the PIN. This replaces the earlier "PINs are globally unique" decision
 * — that doesn't hold once tenants have fully isolated, independently-
 * managed data (Acme Wireless and TechTrade Refurb could both pick PIN
 * 4726 with no conflict, since the QR always identifies which tenant's
 * 4726 it is). PINs only need to be unique WITHIN a tenant now — a much
 * easier constraint to keep than "unique across the whole platform."
 */
export function parseProfileQrPayload(payload: string): { tenantId: string; pin: string } | null {
  if (!payload.startsWith(PROFILE_QR_PREFIX)) return null;
  const rest = payload.slice(PROFILE_QR_PREFIX.length);
  const [tenantId, pin] = rest.split(":");
  if (!tenantId || !pin) return null;
  return { tenantId, pin };
}

/**
 * Resolves a profile from its tenant + PIN, regardless of how that PIN
 * was captured — QR scan (via parseProfileQrPayload, the primary path,
 * which now yields both tenantId and pin together) or manual digit
 * entry (the fallback). Manual entry now ALSO needs a tenantId — since
 * PINs are only unique within a tenant, "4726" alone is ambiguous
 * across tenants. The manual-entry fallback UI needs a tenant
 * picker/lookup (e.g. by company name or a tenant-specific URL) before
 * the PIN digits mean anything — this is a real UI implication of the
 * multi-tenant model, not just a backend change.
 *
 * RESOLVED: on an unrecognized PIN (within the given tenant), this
 * returns null and the caller MUST block the session — never silently
 * fall back to a default profile. The UI should show a clear "PIN not
 * recognized" error with an option to manually pick a profile from a
 * list (an explicit technician choice, not an implicit default) as the
 * recovery path.
 */
export async function resolveProfileByPin(tenantId: string, pin: string): Promise<CustomerProfile | null> {
  const response = await fetch(`${process.env.PROFILE_API_BASE}/tenants/${tenantId}/profiles/by-pin/${pin}`);
  if (response.status === 404) return null;
  return response.json();
}

export function getEnabledTests(profile: CustomerProfile): TestCatalogEntry[] {
  return TEST_CATALOG.filter((t) => profile.enabledTestIds.includes(t.testId));
}

export function groupEnabledTestsByComponent(
  profile: CustomerProfile
): Map<string, TestCatalogEntry[]> {
  const enabled = getEnabledTests(profile);
  const groups = new Map<string, TestCatalogEntry[]>();
  for (const t of enabled) {
    if (!groups.has(t.component)) groups.set(t.component, []);
    groups.get(t.component)!.push(t);
  }
  return groups;
}
