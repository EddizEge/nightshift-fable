import type { GameEvents, IEventBus } from './types';

type Handler = (e: never) => void;

export class EventBus implements IEventBus {
  private handlers = new Map<string, Handler[]>();

  on<K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void): () => void {
    let list = this.handlers.get(type);
    if (!list) this.handlers.set(type, (list = []));
    list.push(fn as Handler);
    return () => this.off(type, fn);
  }

  off<K extends keyof GameEvents>(type: K, fn: (e: GameEvents[K]) => void): void {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn as Handler);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends keyof GameEvents>(type: K, e: GameEvents[K]): void {
    const list = this.handlers.get(type);
    if (!list) return;
    // Copy: handlers may unsubscribe while we iterate.
    for (const fn of list.slice()) {
      try {
        (fn as (e: GameEvents[K]) => void)(e);
      } catch (err) {
        console.error(`[events] handler for "${type}" failed`, err);
      }
    }
  }
}
