// WebSocket client for DeeperSeek real-time events

import type { AgentEvent } from './state';
import { getAuthToken } from './api';

type EventHandler = (event: AgentEvent) => void;

export class DeeperSeekWS {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private handlers: Map<string, EventHandler[]> = new Map();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private shouldReconnect = true;

  private onVisible: () => void;
  private onOnline: () => void;

  constructor(sessionId: string) {
    this.sessionId = sessionId;

    // Force immediate reconnect when the page becomes visible again (iOS PWA
    // freezes JS when the screen goes off, which kills the WS connection).
    this.onVisible = () => {
      if (!this.shouldReconnect) return;
      if (document.visibilityState !== 'visible') return;
      const state = this.ws?.readyState;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING || state == null) {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.reconnectDelay = 1000;
        this.connect().catch(() => {});
      }
    };

    // Same logic when network comes back after being offline.
    this.onOnline = () => {
      if (!this.shouldReconnect) return;
      const state = this.ws?.readyState;
      if (state === WebSocket.CLOSED || state === WebSocket.CLOSING || state == null) {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.reconnectDelay = 1000;
        this.connect().catch(() => {});
      }
    };

    document.addEventListener('visibilitychange', this.onVisible);
    window.addEventListener('online', this.onOnline);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.host;
      const token = getAuthToken();
      const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
      const url = `${protocol}://${host}/ws?session_id=${encodeURIComponent(this.sessionId)}${tokenParam}`;

      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectDelay = 1000;
        this.emit('connected', { type: 'connected' });
        // Heartbeat: send ping every 15s to keep connection alive through proxies.
        // 15s gives enough margin before the server's 30s keep-alive timeout.
        if (this.pingInterval) clearInterval(this.pingInterval);
        this.pingInterval = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'ping' }));
          }
        }, 15_000);
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
        if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
        if (this.shouldReconnect) {
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10000);
        }
      };

      this.ws.onerror = () => {
        // Transport-level errors (network drop, iOS suspension) are handled by
        // onclose → auto-reconnect. Emitting an 'error' event here would
        // incorrectly mark the pending AI message as errored. Server-level
        // errors (auth failure, bad request) arrive as WS messages and are
        // handled by onmessage → emit('error', ...) via the normal path.
        reject(new Error('WebSocket connection failed'));
      };
    });
  }

  disconnect() {
    this.shouldReconnect = false;
    document.removeEventListener('visibilitychange', this.onVisible);
    window.removeEventListener('online', this.onOnline);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingInterval) { clearInterval(this.pingInterval); this.pingInterval = null; }
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
