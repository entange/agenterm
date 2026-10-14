import mitt, { type Emitter } from 'mitt';
import type { AgentermEvent } from '@agenterm/core';

type BusEventMap = {
  event: AgentermEvent;
};

/**
 * Live event bus feeding the socket fan-out. Nothing is stored: the task
 * table holds state and terminal.log holds output.
 */
export class EventBus {
  private readonly emitter: Emitter<BusEventMap> = mitt<BusEventMap>();

  onEvent(handler: (event: AgentermEvent) => void): () => void {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  publish(event: AgentermEvent): void {
    this.emitter.emit('event', event);
  }
}
