// batchSession.ts
//
// Bulk intake mode for processing a pallet/lot of devices from a single
// source (e.g. a carrier buyback or corporate refresh) as one batch,
// rather than one unrelated session per device. See CLAUDE.md "Bulk
// batch intake" for how this interacts with customer profiles — a
// batch is typically tied to one profile/PIN for the whole lot.

export interface BatchSession {
  batchId: string;
  source: string; // e.g. "Carrier Buyback Lot #4521"
  profileId: string; // the customer profile applied to every device in this batch
  expectedDeviceCount?: number;
  scannedSerials: string[];
  startedAt: string;
  completedAt?: string;
}

export function createBatchSession(params: {
  source: string;
  profileId: string;
  expectedDeviceCount?: number;
}): BatchSession {
  return {
    batchId: `BATCH-${Date.now()}`,
    source: params.source,
    profileId: params.profileId,
    expectedDeviceCount: params.expectedDeviceCount,
    scannedSerials: [],
    startedAt: new Date().toISOString(),
  };
}

export function addDeviceToBatch(batch: BatchSession, serial: string): BatchSession {
  if (batch.scannedSerials.includes(serial)) return batch; // don't double-count a re-scan
  return { ...batch, scannedSerials: [...batch.scannedSerials, serial] };
}
