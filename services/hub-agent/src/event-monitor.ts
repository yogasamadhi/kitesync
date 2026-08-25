import type { SyncthingClient } from './syncthing-client.js';

export interface BufferedSyncthingEvent {
  id: number;
  time: string;
  type: string;
  data: Record<string, unknown>;
}

export class EventMonitor {
  private cursor = 0;
  private readonly events: BufferedSyncthingEvent[] = [];
  private abortController: AbortController | undefined;

  constructor(private readonly client: SyncthingClient) {}

  start() {
    if (this.abortController) return;
    this.abortController = new AbortController();
    void this.loop(this.abortController.signal);
  }

  stop() {
    this.abortController?.abort();
    this.abortController = undefined;
  }

  after(cursor: number) {
    return this.events.filter((event) => event.id > cursor);
  }

  private async loop(signal: AbortSignal) {
    while (!signal.aborted) {
      try {
        const events = await this.client.events(this.cursor, 30, signal);
        for (const event of events) {
          if (this.cursor !== 0 && event.id > this.cursor + 1) {
            this.events.push({
              id: event.id,
              time: event.time,
              type: 'KiteSyncEventGap',
              data: { expected: this.cursor + 1, actual: event.id },
            });
          }
          this.cursor = Math.max(this.cursor, event.id);
          this.events.push(event);
        }
        if (this.events.length > 1_000) this.events.splice(0, this.events.length - 1_000);
      } catch {
        if (signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
}
