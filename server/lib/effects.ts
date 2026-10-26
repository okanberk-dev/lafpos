import type { LiveEvent } from '@shared/events';
import type { DB, Tx } from '../db/client';
import { schema } from '../db/client';
import { bus } from './events';

type PendingEvent = Omit<LiveEvent, 'seq' | 'at'>;

export interface AuditEntry {
  userId?: string | null;
  approverId?: string | null;
  action: string;
  severity?: 'info' | 'uyari' | 'alarm';
  orderId?: string | null;
  entity?: string | null;
  entityId?: string | null;
  amount?: number | null;
  message: string;
  data?: Record<string, unknown> | null;
}

/**
 * Bir yazma işleminin yan etkileri: denetim kayıtları işlemin içinde yazılır, canlı olaylar ise işlem
 * başarıyla bittikten sonra `flush` ile yayılır (geri alınan işlem ekranlara yanlış olay göndermesin).
 */
export class Effects {
  private events: PendingEvent[] = [];

  emit(event: PendingEvent) {
    this.events.push(event);
    return this;
  }

  audit(t: Tx | DB, entry: AuditEntry) {
    const severity = entry.severity ?? 'info';
    t.insert(schema.auditLog)
      .values({
        at: Date.now(),
        userId: entry.userId ?? null,
        approverId: entry.approverId ?? null,
        action: entry.action,
        severity,
        orderId: entry.orderId ?? null,
        entity: entry.entity ?? null,
        entityId: entry.entityId ?? null,
        amount: entry.amount ?? null,
        message: entry.message,
        data: entry.data ?? null,
      })
      .run();
    if (severity !== 'info') {
      this.events.push({ topic: 'alerts', kind: entry.action, message: entry.message, orderId: entry.orderId ?? undefined, byUserId: entry.userId ?? undefined });
    }
  }

  flush() {
    const seen = new Set<string>();
    for (const e of this.events) {
      const key = `${e.topic}|${e.kind}|${e.orderId ?? ''}|${e.tableId ?? ''}|${e.message ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bus.publish(e);
    }
    this.events = [];
  }
}
