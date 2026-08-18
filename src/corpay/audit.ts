import { appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export interface AuditEvent {
  requestId?: string;
  tool: string;
  action: string;
  teamId?: string;
  method?: string;
  path?: string;
  operationHash?: string;
  idempotencyKey?: string;
  allowed?: boolean;
  reason?: string;
  status?: string;
  error?: string;
}

/**
 * Append one line of JSON per write attempt, when CORPAYONE_AUDIT_LOG names a
 * file. Idempotency keys are hashed rather than stored, so the log can be read
 * by anyone who needs it without handing them a replayable key.
 */
export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  const auditPath = process.env.CORPAYONE_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    ...event,
    idempotencyKey: event.idempotencyKey ? hashValue(event.idempotencyKey) : undefined,
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
