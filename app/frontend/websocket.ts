// WebSocket client for DeeperSeek real-time events

import type { AgentEvent } from './state';

type EventHandler = (event: AgentEvent) => void;

export class DeeperSeekWS {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private handlers: Map<string, EventHandler[]> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private shouldReconnect = true;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      const url = `${protocol}://${host}/ws?session_id=${encodeURIComponent(this.sessionId)}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        this.emit('connected', { type: 'connected' });
        resolve();
      };

      this.ws.onmessage = (e) => {
        try {
          const event: AgentEvent = JSON.parse(e.data);
          event.timestamp = event.timestamp || new Date().toISOString();
          this.emit(event.type, event);
          this.emit('*', event);
        } catch {}
      };

      this.ws.onclose = () => {
        this.emit('disconnected', { type: 'disconnected' });
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
        }
      };

      this.ws.onerror = (err) => {
        this.emit('error', { type: 'error', error: 'WebSocket error' });
        reject(err);
      };
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  on(type: string, handler: EventHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  off(type: string, handler: EventHandler) {
    const list = this.handlers.get(type) || [];
    this.handlers.set(type, list.filter(h => h !== handler));
  }

  sendChat(message: string, model?: string) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'chat', message, model }));
    }
  }

  private emit(type: string, event: AgentEvent) {
    (this.handlers.get(type) || []).forEach(h => h(event));
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
