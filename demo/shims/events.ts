/** Tarayıcı demosunda `node:events`: sunucunun kullandığı kadar EventEmitter */
type Listener = (...args: never[]) => void;

export class EventEmitter {
  private listeners = new Map<string | symbol, Listener[]>();

  on(name: string | symbol, fn: Listener): this {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
    return this;
  }

  addListener(name: string | symbol, fn: Listener): this {
    return this.on(name, fn);
  }

  once(name: string | symbol, fn: Listener): this {
    const wrapped = ((...args: never[]) => {
      this.off(name, wrapped);
      fn(...args);
    }) as Listener;
    return this.on(name, wrapped);
  }

  off(name: string | symbol, fn: Listener): this {
    const list = this.listeners.get(name);
    if (!list) return this;
    const i = list.lastIndexOf(fn);
    if (i >= 0) this.listeners.set(name, [...list.slice(0, i), ...list.slice(i + 1)]);
    return this;
  }

  removeListener(name: string | symbol, fn: Listener): this {
    return this.off(name, fn);
  }

  removeAllListeners(name?: string | symbol): this {
    if (name === undefined) this.listeners.clear();
    else this.listeners.delete(name);
    return this;
  }

  emit(name: string | symbol, ...args: unknown[]): boolean {
    const list = this.listeners.get(name);
    if (!list?.length) return false;
    for (const fn of list) (fn as (...a: unknown[]) => void)(...args);
    return true;
  }

  listenerCount(name: string | symbol): number {
    return this.listeners.get(name)?.length ?? 0;
  }

  setMaxListeners(_n: number): this {
    return this;
  }
}

export default { EventEmitter };
