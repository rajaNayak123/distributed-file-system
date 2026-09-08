/**
 * Reconciliation processor stub — Phase 7.
 *
 * Full reconciliation logic (cross-checking DynamoDB metadata against actual
 * S3 object existence and vice-versa) is scoped to Phase 7. This stub
 * registers the processor in the routing table and logs, so the plumbing is
 * correct and Phase 7 only needs to fill in the body.
 *
 * Processor contract:
 *   - Return normally → caller deletes the SQS message (ack).
 *   - Throw → caller does NOT delete → SQS re-delivers after visibility timeout.
 */
export async function processReconciliation(message) {
  const { fileId, userId } = message;
  console.log(JSON.stringify({
    level: 'info',
    event: 'reconciliation_stub',
    fileId,
    userId,
    note: 'Full reconciliation logic is Phase 7. This is a no-op stub.',
  }));
  // No-op: return normally so the message is acked and not retried forever.
}
