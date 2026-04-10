import './styles.css';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

import { DeeperSeekWS } from './websocket';
import { sendMessage } from './api';
import { MessagesList, InputArea } from './chat';
import { EventsDrawer, StatusDot } from './components';
import { Workspace } from './workspace';
import { Agents } from './agents';
import { Uploads } from './uploads';
import type { ChatMessage, AgentEvent, ToolCallRecord } from './state';
import { generateSessionId, generateId } from './state';

type Tab = 'chat' | 'workspace' | 'agents' | 'uploads';

// ── App ───────────────────────────────────────────────────────────────────

function App() {
  const sessionId  = useRef(generateSessionId()).current;
  const wsRef      = useRef<DeeperSeekWS | null>(null);

  // ── KEY FIX: store pending assistant message ID in a ref ─────────────
  // This avoids closure/timing bugs — no "search for streaming message" needed
  const pendingMsgId = useRef<string | null>(null);
  const pendingToolCallIds = useRef<Map<string, string>>(new Map()); // call_id → msg_id

  const [messages,    setMessages]    = useState<ChatMessage[]>([]);
  const [events,      setEvents]      = useState<AgentEvent[]>([]);
  const [processing,  setProcessing]  = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab,   setActiveTab]   = useState<Tab>('chat');
  const [eventsOpen,  setEventsOpen]  = useState(false);
  const [mobileMenu,  setMobileMenu]  = useState(false);

  // ── Update a message by its ID ────────────────────────────────────────
  const updateMsg = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, []);

  // ── Append a tool call record to a message ────────────────────────────
  const addToolCall = useCallback((msgId: string, tc: ToolCallRecord) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId
        ? { ...m, toolCalls: [...(m.toolCalls || []), tc] }
        : m
    ));
  }, []);

  const updateToolCall = useCallback((msgId: string, callId: string, patch: Partial<ToolCallRecord>) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== msgId) return m;
      return {
        ...m,
        toolCalls: (m.toolCalls || []).map(tc =>
          tc.id === callId ? { ...tc, ...patch } : tc
        ),
      };
    }));
  }, []);

  // ── WebSocket setup ───────────────────────────────────────────────────
  useEffect(() => {
    const ws = new DeeperSeekWS(sessionId);
    wsRef.current = ws;

    ws.on('connected',    () => setWsConnected(true));
    ws.on('disconnected', () => setWsConnected(false));

    // All events → activity log
    ws.on('*', (event) => {
      const ev = { ...event, timestamp: new Date().toISOString() };
      setEvents(prev => [...prev.slice(-1000), ev]);

      // Auto-open events drawer when tool calls start
      if (event.type === 'tool_call') {
        setEventsOpen(true);
      }
    });

    // LLM started
    ws.on('llm_start', () => {
      if (pendingMsgId.current) {
        updateMsg(pendingMsgId.current, { status: 'thinking' });
      }
    });

    // Partial content (full text for now, since we don't stream token-by-token)
    ws.on('content', (event) => {
      if (pendingMsgId.current && event.content) {
        updateMsg(pendingMsgId.current, {
          content: event.content,
          status: 'streaming',
        });
      }
    });

    // Reasoning chain (DeepSeek R1)
    ws.on('reasoning', (event) => {
      if (pendingMsgId.current && event.content) {
        updateMsg(pendingMsgId.current, { reasoning: event.content });
      }
    });

    // Tool call started
    ws.on('tool_call', (event) => {
      const msgId = pendingMsgId.current;
      if (!msgId || !event.tool || !event.call_id) return;

      const tc: ToolCallRecord = {
        id: event.call_id,
        tool: event.tool,
        args: event.args || {},
        status: 'pending',
      };
      pendingToolCallIds.current.set(event.call_id, msgId);
      addToolCall(msgId, tc);
    });

    // Tool result
    ws.on('tool_result', (event) => {
      if (!event.call_id) return;
      const msgId = pendingToolCallIds.current.get(event.call_id);
      if (!msgId) return;

      updateToolCall(msgId, event.call_id, {
        result: event.result,
        error: event.error,
        status: event.status === 'error' ? 'error' : 'done',
        duration_ms: event.duration_ms,
      });
    });

    // Done — primary completion signal from llm.service.js
    ws.on('done', (event) => {
      const id = pendingMsgId.current;
      if (!id) return;
      if (event.content) {
        updateMsg(id, {
          content: event.content,
          status: 'done',
          rounds: event.rounds,
          usage: event.usage,
        });
        pendingMsgId.current = null;
        setProcessing(false);
      }
    });

    // Final — secondary completion from chat.controller.js
    ws.on('final', (event) => {
      const id = pendingMsgId.current;
      // Only handle if 'done' didn't already clear it
      if (!id) return;
      if (event.content) {
        updateMsg(id, {
          content: event.content,
          status: 'done',
          rounds: event.rounds,
          usage: event.usage,
        });
        pendingMsgId.current = null;
        setProcessing(false);
      }
    });

    // Error
    ws.on('error', (event) => {
      const id = pendingMsgId.current;
      if (id) {
        updateMsg(id, {
          content: `Error: ${event.error || 'Unknown error'}`,
          status: 'error',
        });
        pendingMsgId.current = null;
      }
      setProcessing(false);
    });

    ws.connect().catch(() => {});
    return () => ws.disconnect();
  }, [sessionId, updateMsg, addToolCall, updateToolCall]);

  // ── Send message ──────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string) => {
    if (processing) return;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      status: 'done',
    };

    const assistantId = generateId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      status: 'thinking',
    };

    // Set pending ID BEFORE the state update so WS events don't miss it
    pendingMsgId.current = assistantId;
    pendingToolCallIds.current.clear();
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setEvents([]);
    setProcessing(true);

    try {
      await sendMessage(text, sessionId);
    } catch (err: any) {
      updateMsg(assistantId, { content: `Error: ${err.message}`, status: 'error' });
      pendingMsgId.current = null;
      setProcessing(false);
    }
  }, [processing, sessionId, updateMsg]);

  // ── Tabs ──────────────────────────────────────────────────────────────
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'chat',      label: 'Chat',      icon: '💬' },
    { id: 'workspace', label: 'Workspace', icon: '📁' },
    { id: 'agents',    label: 'Agents',    icon: '🤖' },
    { id: 'uploads',   label: 'Uploads',   icon: '📎' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        height: 50,
        padding: '0 16px',
        background: 'var(--bg2)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        gap: 12,
        zIndex: 10,
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
          <span style={{ fontSize: 20 }}>🧠</span>
          <span style={{ fontWeight: 800, fontSize: 16, color: 'var(--accent)', letterSpacing: '-0.3px' }}>
            DeeperSeek
          </span>
        </div>

        {/* Tabs — desktop */}
        <nav className="hide-mobile" style={{ display: 'flex', gap: 2, flex: 1 }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: activeTab === t.id ? 'var(--bg4)' : 'none',
                border: activeTab === t.id ? '1px solid var(--border)' : '1px solid transparent',
                borderRadius: 7,
                color: activeTab === t.id ? 'var(--text)' : 'var(--text2)',
                padding: '4px 12px',
                fontSize: 13,
                fontWeight: activeTab === t.id ? 600 : 400,
                transition: 'all 0.12s',
              }}
            >
              <span>{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>

        {/* Mobile: hamburger */}
        <button
          className="show-mobile"
          onClick={() => setMobileMenu(m => !m)}
          style={{
            display: 'none',
            background: 'none', border: 'none',
            color: 'var(--text2)', fontSize: 18, padding: '4px 8px',
          }}
        >
          ☰
        </button>

        {/* Status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto', flexShrink: 0 }}>
          <StatusDot connected={wsConnected} />
          <span className="hide-mobile" style={{ fontSize: 12, color: 'var(--text3)' }}>
            {wsConnected ? 'Live' : 'Connecting'}
          </span>
        </div>
      </header>

      {/* ── Mobile nav dropdown ─────────────────────────────────────────── */}
      {mobileMenu && (
        <div style={{
          background: 'var(--bg2)',
          borderBottom: '1px solid var(--border)',
          padding: '8px 16px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 6,
          zIndex: 10,
        }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => { setActiveTab(t.id); setMobileMenu(false); }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: activeTab === t.id ? 'var(--bg4)' : 'none',
                border: '1px solid var(--border)',
                borderRadius: 7,
                color: activeTab === t.id ? 'var(--text)' : 'var(--text2)',
                padding: '6px 14px',
                fontSize: 14,
              }}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
      )}

      {/* ── Main content ────────────────────────────────────────────────── */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {activeTab === 'chat' && (
          <>
            {/* Messages — scrollable */}
            <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <MessagesList messages={messages} />
            </div>

            {/* Tool activity drawer */}
            <EventsDrawer
              events={events}
              open={eventsOpen}
              onToggle={() => setEventsOpen(o => !o)}
              processing={processing}
            />

            {/* Input */}
            <InputArea onSend={handleSend} disabled={processing} />
          </>
        )}

        {activeTab === 'workspace' && <Workspace />}
        {activeTab === 'agents'    && <Agents />}
        {activeTab === 'uploads'   && <Uploads />}
      </main>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────
createRoot(document.getElementById('root')!).render(<App />);
