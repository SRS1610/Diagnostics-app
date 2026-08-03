// offlineSync.ts
//
// Queue-and-sync pattern for the two network-dependent pieces of this
// app (cosmetic CV inference and device verification/blacklist check)
// so a session can continue in poor-connectivity warehouse conditions.
// See CLAUDE.md "Offline mode" for which operations this does and does
// NOT cover.

export type QueuedOperationType =
  | "report_upload"
  | "device_verification"
  | "cosmetic_inference";

export interface QueuedOperation {
  id: string;
  type: QueuedOperationType;
  payload: unknown;
  createdAt: string;
  attempts: number;
  synced: boolean;
}

const MAX_RETRY_ATTEMPTS = 5;

/**
 * Cosmetic photos and identity data are captured and stored locally
 * regardless of connectivity; only the OUTPUT of remote calls (damage
 * detections, blacklist/activation-lock status) is what's missing until
 * sync completes. The session should let the technician proceed and
 * mark those specific results "pending sync" rather than blocking the
 * whole workflow on a network check.
 */
export function enqueueOperation(
  queue: QueuedOperation[],
  type: QueuedOperationType,
  payload: unknown
): QueuedOperation[] {
  const op: QueuedOperation = {
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    payload,
    createdAt: new Date().toISOString(),
    attempts: 0,
    synced: false,
  };
  return [...queue, op];
}

export async function processQueue(
  queue: QueuedOperation[],
  sendFn: (op: QueuedOperation) => Promise<boolean>
): Promise<QueuedOperation[]> {
  const updated: QueuedOperation[] = [];
  for (const op of queue) {
    if (op.synced) {
      updated.push(op);
      continue;
    }
    if (op.attempts >= MAX_RETRY_ATTEMPTS) {
      updated.push(op); // stop retrying — surface to the technician/admin instead of retrying forever
      continue;
    }
    try {
      const success = await sendFn(op);
      updated.push({ ...op, synced: success, attempts: op.attempts + 1 });
    } catch {
      updated.push({ ...op, attempts: op.attempts + 1 });
    }
  }
  return updated;
}
