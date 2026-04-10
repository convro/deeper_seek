import React, { useRef, useEffect, useState } from 'react';
import type { ChatMessage, ToolCallRecord } from './state';
import { Spinner, TypingDots, ThinkingBlock, ToolCallBadge } from './components';
import { Markdown } from './markdown';

// ── Message bubble ────────────────────────────────────────────────────────

interface MsgProps { message: ChatMessage }

function UserMessage({ message }: MsgProps) {
  return (
    <div className="anim-fade-up" style={{
      display: 'flex',
      justifyContent: 'flex-end',
      padding: '4px 0',
    }}>
      <div style={{
        maxWidth: 'min(75%, 620px)',
        background: 'var(--accent2)',
        color: '#fff',
        padding: '10px 15px',
        borderRadius: '18px 18px 4px 18px',
        fontSize: 15,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}>
        {message.content}
      </div>
    </div>
  );
}

function AssistantMessage({ message }: MsgProps) {
  const isThinking = message.status === 'thinking';
  const isError    = message.status === 'error';

  return (
    <div className="anim-fade-up" style={{
      display: 'flex',
      gap: 10,
      padding: '4px 0',
      maxWidth: '100%',
    }}>
      {/* Avatar */}
      <div style={{
        width: 28, height: 28,
        borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--accent2), var(--purple))',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 13,
        flexShrink: 0,
        marginTop: 2,
      }}>
        🧠
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Thinking indicator */}
        {isThinking && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text2)', fontSize: 13 }}>
            <TypingDots />
            <span>Thinking…</span>
          </div>
        )}

        {/* Reasoning chain */}
        {message.reasoning && !isThinking && (
          <ThinkingBlock content={message.reasoning} />
        )}

        {/* Tool calls */}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div style={{ marginBottom: 8, display: 'flex', flexWrap: 'wrap' }}>
            {message.toolCalls.map(tc => <ToolCallBadge key={tc.id} tc={tc} />)}
          </div>
        )}

        {/* Content */}
        {!isThinking && message.content && (
          <div style={{
            color: isError ? 'var(--red)' : 'var(--text)',
            lineHeight: 1.7,
          }}>
            <Markdown content={message.content} />
          </div>
        )}

        {/* Cursor blink while streaming */}
        {message.status === 'streaming' && (
          <span style={{
            display: 'inline-block',
            width: 2, height: '1em',
            background: 'var(--text2)',
            verticalAlign: 'text-bottom',
            marginLeft: 2,
            animation: 'blink 1s step-end infinite',
          }} />
        )}

        {/* Meta (usage, rounds) */}
        {message.status === 'done' && message.usage && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text3)', display: 'flex', gap: 10 }}>
            {message.rounds && <span>{message.rounds} round{message.rounds > 1 ? 's' : ''}</span>}
            <span>↑{message.usage.prompt_tokens} ↓{message.usage.completion_tokens} tokens</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Message list ──────────────────────────────────────────────────────────

interface MessagesListProps { messages: ChatMessage[] }

export function MessagesList({ messages }: MessagesListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        color: 'var(--text3)',
        padding: '40px 20px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: 52 }}>🧠</div>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text2)' }}>DeeperSeek</div>
        <div style={{ fontSize: 14, color: 'var(--text3)', maxWidth: 380 }}>
          Autonomous AI agent with tools, memory, and multi-agent orchestration.
          Ask anything — it plans, executes, and delivers real results.
        </div>
        <div style={{
          display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8,
        }}>
          {[
            'Write a Python scraper for this website',
            'Analyze this codebase and find bugs',
            'Research the latest AI papers',
            'Build a REST API with tests',
          ].map(ex => (
            <div key={ex} style={{
              background: 'var(--bg3)',
              border: '1px solid var(--border)',
              borderRadius: 20,
              padding: '6px 14px',
              fontSize: 12,
              color: 'var(--text2)',
              cursor: 'default',
            }}>
              {ex}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {messages.map(msg => (
        msg.role === 'user'
          ? <UserMessage key={msg.id} message={msg} />
          : <AssistantMessage key={msg.id} message={msg} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Input area ────────────────────────────────────────────────────────────

interface InputAreaProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function InputArea({ onSend, disabled }: InputAreaProps) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const t = value.trim();
    if (!t || disabled) return;
    onSend(t);
    setValue('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 180) + 'px';
  };

  return (
    <div style={{
      padding: '10px 16px 14px',
      background: 'var(--bg)',
      borderTop: '1px solid var(--border)',
    }}>
      <div style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-end',
        background: 'var(--bg3)',
        border: `1px solid ${disabled ? 'var(--border)' : 'var(--border)'}`,
        borderRadius: 14,
        padding: '6px 6px 6px 14px',
        transition: 'border-color 0.15s',
      }}
        onFocus={() => {}}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={onChange}
          onKeyDown={onKey}
          disabled={disabled}
          placeholder={disabled ? 'DeeperSeek is working…' : 'Message DeeperSeek…'}
          rows={1}
          style={{
            flex: 1,
            background: 'none',
            border: 'none',
            outline: 'none',
            color: 'var(--text)',
            fontSize: 15,
            lineHeight: 1.5,
            resize: 'none',
            maxHeight: 180,
            padding: '4px 0',
            cursor: disabled ? 'not-allowed' : 'text',
          }}
        />
        <button
          onClick={submit}
          disabled={disabled || !value.trim()}
          style={{
            width: 36, height: 36,
            borderRadius: 10,
            background: disabled || !value.trim() ? 'var(--bg4)' : 'var(--accent2)',
            border: 'none',
            color: disabled || !value.trim() ? 'var(--text3)' : '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16,
            cursor: disabled || !value.trim() ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s',
            flexShrink: 0,
          }}
        >
          {disabled ? <Spinner size={14} color="var(--text3)" /> : '↑'}
        </button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 6, fontSize: 11, color: 'var(--text3)' }}>
        Enter to send · Shift+Enter for new line
      </div>
    </div>
  );
}
