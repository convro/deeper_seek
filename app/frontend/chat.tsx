import React, { useState, useRef, useEffect } from 'react';
import type { ChatMessage, AgentEvent } from './state';
import { Spinner, EventItem } from './components';

interface ChatProps {
  messages: ChatMessage[];
  events: AgentEvent[];
  isProcessing: boolean;
  onSend: (message: string) => void;
  showEvents: boolean;
  onToggleEvents: () => void;
}

export function Chat({ messages, events, isProcessing, onSend, showEvents, onToggleEvents }: ChatProps) {
  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || isProcessing) return;
    onSend(trimmed);
    setInput('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#4b5563', marginTop: '80px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🧠</div>
            <div style={{ fontSize: '20px', color: '#9ca3af', fontWeight: 600 }}>DeeperSeek</div>
            <div style={{ fontSize: '14px', color: '#4b5563', marginTop: '8px' }}>
              Autonomous AI agent with tools, memory, and multi-agent coordination
            </div>
          </div>
        )}

        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {isProcessing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#6b7280', fontSize: '13px' }}>
            <Spinner />
            <span>DeeperSeek is working...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Events panel toggle */}
      <div style={{
        borderTop: '1px solid #1f2937',
        padding: '6px 12px',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        backgroundColor: '#0f172a',
      }}>
        <button
          onClick={onToggleEvents}
          style={{
            background: 'none',
            border: '1px solid #374151',
            color: '#6b7280',
            borderRadius: '4px',
            padding: '3px 10px',
            cursor: 'pointer',
            fontSize: '11px',
          }}
        >
          {showEvents ? '▼ Hide' : '▶ Show'} tool activity ({events.length})
        </button>
        {isProcessing && events.length > 0 && (
          <span style={{ fontSize: '11px', color: '#3b82f6' }}>
            {events.filter(e => e.type === 'tool_call').length} tool calls
          </span>
        )}
      </div>

      {/* Input area */}
      <div style={{
        padding: '12px',
        borderTop: '1px solid #1f2937',
        backgroundColor: '#111827',
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-end',
      }}>
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything — DeeperSeek will plan, use tools, and deliver results..."
          disabled={isProcessing}
          rows={1}
          style={{
            flex: 1,
            background: '#1f2937',
            border: '1px solid #374151',
            borderRadius: '8px',
            color: '#f3f4f6',
            padding: '10px 14px',
            fontSize: '14px',
            resize: 'none',
            outline: 'none',
            fontFamily: 'inherit',
            lineHeight: '1.5',
            minHeight: '44px',
            maxHeight: '200px',
          }}
        />
        <button
          onClick={handleSubmit}
          disabled={isProcessing || !input.trim()}
          style={{
            background: isProcessing || !input.trim() ? '#1f2937' : '#3b82f6',
            border: 'none',
            borderRadius: '8px',
            color: isProcessing || !input.trim() ? '#4b5563' : '#fff',
            padding: '10px 18px',
            cursor: isProcessing || !input.trim() ? 'not-allowed' : 'pointer',
            fontSize: '14px',
            fontWeight: 600,
            height: '44px',
            transition: 'background 0.15s',
          }}
        >
          {isProcessing ? '...' : '↑ Send'}
        </button>
      </div>
    </div>
  );
}

// ── Message Bubble ─────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: ChatMessage;
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className="msg-appear"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        gap: '4px',
      }}
    >
      <div style={{ fontSize: '11px', color: '#4b5563', paddingLeft: isUser ? 0 : '4px', paddingRight: isUser ? '4px' : 0 }}>
        {isUser ? 'You' : 'DeeperSeek'} · {new Date(message.timestamp).toLocaleTimeString()}
      </div>
      <div
        style={{
          maxWidth: '80%',
          backgroundColor: isUser ? '#1e40af' : '#1f2937',
          color: '#f3f4f6',
          padding: '10px 14px',
          borderRadius: isUser ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
          fontSize: '14px',
          lineHeight: '1.6',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {message.content}
        {message.status === 'streaming' && <Spinner />}
      </div>
    </div>
  );
}

// ── Events Panel ──────────────────────────────────────────────────────────

interface EventsPanelProps {
  events: AgentEvent[];
}

export function EventsPanel({ events }: EventsPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events]);

  return (
    <div style={{
      height: '220px',
      overflowY: 'auto',
      borderTop: '1px solid #1f2937',
      backgroundColor: '#0a0f1a',
    }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #1f2937', color: '#4b5563', fontSize: '11px', fontFamily: 'monospace' }}>
        TOOL ACTIVITY LOG — {events.length} events
      </div>
      {events.length === 0 && (
        <div style={{ color: '#374151', fontSize: '12px', padding: '16px', textAlign: 'center' }}>
          No events yet. Start a conversation to see tool calls appear here in real-time.
        </div>
      )}
      {events.map((event, i) => (
        <EventItem key={i} event={event} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
