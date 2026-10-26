import { EventEmitter } from 'node:events';
import type { LiveEvent } from '@shared/events';

/**
 * Bütün cihazlara (kasa, garson telefonları, mutfak/bar ekranı, patron paneli) anlık değişiklik yayını.
 * Yazma işlemi bitince `publish` çağrılır; istemciler olayı alınca ilgili sorguları yeniler.
 */
class LiveBus extends EventEmitter {
  private seq = 0;

  publish(event: Omit<LiveEvent, 'seq' | 'at'>) {
    const full: LiveEvent = { ...event, seq: ++this.seq, at: Date.now() } as LiveEvent;
    this.emit('event', full);
  }
}

export const bus = new LiveBus();
bus.setMaxListeners(200);
