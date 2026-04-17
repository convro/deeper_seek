import './styles.css';
import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import { createRoot } from 'react-dom/client';

import { DeeperSeekWS }   from './websocket';
import { sendMessage, listConversations, getConversation, renameConversation, deleteConversation, resetSoul, togglePinConversation } from './api';
import { MessagesList, InputArea } from './chat';
import { EventsDrawer, StatusDot, Spinner } from './components';
import { Workspace } from './workspace';
import { Agents }   from './agents';
import { useAuth, AuthScreen, UserMenu } from './auth';
import { Onboarding } from './onboarding';
import type {
  ChatMessage, AgentEvent, ToolCallRecord, Conversation, Attachment, MessageStatus,
  LiveAgent,
} from './state';
import { generateSessionId, generateId } from './state';

const LOGO_URL = 'https://r.convro.eu/content/Stable/realises/ds73';

type Tab = 'chat' | 'workspace' | 'agents';

// ── Relative time helper ──────────────────────────────────────────────────
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000)  return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

// ── Sidebar component ─────────────────────────────────────────────────────
interface SidebarProps {
  conversations: Conversation[];
  activeId: string;
  activeTab: Tab;
  onSelect: (c: Conversation) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  onTabChange: (tab: Tab) => void;
  loading: boolean;
  userMenu?: React.ReactNode;
}

const TAB_DEFS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'chat', label: 'Chat',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z"/>
      </svg>
    ),
  },
  {
    id: 'workspace', label: 'Workspace',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"/>
      </svg>
    ),
  },
  {
    id: 'agents', label: 'Agents',
    icon: (
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM4.5 7.5a.5.5 0 0 0 0 1h5.793l-2.147 2.146a.5.5 0 0 0 .708.708l3-3a.5.5 0 0 0 0-.708l-3-3a.5.5 0 1 0-.708.708L10.293 7.5H4.5Z"/>
      </svg>
    ),
  },
];

function Sidebar({
  conversations, activeId, activeTab, onSelect, onNew, onDelete, onRename, onTogglePin, onTabChange, loading, userMenu,
}: SidebarProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle,  setEditTitle]  = useState('');
  const [hoverId, setHoverId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const startEdit = (c: Conversation) => {
    setEditingId(c.id);
    setEditTitle(c.title);
    setTimeout(() => editRef.current?.select(), 30);
  };

  const commitEdit = (id: string) => {
    const t = editTitle.trim();
    if (t) onRename(id, t);
    setEditingId(null);
  };

  const grouped = useMemo(() => {
    const pinned: Conversation[] = [];
    const today:  Conversation[] = [];
    const week:   Conversation[] = [];
    const older:  Conversation[] = [];
    const now = Date.now();
    for (const c of conversations) {
      if (c.pinned) { pinned.push(c); continue; }
      const diff = now - new Date(c.updated_at || c.created_at).getTime();
      if (diff < 86_400_000)      today.push(c);
      else if (diff < 604_800_000) week.push(c);
      else                         older.push(c);
    }
    // Pinned newest-first by pin time, falling back to updated_at
    pinned.sort((a, b) =>
      new Date(b.pinned_at || b.updated_at || b.created_at).getTime() -
      new Date(a.pinned_at || a.updated_at || a.created_at).getTime()
    );
    return { pinned, today, week, older };
  }, [conversations]);

  const Group = ({ label, items, pinnedGroup = false }: { label: string; items: Conversation[]; pinnedGroup?: boolean }) => {
    if (!items.length) return null;
    return (
      <>
        <div className={`sidebar-group-label ${pinnedGroup ? 'sidebar-group-pinned' : ''}`}>{label}</div>
        {items.map(c => (
          <ConvItem
            key={c.id}
            c={c}
            active={c.id === activeId}
            hovered={hoverId === c.id}
            editing={editingId === c.id}
            editTitle={editTitle}
            editRef={editRef}
            onSelect={onSelect}
            onStartEdit={startEdit}
            onCommitEdit={commitEdit}
            onDelete={onDelete}
            onTogglePin={onTogglePin}
            setHoverId={setHoverId}
            setEditTitle={setEditTitle}
          />
        ))}
      </>
    );
  };

  return (
    <div className="sidebar">
      {/* Header */}
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img src={LOGO_URL} alt="DeeperSeek" className="sidebar-logo-img" />
          <span className="sidebar-logo-text">DeeperSeek</span>
        </div>
        <button className="sidebar-new-btn" onClick={onNew} title="New conversation">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a.75.75 0 0 1 .75.75v5.5h5.5a.75.75 0 0 1 0 1.5h-5.5v5.5a.75.75 0 0 1-1.5 0v-5.5H1.75a.75.75 0 0 1 0-1.5h5.5V1.75A.75.75 0 0 1 8 1z"/>
          </svg>
        </button>
      </div>

      {/* Conv list */}
      <div className="sidebar-list">
        {loading && (
          <div style={{ padding: '20px', textAlign: 'center' }}>
            <Spinner size={16} />
          </div>
        )}
        {!loading && conversations.length === 0 && (
          <div className="sidebar-empty">No conversations yet.<br />Start a new one above!</div>
        )}
        <Group label="📌 Pinned"   items={grouped.pinned} pinnedGroup />
        <Group label="Today"       items={grouped.today} />
        <Group label="This week"   items={grouped.week}  />
        <Group label="Older"       items={grouped.older} />
      </div>

      {/* Tab navigation — Chat / Workspace / Agents */}
      <div className="sidebar-tabs">
        {TAB_DEFS.map(t => (
          <button
            key={t.id}
            className={`sidebar-tab-btn ${activeTab === t.id ? 'sidebar-tab-active' : ''}`}
            onClick={() => onTabChange(t.id)}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* User menu (only present when auth is active) */}
      {userMenu && <div className="sidebar-user">{userMenu}</div>}
    </div>
  );
}

interface ConvItemProps {
  c: Conversation;
  active: boolean;
  hovered: boolean;
  editing: boolean;
  editTitle: string;
  editRef: React.RefObject<HTMLInputElement>;
  onSelect: (c: Conversation) => void;
  onStartEdit: (c: Conversation) => void;
  onCommitEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  setHoverId: (id: string | null) => void;
  setEditTitle: (t: string) => void;
}

function ConvItem({
  c, active, hovered, editing, editTitle, editRef,
  onSelect, onStartEdit, onCommitEdit, onDelete, onTogglePin, setHoverId, setEditTitle,
}: ConvItemProps) {
  const isPinned = !!c.pinned;
  return (
    <div
      className={`sidebar-item ${active ? 'active' : ''} ${isPinned ? 'pinned' : ''}`}
      onClick={() => !editing && onSelect(c)}
      onMouseEnter={() => setHoverId(c.id)}
      onMouseLeave={() => setHoverId(null)}
    >
      <div className="sidebar-item-icon">
        {isPinned ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.6">
            <path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.457 1.457 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Z"/>
          </svg>
        )}
      </div>
      <div className="sidebar-item-content">
        {editing ? (
          <input
            ref={editRef}
            value={editTitle}
            onChange={e => setEditTitle(e.target.value)}
            onBlur={() => onCommitEdit(c.id)}
            onKeyDown={e => {
              if (e.key === 'Enter') onCommitEdit(c.id);
              if (e.key === 'Escape') { setEditTitle(c.title); onCommitEdit(c.id); }
            }}
            onClick={e => e.stopPropagation()}
            className="sidebar-edit-input"
          />
        ) : (
          <>
            <div className="sidebar-item-title">{c.title}</div>
            <div className="sidebar-item-meta">{relTime(c.updated_at || c.created_at)}</div>
          </>
        )}
      </div>
      {(hovered || active) && !editing && (
        <div className="sidebar-item-actions" onClick={e => e.stopPropagation()}>
          <button
            className={`sidebar-action-btn ${isPinned ? 'pin-active' : ''}`}
            onClick={() => onTogglePin(c.id, !isPinned)}
            title={isPinned ? 'Unpin' : 'Pin to top'}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/>
            </svg>
          </button>
          <button
            className="sidebar-action-btn"
            onClick={() => onStartEdit(c)}
            title="Rename"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11.013 1.427a1.75 1.75 0 0 1 2.474 0l1.086 1.086a1.75 1.75 0 0 1 0 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 0 1-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.609Z"/>
            </svg>
          </button>
          <button
            className="sidebar-action-btn danger"
            onClick={() => onDelete(c.id)}
            title="Delete"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M11 1.75V3h2.25a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1 0-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75ZM4.496 6.675l.66 6.6a.25.25 0 0 0 .249.225h5.19a.25.25 0 0 0 .249-.225l.66-6.6a.75.75 0 0 1 1.492.149l-.66 6.6A1.748 1.748 0 0 1 10.595 15h-5.19a1.75 1.75 0 0 1-1.741-1.575l-.66-6.6a.75.75 0 1 1 1.492-.15Z"/>
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────────────────
function App() {
  // ── Auth state ────────────────────────────────────────────────────────
  const [auth, authActions] = useAuth();

  // ── Conversations state ───────────────────────────────────────────────
  const [conversations,  setConversations]  = useState<Conversation[]>([]);
  const [activeConvId,   setActiveConvId]   = useState<string>(() => generateSessionId());
  const [convsLoading,   setConvsLoading]   = useState(true);
  const [sidebarOpen,    setSidebarOpen]    = useState(true);   // desktop persistent
  const [mobileSidebar,  setMobileSidebar]  = useState(false);  // mobile overlay

  // ── Chat state ────────────────────────────────────────────────────────
  const wsRef          = useRef<DeeperSeekWS | null>(null);
  const pendingMsgId   = useRef<string | null>(null);
  const pendingToolIds = useRef<Map<string, string>>(new Map());
  const processingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [messages,    setMessages]    = useState<ChatMessage[]>([]);
  const [events,      setEvents]      = useState<AgentEvent[]>([]);
  const [processing,  setProcessing]  = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [activeTab,   setActiveTab]   = useState<Tab>('chat');
  const [eventsOpen,  setEventsOpen]  = useState(false);
  // Live sub-agent map — keyed by agent_id. Updated from WS events; used by
  // both the Agents sidebar tab (real-time, no polling lag) and the inline
  // sub-agent badges in chat messages.
  const [liveAgents,  setLiveAgents]  = useState<Map<string, LiveAgent>>(() => new Map());
  // Correlation: agent_id → { msgId, callId } so we can tag the parent
  // agent_spawn tool call when sub-agent events arrive.
  const agentToCall   = useRef<Map<string, { msgId: string; callId: string }>>(new Map());

  // ── Msg helpers ───────────────────────────────────────────────────────
  const updateMsg = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m));
  }, []);

  const addToolCall = useCallback((msgId: string, tc: ToolCallRecord) => {
    setMessages(prev => prev.map(m =>
      m.id === msgId ? { ...m, toolCalls: [...(m.toolCalls || []), tc] } : m
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

  // ── WS setup (per active conversation) ───────────────────────────────
  const setupWs = useCallback((sessionId: string) => {
    wsRef.current?.disconnect();
    const ws = new DeeperSeekWS(sessionId);
    wsRef.current = ws;

    ws.on('connected',    () => setWsConnected(true));
    ws.on('disconnected', () => setWsConnected(false));

    ws.on('*', (event) => {
      // Don't pollute Tool Activity with heartbeat / streaming deltas /
      // reasoning snapshots (reasoning is already shown in the chain-of-thought)
      const SKIP = new Set(['pong', 'ping', 'connected', 'disconnected', 'llm_start',
                            'content_delta', 'reasoning_delta', 'reasoning', 'content']);
      if (!SKIP.has(event.type)) {
        setEvents(prev => [...prev.slice(-500), { ...event, timestamp: new Date().toISOString() }]);
      }

      // ── Sub-agent live tracking ────────────────────────────────────
      // Backend forwards sub-agent events with `agent_id` + `agent_type`
      // attached. We aggregate them into `liveAgents` so both the sidebar
      // tab and the inline chat badges render in real-time, no polling.
      if (event.agent_id && event.agent_type) {
        const aid = event.agent_id;
        const now = new Date().toISOString();
        setLiveAgents(prev => {
          const next = new Map(prev);
          const cur: LiveAgent = next.get(aid) ?? {
            id:          aid,
            type:        event.agent_type!,
            status:      'running',
            toolCount:   0,
            startedAt:   now,
            eventCount:  0,
            lastEventAt: now,
          };
          const updated: LiveAgent = {
            ...cur,
            type:        event.agent_type || cur.type,
            eventCount:  cur.eventCount + 1,
            lastEventAt: now,
          };
          if (event.type === 'tool_call' && event.tool) {
            updated.toolCount   = cur.toolCount + 1;
            updated.currentTool = event.tool;
          }
          if (event.type === 'content_delta' && event.delta) {
            updated.lastText = ((cur.lastText || '') + event.delta).slice(-400);
          } else if (event.type === 'content' && event.content) {
            updated.lastText = String(event.content).slice(-400);
          }
          if (event.type === 'done' || event.type === 'final') {
            updated.status      = 'completed';
            updated.completedAt = now;
            if (event.content) updated.result = String(event.content);
          }
          if (event.type === 'error') {
            updated.status      = 'failed';
            updated.completedAt = now;
            updated.error       = event.error || 'unknown error';
          }
          next.set(aid, updated);
          return next;
        });

        // Tag the parent agent_spawn tool call so the chat bubble can find
        // the sub-agent's live state via state.spawnedAgentId.
        const link = agentToCall.current.get(aid);
        if (link) {
          updateToolCall(link.msgId, link.callId, { spawnedAgentId: aid });
        }
      }
    });

    ws.on('llm_start', () => {
      if (pendingMsgId.current) updateMsg(pendingMsgId.current, { status: 'thinking' });
    });

    // ── Streaming deltas (word-by-word) ───────────────────────────────
    ws.on('content_delta', (event) => {
      const id = pendingMsgId.current;
      if (!id || !event.delta) return;
      setMessages(prev => prev.map(m =>
        m.id === id
          ? { ...m, content: (m.content || '') + event.delta, status: 'streaming' as MessageStatus }
          : m
      ));
    });

    ws.on('reasoning_delta', (event) => {
      const id = pendingMsgId.current;
      if (!id || !event.delta) return;
      setMessages(prev => prev.map(m =>
        m.id === id
          ? { ...m, reasoning: (m.reasoning || '') + event.delta }
          : m
      ));
    });

    // ── Full snapshots (backward compat / sub-agents) ─────────────────
    ws.on('content', (event) => {
      if (pendingMsgId.current && event.content) {
        updateMsg(pendingMsgId.current, { content: event.content, status: 'streaming' });
      }
    });

    ws.on('reasoning', (event) => {
      if (pendingMsgId.current && event.content) {
        updateMsg(pendingMsgId.current, { reasoning: event.content });
      }
    });

    ws.on('tool_call', (event) => {
      const msgId = pendingMsgId.current;
      if (!msgId || !event.tool || !event.call_id) return;
      const tc: ToolCallRecord = {
        id: event.call_id, tool: event.tool, args: event.args || {}, status: 'pending',
      };
      pendingToolIds.current.set(event.call_id, msgId);
      addToolCall(msgId, tc);
    });

    ws.on('tool_result', (event) => {
      if (!event.call_id) return;
      const msgId = pendingToolIds.current.get(event.call_id);
      if (!msgId) return;
      // Correlation: agent_spawn returns { agent_id } in result. Stash the
      // mapping so subsequent sub-agent events (which carry agent_id) can be
      // attached back to this exact tool call for inline rendering.
      const r = event.result as { agent_id?: string } | undefined;
      const spawnedId = r && typeof r === 'object' ? r.agent_id : undefined;
      if (spawnedId) {
        agentToCall.current.set(spawnedId, { msgId, callId: event.call_id });
      }
      updateToolCall(msgId, event.call_id, {
        result: event.result, error: event.error,
        status: event.status === 'error' ? 'error' : 'done',
        duration_ms: event.duration_ms,
        ...(spawnedId ? { spawnedAgentId: spawnedId } : {}),
      });
    });

    const finalize = (event: AgentEvent) => {
      const id = pendingMsgId.current;
      if (!id) return;
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
      // With streaming, content was already delivered via content_delta events.
      // Use event.content only if present (non-streaming agents), otherwise
      // just flip status to 'done' preserving whatever was already streamed.
      setMessages(prev => prev.map(m => {
        if (m.id !== id) return m;
        return {
          ...m,
          ...(event.content ? { content: event.content } : {}),
          status: 'done' as MessageStatus,
          rounds: event.rounds ?? m.rounds,
          usage:  event.usage  ?? m.usage,
        };
      }));
      pendingMsgId.current = null;
      setProcessing(false);
      loadConversations();
    };

    ws.on('done',  finalize);
    ws.on('final', finalize);

    ws.on('error', (event) => {
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
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
  }, [updateMsg, addToolCall, updateToolCall]);

  // ── Load conversations ────────────────────────────────────────────────
  const loadConversations = useCallback(async () => {
    try {
      const data = await listConversations();
      setConversations(data.sessions || []);
    } catch {}
    setConvsLoading(false);
  }, []);

  // ── Pin .app-root to the visual viewport (iOS keyboard fix) ─────────
  // On iOS Safari, opening the keyboard shrinks the visual viewport and
  // pans (scrolls) it so the focused input stays visible.  Fixed-position
  // elements are anchored to the *layout* viewport (unchanged), so they
  // appear to slide off-screen.  We compensate by tracking both the
  // visual-viewport height *and* its scroll offset, then applying them
  // directly to .app-root (which is position:fixed).
  //
  // NOTE: deps include auth state — on first mount the auth screen may
  // be rendered (no .app-root yet), so the effect must re-run once the
  // user logs in and .app-root actually appears in the DOM.
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.querySelector('.app-root') as HTMLElement | null;
    if (!root) return;

    // Capture the full-screen height *before* any keyboard opens.
    // We track the maximum height seen so orientation changes are covered.
    let fullHeight = vv ? vv.height : window.innerHeight;

    const update = () => {
      const h   = vv ? vv.height   : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;

      // Update baseline whenever viewport grows (keyboard closed / rotated)
      if (h > fullHeight) fullHeight = h;

      root.style.height = h + 'px';
      root.style.top    = top + 'px';

      // Detect virtual keyboard — compare against the stored full height
      // (window.innerHeight can shrink on some iOS versions, making the
      //  old comparison useless)
      const kbOpen = h < fullHeight * 0.85;
      document.body.classList.toggle('keyboard-open', kbOpen);

      // Keep messages pinned to bottom when keyboard opens
      if (kbOpen) {
        const ml = document.querySelector('.messages-list');
        if (ml) ml.scrollTop = ml.scrollHeight;
      }

      // Kill any residual document-level scroll iOS may have introduced
      window.scrollTo(0, 0);
    };

    update();

    if (vv) {
      vv.addEventListener('resize', update, { passive: true });
      vv.addEventListener('scroll', update, { passive: true });
    } else {
      window.addEventListener('resize', update, { passive: true });
    }

    return () => {
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      } else {
        window.removeEventListener('resize', update);
      }
    };
  }, [auth.ready, auth.user?.id]);

  // ── Swipe gesture to open/close mobile sidebar ─────────────────────
  useEffect(() => {
    const isMobile = () => window.innerWidth <= 768;
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let direction: 'open' | 'close' | null = null;

    const EDGE_ZONE = 30;        // px from left edge to start "open" swipe
    const MIN_DISTANCE = 50;     // px swipe to trigger open/close
    const MAX_Y_DRIFT = 80;      // ignore mostly-vertical swipes

    const onTouchStart = (e: TouchEvent) => {
      if (!isMobile()) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;

      const sidebarEl = document.querySelector('.sidebar-wrapper.sidebar-mobile');
      const sidebarOpen = sidebarEl?.classList.contains('sidebar-mobile-open');

      if (!sidebarOpen && startX < EDGE_ZONE) {
        // Start tracking "open" swipe from left edge
        tracking = true;
        direction = 'open';
      } else if (sidebarOpen) {
        // Start tracking "close" swipe anywhere
        tracking = true;
        direction = 'close';
      }
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!tracking) return;
      const dx = e.touches[0].clientX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      // Cancel if mostly vertical
      if (dy > MAX_Y_DRIFT) { tracking = false; return; }
      // Prevent page scroll while swiping sidebar
      if (Math.abs(dx) > 10) e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!tracking) return;
      tracking = false;
      const endX = e.changedTouches[0].clientX;
      const dx = endX - startX;
      const dy = Math.abs(e.changedTouches[0].clientY - startY);

      if (dy > MAX_Y_DRIFT) return;

      if (direction === 'open' && dx > MIN_DISTANCE) {
        setMobileSidebar(true);
      } else if (direction === 'close' && dx < -MIN_DISTANCE) {
        setMobileSidebar(false);
      }
      direction = null;
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, []);

  // ── Init ──────────────────────────────────────────────────────────────
  // Wait for auth to settle before fetching — otherwise the very first
  // /api/chat/sessions call fires before the bearer token is restored
  // from localStorage, returns 401, and trips the global "auth required"
  // listener which immediately logs the user out.
  useEffect(() => {
    if (!auth.ready) return;
    if (auth.mode === 'multi_user' && !auth.user) return;
    loadConversations();
    setupWs(activeConvId);
    return () => wsRef.current?.disconnect();
  }, [auth.ready, auth.user?.id]); // eslint-disable-line

  // ── Create new conversation ───────────────────────────────────────────
  const newConversation = useCallback(() => {
    const id = generateSessionId();
    setActiveConvId(id);
    setMessages([]);
    setEvents([]);
    setConversations(prev => [{
      id,
      title: 'New conversation',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      message_count: 0,
      last_message: null,
    }, ...prev]);
    setMobileSidebar(false);
    setupWs(id);
  }, [setupWs]);

  // ── Switch conversation ───────────────────────────────────────────────
  const switchConversation = useCallback(async (conv: Conversation) => {
    if (conv.id === activeConvId && !mobileSidebar) return;
    setActiveConvId(conv.id);
    setMessages([]);
    setEvents([]);
    setMobileSidebar(false);
    setupWs(conv.id);

    // Load historical messages from backend
    try {
      const session = await getConversation(conv.id);
      const msgs: ChatMessage[] = (session.messages || []).map(
        (m: { role: string; content: string }, i: number) => ({
          id: `${conv.id}-${i}`,
          role: m.role as 'user' | 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
          timestamp: session.created_at,
          status: 'done' as MessageStatus,
        })
      );
      setMessages(msgs);
    } catch {}
  }, [activeConvId, mobileSidebar, setupWs]);

  // ── Rename ────────────────────────────────────────────────────────────
  const handleRename = useCallback(async (id: string, title: string) => {
    try {
      await renameConversation(id, title);
      setConversations(prev =>
        prev.map(c => c.id === id ? { ...c, title } : c)
      );
    } catch {}
  }, []);

  // ── Pin / unpin ───────────────────────────────────────────────────────
  // Optimistic toggle — update local state first, then sync with backend.
  // On error we roll back so the sidebar stays consistent with the server.
  const handleTogglePin = useCallback(async (id: string, pinned: boolean) => {
    const now = new Date().toISOString();
    setConversations(prev =>
      prev.map(c =>
        c.id === id ? { ...c, pinned, pinned_at: pinned ? now : null } : c
      )
    );
    try {
      await togglePinConversation(id, pinned);
    } catch {
      // Roll back on failure
      setConversations(prev =>
        prev.map(c =>
          c.id === id ? { ...c, pinned: !pinned, pinned_at: !pinned ? now : null } : c
        )
      );
    }
  }, []);

  // ── Delete ────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteConversation(id);
      setConversations(prev => {
        const next = prev.filter(c => c.id !== id);
        return next;
      });
      // If deleting active conversation, switch to another or create new
      if (id === activeConvId) {
        const remaining = conversations.filter(c => c.id !== id);
        if (remaining.length > 0) {
          switchConversation(remaining[0]);
        } else {
          newConversation();
        }
      }
    } catch {}
  }, [activeConvId, conversations, switchConversation, newConversation]);

  // ── Send message ──────────────────────────────────────────────────────
  const handleSend = useCallback(async (text: string, attachments?: Attachment[]) => {
    if (processing) return;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
      status: 'done',
      attachments,
    };

    const assistantId = generateId();
    const assistantMsg: ChatMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      status: 'thinking',
    };

    pendingMsgId.current = assistantId;
    pendingToolIds.current.clear();
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setEvents([]);
    setProcessing(true);

    // Frontend safety timeout — 10 minutes max
    if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
    processingTimeoutRef.current = setTimeout(() => {
      if (pendingMsgId.current) {
        updateMsg(pendingMsgId.current, {
          content: 'The request timed out on the client. The server may still be working — try refreshing.',
          status: 'error',
        });
        pendingMsgId.current = null;
        setProcessing(false);
      }
    }, 10 * 60 * 1000);

    try {
      await sendMessage(text, activeConvId, undefined, attachments);
      // Update conversation in the list
      setConversations(prev =>
        prev.map(c =>
          c.id === activeConvId
            ? { ...c, updated_at: new Date().toISOString(), last_message: text.slice(0, 100) }
            : c
        )
      );
    } catch (err: any) {
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
      updateMsg(assistantId, { content: `Error: ${err.message}`, status: 'error' });
      pendingMsgId.current = null;
      setProcessing(false);
    }
  }, [processing, activeConvId, updateMsg]);

  // ── Retry helpers ─────────────────────────────────────────────────────
  // Find the user prompt that immediately preceded the given assistant
  // message. We use that prompt to drive both "retry" (re-send same prompt)
  // and "retry with feedback" (re-send same prompt + user's note about
  // what should change). Both add a NEW user turn rather than rewriting
  // history — the model sees its previous attempt and the correction.
  const findPriorUserPrompt = useCallback((assistantMsgId: string): string | null => {
    const idx = messages.findIndex(m => m.id === assistantMsgId);
    if (idx <= 0) return null;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].content || '';
    }
    return null;
  }, [messages]);

  const handleRetry = useCallback((assistantMsgId: string) => {
    if (processing) return;
    const prior = findPriorUserPrompt(assistantMsgId);
    if (!prior) return;
    handleSend(`Spróbuj jeszcze raz — ten sam prompt: ${prior}`);
  }, [processing, findPriorUserPrompt]); // eslint-disable-line

  const handleRetryWithFeedback = useCallback((assistantMsgId: string, feedback: string) => {
    if (processing) return;
    const prior = findPriorUserPrompt(assistantMsgId);
    if (!prior) return;
    const text =
      `Spróbuj jeszcze raz. Co poprawić w poprzedniej odpowiedzi:\n${feedback.trim()}\n\n` +
      `Oryginalne pytanie:\n${prior}`;
    handleSend(text);
  }, [processing, findPriorUserPrompt]); // eslint-disable-line

  // ── Current conversation title (for header display) ──────────────────
  const activeConvTitle = useMemo(
    () => conversations.find(c => c.id === activeConvId)?.title ?? '',
    [conversations, activeConvId],
  );

  // ── Empty-state greeting name ─────────────────────────────────────────
  // The soul's `name` answer would be ideal but loading it client-side is
  // an extra round-trip; the username (or email handle) is good enough for
  // a "Cześć, X" greeting. The model still sees the full soul in the
  // system prompt so it knows the preferred form of address inside replies.
  const greetingName = useMemo(() => {
    if (!auth.user) return null;
    return auth.user.username || auth.user.email.split('@')[0] || null;
  }, [auth.user]);

  // ── Tab change (also closes mobile sidebar) ───────────────────────────
  const handleTabChange = useCallback((tab: Tab) => {
    setActiveTab(tab);
    setMobileSidebar(false);
  }, []);

  // ── Edit profile (re-trigger onboarding) ─────────────────────────────
  // Must live ABOVE all conditional returns below — React rules of hooks
  // require the hook count to stay constant across renders. Putting this
  // useCallback inside the post-gate body crashes with React error #310
  // the moment the user leaves onboarding (hook count grows by one).
  const handleEditProfile = useCallback(async () => {
    try {
      await resetSoul();
      await authActions.refresh();   // soul_complete flips back to false → onboarding gate triggers
    } catch {
      // swallow — user can retry from the menu
    }
  }, [authActions]);

  // ── Render ────────────────────────────────────────────────────────────

  // Auth gate — wait for bootstrap, then show login if needed
  if (!auth.ready) {
    return (
      <div className="app-boot">
        <Spinner size={32} />
      </div>
    );
  }
  if (auth.mode === 'multi_user' && !auth.user) {
    return (
      <AuthScreen
        state={auth}
        onLogin={authActions.login}
        onRegister={authActions.register}
      />
    );
  }

  // Soul onboarding gate — authenticated but hasn't yet completed/skipped.
  // After saving or skipping we re-bootstrap auth so soul_complete flips true
  // and this branch stops matching.
  if (auth.mode === 'multi_user' && auth.user && auth.user.soul_complete === false) {
    return <Onboarding onDone={() => { authActions.refresh(); }} />;
  }

  // Shared user-menu element (only rendered in multi_user mode)
  const userMenu = auth.mode === 'multi_user' && auth.user
    ? <UserMenu user={auth.user} onLogout={authActions.logout} onEditProfile={handleEditProfile} />
    : null;

  return (
    <div className="app-root">

      {/* ── Mobile sidebar overlay backdrop ─────────────────────────── */}
      {mobileSidebar && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileSidebar(false)}
        />
      )}

      {/* ── Desktop persistent sidebar ───────────────────────────────── */}
      <div className={`sidebar-wrapper ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'} sidebar-desktop`}>
        <Sidebar
          conversations={conversations}
          activeId={activeConvId}
          activeTab={activeTab}
          onSelect={switchConversation}
          onNew={newConversation}
          onDelete={handleDelete}
          onRename={handleRename}
          onTogglePin={handleTogglePin}
          onTabChange={handleTabChange}
          loading={convsLoading}
          userMenu={userMenu}
        />
      </div>

      {/* ── Mobile sidebar slide-in ──────────────────────────────────── */}
      <div className={`sidebar-wrapper sidebar-mobile ${mobileSidebar ? 'sidebar-mobile-open' : ''}`}>
        <Sidebar
          conversations={conversations}
          activeId={activeConvId}
          activeTab={activeTab}
          onSelect={switchConversation}
          onNew={newConversation}
          onDelete={handleDelete}
          onRename={handleRename}
          onTogglePin={handleTogglePin}
          onTabChange={handleTabChange}
          loading={convsLoading}
          userMenu={userMenu}
        />
      </div>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div className="main-area">

        {/* Header */}
        <header className="app-header">
          {/* Left: sidebar toggle (desktop) + hamburger (mobile) */}
          <div className="header-left">
            <button
              className="header-icon-btn sidebar-toggle-desktop"
              onClick={() => setSidebarOpen(o => !o)}
              title="Toggle sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z"/>
              </svg>
            </button>
            <button
              className="header-icon-btn sidebar-toggle-mobile"
              onClick={() => setMobileSidebar(o => !o)}
              title="Menu"
            >
              <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
                <path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z"/>
              </svg>
            </button>

            {/* Logo (visible on mobile when sidebar is closed) */}
            <div className="header-logo-mobile">
              <img src={LOGO_URL} alt="DeeperSeek" className="header-logo-img" />
              <span className="header-logo-text">
                {'DeeperSeek'.split('').map((ch, i) => (
                  <span key={i} className="header-logo-letter" style={{ animationDelay: `${i * 0.35}s` }}>{ch}</span>
                ))}
              </span>
            </div>
          </div>

          {/* Center: current conversation name */}
          <div className="header-conv-name">
            {activeConvTitle && activeConvTitle !== 'New conversation' ? activeConvTitle : ''}
          </div>

          {/* Right: status */}
          <div className="header-right">
            <StatusDot connected={wsConnected} />
            <span className="header-status-label">
              {wsConnected ? 'Live' : 'Connecting…'}
            </span>
          </div>
        </header>

        {/* Content */}
        <main className="main-content">
          {activeTab === 'chat' && (
            <>
              <div className="messages-wrapper">
                <MessagesList
                  messages={messages}
                  onRetry={handleRetry}
                  onRetryWithFeedback={handleRetryWithFeedback}
                  onPickSuggestion={(t) => handleSend(t)}
                  greetingName={greetingName}
                  liveAgents={liveAgents}
                />
              </div>
              <EventsDrawer
                events={events}
                open={eventsOpen}
                onToggle={() => setEventsOpen(o => !o)}
                processing={processing}
              />
              <InputArea
                onSend={handleSend}
                disabled={processing}
              />
            </>
          )}
          {activeTab === 'workspace' && <Workspace />}
          {activeTab === 'agents'    && <Agents liveAgents={liveAgents} />}
        </main>
      </div>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────
createRoot(document.getElementById('root')!).render(<App />);
