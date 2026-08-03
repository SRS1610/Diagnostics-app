/**
 * @format
 */

import RNFS from 'react-native-fs';
import { clearDeviceTenant, loadDeviceTenant, saveDeviceTenant } from '../src/lib/deviceTenant';

const mockFs = RNFS as jest.Mocked<typeof RNFS>;

describe('deviceTenant', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null on a fresh device with no binding file', async () => {
    mockFs.exists.mockResolvedValue(false);
    await expect(loadDeviceTenant()).resolves.toBeNull();
  });

  it('round-trips a saved binding', async () => {
    await saveDeviceTenant('ten_abc123', 'Acme Wireless');

    const [, written] = mockFs.writeFile.mock.calls[0];
    mockFs.exists.mockResolvedValue(true);
    mockFs.readFile.mockResolvedValue(written);

    const loaded = await loadDeviceTenant();
    expect(loaded).toMatchObject({ tenantId: 'ten_abc123', companyName: 'Acme Wireless' });
    expect(loaded?.boundAt).toBeTruthy();
  });

  // The important failure mode: a corrupt binding must degrade to
  // "unbound" so the technician can re-scan, never throw and hard-block
  // login on the device.
  it('treats unparseable JSON as no binding rather than throwing', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readFile.mockResolvedValue('{ this is not json');
    await expect(loadDeviceTenant()).resolves.toBeNull();
  });

  it('treats a well-formed but incomplete binding as no binding', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readFile.mockResolvedValue(JSON.stringify({ tenantId: 'ten_abc123' }));
    await expect(loadDeviceTenant()).resolves.toBeNull();
  });

  it('treats a read failure as no binding rather than throwing', async () => {
    mockFs.exists.mockResolvedValue(true);
    mockFs.readFile.mockRejectedValue(new Error('EACCES'));
    await expect(loadDeviceTenant()).resolves.toBeNull();
  });

  it('removes the binding file when clearing for a redeployed tablet', async () => {
    mockFs.exists.mockResolvedValue(true);
    await clearDeviceTenant();
    expect(mockFs.unlink).toHaveBeenCalled();
  });

  it('does not throw when clearing an already-unbound device', async () => {
    mockFs.exists.mockResolvedValue(false);
    await expect(clearDeviceTenant()).resolves.toBeUndefined();
    expect(mockFs.unlink).not.toHaveBeenCalled();
  });
});
