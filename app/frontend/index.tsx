import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat, EventsPanel } from './chat';
import { Workspace } from './workspace';
import { Agents } from './agents';
import { Uploads } from './uploads';
import { StatusDot } from './components';
import { DeeperSeekWS } from './websocket';
import { sendMessage } from './api';
import type { ChatMessage, AgentEvent, AppState } from './state';
import { generateSessionId, generateId } from './state';

// ── Global styles ─────────────────────────────────────────────────────────────
const globalStyle = document.createElement('style');
globalStyle.textContent = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; background: #0d1117; color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  button { font-family: inherit; }
  textarea { font-family: inherit; }
`;
document.head.appendChild(globalStyle);

// ── App ───────────────────────────────────────────────────────────────────────
function App() {
  const sessionId = useRef(generateSessionId()).current;
  const ws = useRef<DeeperSeekWS | null>(null);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<'chat' | 'workspace' | 'agents' | 'uploads'>('chat');
  const [showEvents, setShowEvents] = useState(true);

  // Initialize WebSocket
  useEffect(() => {
    const client = new DeeperSeekWS(sessionId);
    ws.current = client;

    client.on('connected', () => setWsConnected(true));
    client.on('disconnected', () => setWsConnected(false));

    client.on('*', (event) => {
      // Add timestamped event to log
      setEvents(prev => [...prev.slice(-500), { ...event, timestamp: new Date().toISOString() }]);

      switch (event.type) {
        case 'content':
        case 'final':
          if (event.content) {
            setMessages(prev => {
              const lastAssistant = [...prev].reverse().find(m => m.role === 'assistant' && m.status === 'streaming');
              if (lastAssistant && event.type === 'content') {
                return prev.map(m => m.id === lastAssistant.id
                  ? { ...m, content: event.content!, status: 'streaming' }
                  : m
                );
              }
              if (event.type === 'final') {
                const existing = [...prev].reverse().find(m => m.role === 'assistant' && m.status === 'streaming');
                if (existing) {
                  return prev.map(m => m.id === existing.id
                    ? { ...m, content: event.content!, status: 'done' }
                    : m
                  );
                }
                return [...prev, {
                  id: generateId(),
                  role: 'assistant',
                  content: event.content!,
                  timestamp: new Date().toISOString(),
                  status: 'done',
                }];
              }
              return prev;
            });
            if (event.type === 'final') setIsProcessing(false);
          }
          break;

        case 'error':
          setMessages(prev => {
            const streaming = [...prev].reverse().find(m => m.status === 'streaming');
            if (streaming) {
              return prev.map(m => m.id === streaming.id
                ? { ...m, content: `Error: ${event.error}`, status: 'error' }
                : m
              );
            }
            return prev;
          });
          setIsProcessing(false);
          break;
      }
    });

    client.connect().catch(() => {});

    return () => client.disconnect();
  }, []);

  const handleSend = useCallback(async (text: string) => {
    if (isProcessing) return;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      status: 'done',
    };

    const assistantMsg: ChatMessage = {
      id: generateId(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      status: 'streaming',
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsProcessing(true);
    setEvents([]);

    try {
      // Send via HTTP (response comes via WebSocket)
      await sendMessage(text, sessionId);
    } catch (err: any) {
      setMessages(prev => prev.map(m =>
        m.id === assistantMsg.id
          ? { ...m, content: `Error: ${err.message}`, status: 'error' }
          : m
      ));
      setIsProcessing(false);
    }
  }, [isProcessing, sessionId]);

  const tabs = [
    { id: 'chat', label: '💬 Chat' },
    { id: 'workspace', label: '📁 Workspace' },
    { id: 'agents', label: '🤖 Agents' },
    { id: 'uploads', label: '📎 Uploads' },
  ] as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        padding: '0 16px',
        height: '48px',
        backgroundColor: '#111827',
        borderBottom: '1px solid #1f2937',
        flexShrink: 0,
        gap: '16px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '18px' }}>🧠</span>
          <span style={{ fontWeight: 700, fontSize: '16px', color: '#60a5fa' }}>DeeperSeek</span>
          <span style={{ color: '#374151', fontSize: '11px' }}>autonomous AI</span>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '4px', flex: 1 }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{
                background: activeTab === tab.id ? '#1e3a5f' : 'none',
                border: 'none',
                borderRadius: '6px',
                color: activeTab === tab.id ? '#60a5fa' : '#6b7280',
                padding: '5px 12px',
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: activeTab === tab.id ? 600 : 400,
                transition: 'all 0.1s',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#4b5563' }}>
          <StatusDot connected={wsConnected} />
          <span>{wsConnected ? 'Connected' : 'Connecting...'}</span>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'chat' && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              <Chat
                messages={messages}
                events={events}
                isProcessing={isProcessing}
                onSend={handleSend}
                showEvents={showEvents}
                onToggleEvents={() => setShowEvents(e => !e)}
              />
            </div>
            {showEvents && <EventsPanel events={events} />}
          </div>
        )}
        {activeTab === 'workspace' && <Workspace />}
        {activeTab === 'agents' && <Agents />}
        {activeTab === 'uploads' && <Uploads />}
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
