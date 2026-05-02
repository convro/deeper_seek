import './styles.css';
import React, {
  useState, useEffect, useRef, useCallback, useMemo,
} from 'react';
import { createRoot } from 'react-dom/client';

import { DeeperSeekWS }   from './websocket';
import { sendMessage, regenerateMessage, listConversations, getConversation, renameConversation, deleteConversation, resetSoul, togglePinConversation, fetchUserSettings, saveUserSettings, listGithubRepos, linkGithubRepo, autoTitleConversation, cancelSchedulerTask } from './api';
import type { UserSettings, GithubRepo } from './api';
import { SettingsModal } from './settings-modal';
import { MessagesList, InputArea } from './chat';
import { StatusDot, Spinner } from './components';
import { Workspace } from './workspace';
import { useAuth, AuthScreen, UserMenu } from './auth';
import { Onboarding } from './onboarding';
import type {
  ChatMessage, AgentEvent, ToolCallRecord, Conversation, Attachment, MessageStatus,
  LiveAgent, Segment, SchedulerTask,
} from './state';

interface StyleQuestion { question: string; options: string[] }
import { generateSessionId, generateId } from './state';

const LOGO_URL = 'https://r.convro.eu/content/Stable/realises/ds73';

type Tab = 'chat' | 'workspace';

// ── GitHub repo link modal ────────────────────────────────────────────────
interface GithubLinkModalProps {
  sessionId: string;
  currentRepo: string | null;
  currentBranch: string | null;
  onLinked: (repo: string | null, branch: string | null) => void;
  onClose: () => void;
}

function GithubLinkModal({ sessionId, currentRepo, currentBranch, onLinked, onClose }: GithubLinkModalProps) {
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRepo, setSelectedRepo] = useState(currentRepo || '');
  const [branch, setBranch] = useState(currentBranch || '');
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    listGithubRepos()
      .then(r => {
        setRepos(r.repos || []);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message || 'Failed to load repos');
        setLoading(false);
      });
  }, []);

  const filtered = repos.filter(r =>
    !query || r.full_name.toLowerCase().includes(query.toLowerCase())
  );

  const handleSelect = (r: GithubRepo) => {
    setSelectedRepo(r.full_name);
    setBranch(r.default_branch || 'main');
  };

  const handleLink = async () => {
    if (!selectedRepo) return;
    setSaving(true);
    try {
      await linkGithubRepo(sessionId, selectedRepo, branch || 'main');
      onLinked(selectedRepo, branch || 'main');
      onClose();
    } catch { setSaving(false); }
  };

  const handleUnlink = async () => {
    setSaving(true);
    try {
      await linkGithubRepo(sessionId, null);
      onLinked(null, null);
      onClose();
    } catch { setSaving(false); }
  };

  return (
    <div className="settings-backdrop" onClick={onClose}>
      <div className="gh-link-modal" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <span className="settings-title">Link GitHub Repository</span>
          <button className="settings-close-btn" onClick={onClose}>✕</button>
        </div>

        <div className="gh-link-body">
          {loading && <div className="gh-link-loading">Loading repositories…</div>}
          {error && (
            <div className="gh-link-error">
              {error}
              {error.includes('PAT') || error.includes('token') || repos.length === 0
                ? ' — add your GitHub PAT in Settings first.'
                : ''}
            </div>
          )}

          {!loading && !error && repos.length === 0 && (
            <div className="gh-link-error">No repositories found. Connect your GitHub account in Settings → GitHub first.</div>
          )}

          {!loading && repos.length > 0 && (
            <>
              <input
                className="gh-link-search"
                type="text"
                placeholder="Search repos…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoFocus
              />
              <div className="gh-repo-list">
                {filtered.slice(0, 50).map(r => (
                  <div
                    key={r.full_name}
                    className={`gh-repo-item ${selectedRepo === r.full_name ? 'selected' : ''}`}
                    onClick={() => handleSelect(r)}
                  >
                    <div className="gh-repo-name">
                      {r.private && (
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" style={{ marginRight: 4, opacity: 0.6 }}>
                          <path d="M4 5V3.5A3.5 3.5 0 0 1 11 3.5V5h.5A1.5 1.5 0 0 1 13 6.5v7A1.5 1.5 0 0 1 11.5 15h-7A1.5 1.5 0 0 1 3 13.5v-7A1.5 1.5 0 0 1 4.5 5H4Zm1.5 0h5V3.5a2.5 2.5 0 0 0-5 0V5ZM8 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/>
                        </svg>
                      )}
                      {r.full_name}
                    </div>
                    {r.description && <div className="gh-repo-desc">{r.description}</div>}
                  </div>
                ))}
              </div>

              {selectedRepo && (
                <div className="gh-branch-row">
                  <label className="gh-branch-label">Branch:</label>
                  <input
                    className="gh-branch-input"
                    type="text"
                    value={branch}
                    onChange={e => setBranch(e.target.value)}
                    placeholder="main"
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="settings-footer">
          {currentRepo && (
            <button className="gh-unlink-btn" onClick={handleUnlink} disabled={saving}>
              Unlink
            </button>
          )}
          <button className="settings-cancel-btn" onClick={onClose}>Cancel</button>
          <button
            className="settings-save-btn"
            onClick={handleLink}
            disabled={!selectedRepo || saving}
          >
            {saving ? 'Linking…' : 'Link'}
          </button>
        </div>
      </div>
    </div>
  );
}

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
  onLogoClick?: () => void;
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
];

function Sidebar({
  conversations, activeId, activeTab, onSelect, onNew, onDelete, onRename, onTogglePin, onTabChange, onLogoClick, loading, userMenu,
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
        <div className="sidebar-logo" onClick={onLogoClick} style={{ cursor: onLogoClick ? 'pointer' : 'default' }}>
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

// ── Style Questions Card ──────────────────────────────────────────────────

interface StyleQuestionsCardProps {
  questions: StyleQuestion[];
  onComplete: (answers: Record<number, string>, questions: StyleQuestion[]) => void;
  onDismiss: () => void;
}

function StyleQuestionsCard({ questions, onComplete, onDismiss }: StyleQuestionsCardProps) {
  const [index,      setIndex]      = useState(0);
  const [answers,    setAnswers]    = useState<Record<number, string>>({});
  const [customText, setCustomText] = useState('');
  const CUSTOM_KEY = '__custom__';

  const current   = questions[index];
  const total     = questions.length;
  const selected  = answers[index];
  const canAdvance = selected != null && (selected !== CUSTOM_KEY || customText.trim().length > 0);

  const select = (val: string) => {
    setAnswers(prev => ({ ...prev, [index]: val }));
    if (val !== CUSTOM_KEY) setCustomText('');
  };

  const advance = () => {
    // Commit custom text into answers if that option was chosen
    const finalAnswers = selected === CUSTOM_KEY
      ? { ...answers, [index]: customText.trim() }
      : answers;
    if (index < total - 1) {
      setAnswers(finalAnswers);
      setIndex(index + 1);
      setCustomText('');
    } else {
      onComplete(finalAnswers, questions);
    }
  };

  return (
    <div className="style-card">
      <div className="style-card-header">
        <span className="style-card-progress">{index + 1} / {total}</span>
        <button
          className={`style-card-next ${canAdvance ? 'active' : ''}`}
          onClick={advance}
          disabled={!canAdvance}
          title={index < total - 1 ? 'Następne pytanie' : 'Zatwierdź i buduj'}
        >
          {index < total - 1 ? '→' : '✓'}
        </button>
      </div>

      <div className="style-card-question">{current.question}</div>

      <div className="style-card-options">
        {current.options.slice(0, 3).map((opt, i) => (
          <label key={i} className={`style-card-option ${selected === opt ? 'selected' : ''}`}>
            <span className="style-card-radio" />
            <span className="style-card-option-text">{opt}</span>
            <input type="radio" name={`sq-${index}`} value={opt} checked={selected === opt} onChange={() => select(opt)} />
          </label>
        ))}
        <label className={`style-card-option style-card-option-custom ${selected === CUSTOM_KEY ? 'selected' : ''}`}>
          <span className="style-card-radio" />
          <span className="style-card-option-text">Opisz sam…</span>
          <input type="radio" name={`sq-${index}`} value={CUSTOM_KEY} checked={selected === CUSTOM_KEY} onChange={() => select(CUSTOM_KEY)} />
        </label>
        {selected === CUSTOM_KEY && (
          <textarea
            className="style-card-custom-input"
            placeholder="Opisz jak to widzisz…"
            value={customText}
            onChange={e => setCustomText(e.target.value)}
            autoFocus
            rows={2}
          />
        )}
      </div>

      <button className="style-card-dismiss" onClick={onDismiss} title="Pomiń — AI zdecyduje sam">
        pomiń, zdecyduj sam
      </button>
    </div>
  );
}

// ── Session Info Panel ────────────────────────────────────────────────────
const JOKES_PL = [
  'Czemu kobiety nie umieją czytać map? Bo tylko mężczyźni wmawiali im że centymetr to 30 km. 🍆',
  'Mama pyta syna: „Skąd masz prezerwatywę?" — „Od taty." — „A tata skąd wiedział że potrzebujesz?" — „Bo złapał mnie jak ćwiczyłem na banana." 🍌',
  'Lekarz do pacjentki: „Musi pani zdjąć majtki." — „Ale ja przyszłam na receptę na katar." — „Wiem, ale mam zimne ręce i długa przerwa." 🥶',
  'Jak się nazywa kobieta bez łechtaczki? Nie ma znaczenia — i tak nigdy nie słucha. 😑',
  'Dlaczego kobieta po seksie płacze? Bo mężczyzna odchodzi, a wibrator nie. 😢',
  'Co mówi chłopak po seksie analnym? „Przepraszam, myślałem że śpisz." 💀',
  'Dlaczego penis ma dziurkę na końcu? Żeby mężczyźni mogli być otwarci na nowe pomysły. 🧠',
];

const JOKES_EN = [
  'What do you call a lesbian dinosaur? Lickalotapuss. 🦕',
  'Why does the Easter Bunny hide eggs? Because he doesn\'t want anyone knowing he\'s been fucking chickens. 🐰',
  'What\'s the difference between a G-spot and a golf ball? A man will actually search for a golf ball. 🏌️',
  'Doctor: "You need to stop masturbating." Patient: "Why?" Doctor: "Because I\'m trying to examine you." 😐',
  'Why doesn\'t Santa have kids? He only comes once a year, and it\'s down a chimney. 🎅',
  'What\'s 6 inches long, 2 inches wide and makes women go wild? A $100 bill. What did you think? 💵',
  'Sex is like math: add a bed, subtract clothes, divide legs, multiply. 🧮',
];

function detectLang(msgs: ChatMessage[]): 'pl' | 'en' {
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  if (!lastUser?.content) return 'pl';
  if (/[ąęóśźżćńłĄĘÓŚŹŻĆŃŁ]/.test(lastUser.content)) return 'pl';
  if (/\b(jest|nie|jak|tak|ale|czy|się|tego|przez|przy|mam|są|może|więcej)\b/i.test(lastUser.content)) return 'pl';
  return 'en';
}

const PRICING_SESSION: Record<string, { input: number; cached: number; output: number }> = {
  'deepseek-v4-flash': { input: 0.14,  cached: 0.028, output: 0.28  },
  'deepseek-v4-pro':   { input: 1.74,  cached: 0.145, output: 3.48  },
  default:             { input: 0.14,  cached: 0.028, output: 0.28  },
};

function rawMsgCost(u: NonNullable<ChatMessage['usage']>): number {
  const p = PRICING_SESSION[u.model ?? ''] ?? PRICING_SESSION.default;
  const hit  = u.cache_hit_tokens ?? 0;
  const miss = Math.max(0, u.prompt_tokens - hit);
  return (miss * p.input + hit * p.cached + u.completion_tokens * p.output) / 1_000_000;
}

function fmtUsd(v: number): string {
  if (v < 0.0001) return '<$0.0001';
  return '$' + v.toFixed(4);
}

interface EggParticle { id: number; dx: number; dy: number; size: number; color: string; }

interface SessionInfoPanelProps {
  open: boolean;
  onClose: () => void;
  convTitle: string;
  messages: ChatMessage[];
  tokenReduction: boolean;
  onToggleTokenReduction: (v: boolean) => void;
  rawCommandsMode: boolean;
  onToggleRawCommands: (v: boolean) => void;
}

function SessionInfoPanel({
  open, onClose, convTitle, messages, tokenReduction, onToggleTokenReduction,
  rawCommandsMode, onToggleRawCommands,
}: SessionInfoPanelProps) {
  const [eggClicks,  setEggClicks]  = useState(0);
  const [broken,     setBroken]     = useState(false);
  const [joke,       setJoke]       = useState('');
  const [particles,  setParticles]  = useState<EggParticle[]>([]);
  const [shaking,    setShaking]    = useState(false);
  const particleId  = useRef(0);
  const shakeTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Swipe-down-to-close on drag handle
  const dragStartY = useRef<number | null>(null);
  const [dragY, setDragY] = useState(0);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) { setEggClicks(0); setBroken(false); setShaking(false); setDragY(0); }
  }, [open]);

  const usageMsgs    = messages.filter(m => m.usage);
  const totalCost    = usageMsgs.reduce((acc, m) => acc + rawMsgCost(m.usage!), 0);
  const lastUsageMsg = usageMsgs[usageMsgs.length - 1];
  const lastCost     = lastUsageMsg ? rawMsgCost(lastUsageMsg.usage!) : null;
  const totalPrompt  = usageMsgs.reduce((a, m) => a + (m.usage?.prompt_tokens ?? 0), 0);
  const totalOutput  = usageMsgs.reduce((a, m) => a + (m.usage?.completion_tokens ?? 0), 0);
  const totalCached  = usageMsgs.reduce((a, m) => a + (m.usage?.cache_hit_tokens ?? 0), 0);

  const spawnParticles = (count: number, big: boolean) => {
    const colors = ['#6366f1', '#a371f7', '#f85149', '#d29922', '#2ea043', '#38bdf8', '#fb7185'];
    const spawned: EggParticle[] = Array.from({ length: count }, (_, i) => {
      const angle  = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 1.4;
      const speed  = big ? (70 + Math.random() * 90) : (30 + Math.random() * 50);
      return {
        id:    ++particleId.current,
        dx:    Math.cos(angle) * speed,
        dy:    Math.sin(angle) * speed,
        size:  big ? (5 + Math.random() * 7) : (3 + Math.random() * 4),
        color: colors[Math.floor(Math.random() * colors.length)],
      };
    });
    setParticles(prev => [...prev, ...spawned]);
    setTimeout(() => {
      const ids = new Set(spawned.map(p => p.id));
      setParticles(prev => prev.filter(p => !ids.has(p.id)));
    }, 700);
  };

  const handleEggClick = () => {
    if (broken) return;
    const next = eggClicks + 1;
    setEggClicks(next);

    // shake feedback
    if (shakeTimer.current) clearTimeout(shakeTimer.current);
    setShaking(true);
    shakeTimer.current = setTimeout(() => setShaking(false), 380);

    // spawn particles — more as we get closer to break
    const intensity = next >= 6;
    spawnParticles(intensity ? 10 : 6, false);

    if (next >= 7) {
      setBroken(true);
      spawnParticles(22, true);
      const lang = detectLang(messages);
      const pool = lang === 'en' ? JOKES_EN : JOKES_PL;
      setJoke(pool[Math.floor(Math.random() * pool.length)]);
    }
  };

  const onHandleTouchStart = (e: React.TouchEvent) => {
    dragStartY.current = e.touches[0].clientY;
  };
  const onHandleTouchMove = (e: React.TouchEvent) => {
    if (dragStartY.current === null) return;
    const dy = Math.max(0, e.touches[0].clientY - dragStartY.current);
    setDragY(dy);
  };
  const onHandleTouchEnd = () => {
    if (dragY > 110) { onClose(); } else { setDragY(0); }
    dragStartY.current = null;
  };

  if (!open) return null;

  const eggLabel = eggClicks === 0 ? 'click me' : `${7 - eggClicks}×`;
  const panelStyle: React.CSSProperties = dragY > 0
    ? { transform: `translateY(${dragY}px)`, transition: 'none' }
    : {};

  return (
    <div className="session-panel-backdrop" onClick={onClose}>
      <div className="session-panel" style={panelStyle} onClick={e => e.stopPropagation()}>

        {/* Drag handle — touch target for swipe-down-to-close */}
        <div
          className="session-panel-handle-area"
          onTouchStart={onHandleTouchStart}
          onTouchMove={onHandleTouchMove}
          onTouchEnd={onHandleTouchEnd}
        >
          <div className="session-panel-handle" />
        </div>

        <button className="session-panel-close" onClick={onClose}>✕</button>

        <div className="session-panel-body">

          {/* Conversation title */}
          <div className="session-panel-section">
            <div className="session-panel-label">Rozmowa</div>
            <div className="session-panel-title">{convTitle || '—'}</div>
          </div>

          {/* Token Reduction Mode toggle */}
          <div className="session-panel-section session-panel-row">
            <div className="session-panel-row-text">
              <div className="session-panel-label">Token Reduction Mode</div>
              <div className="session-panel-sub">Skraca historię żeby zmieścić więcej w jednym wywołaniu</div>
            </div>
            <button
              className={`session-toggle ${tokenReduction ? 'on' : ''}`}
              onClick={() => onToggleTokenReduction(!tokenReduction)}
              aria-label="Toggle token reduction"
            >
              <span className="session-toggle-knob" />
            </button>
          </div>

          {/* Raw Commands Mode toggle */}
          <div className="session-panel-section session-panel-row">
            <div className="session-panel-row-text">
              <div className="session-panel-label">Raw Commands View</div>
              <div className="session-panel-sub">Pokazuje tool calle jako bloki terminalowe zamiast badge'y</div>
            </div>
            <button
              className={`session-toggle ${rawCommandsMode ? 'on' : ''}`}
              onClick={() => onToggleRawCommands(!rawCommandsMode)}
              aria-label="Toggle raw commands view"
            >
              <span className="session-toggle-knob" />
            </button>
          </div>

          {/* Cost cards */}
          <div className="session-panel-section session-cost-grid">
            <div className="session-cost-card">
              <div className="session-cost-label">Koszt rozmowy</div>
              <div className="session-cost-val">{fmtUsd(totalCost)}</div>
            </div>
            <div className="session-cost-card">
              <div className="session-cost-label">Ostatnia wiadomość</div>
              <div className="session-cost-val">{lastCost !== null ? fmtUsd(lastCost) : '—'}</div>
            </div>
          </div>

          {/* Token breakdown */}
          <div className="session-panel-section session-tok-row">
            <span className="session-tok-item">↑ {totalPrompt.toLocaleString()} in</span>
            {totalCached > 0 && (
              <span className="session-tok-item tok-cached-badge">✦ {totalCached.toLocaleString()} cache</span>
            )}
            <span className="session-tok-item">↓ {totalOutput.toLocaleString()} out</span>
          </div>

          {/* Easter egg */}
          <div className="session-egg-wrap">
            <div className="session-egg-particle-root">
              {particles.map(p => (
                <div
                  key={p.id}
                  className="session-particle"
                  style={{
                    width:  p.size,
                    height: p.size,
                    background: p.color,
                    '--pdx': p.dx + 'px',
                    '--pdy': p.dy + 'px',
                  } as React.CSSProperties}
                />
              ))}
            </div>

            {!broken ? (
              <button
                className={`session-egg-btn${shaking ? ' session-egg-shake' : ''}${eggClicks > 0 ? ` egg-dmg-${Math.min(eggClicks, 6)}` : ''}`}
                onClick={handleEggClick}
              >
                <span className="session-egg-label">{eggLabel}</span>
              </button>
            ) : (
              <div className="session-egg-broken">
                <div className="session-egg-joke">{joke}</div>
              </div>
            )}
          </div>

        </div>
      </div>
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

    ws.on('title_updated', (event) => {
      if (event.title && event.session_id) {
        setConversations(prev =>
          prev.map(c => c.id === event.session_id ? { ...c, title: event.title } : c)
        );
      }
    });

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

    ws.on('style_questions', (event) => {
      if (Array.isArray(event.questions) && event.questions.length > 0) {
        setStyleCard({ questions: event.questions as StyleQuestion[] });
      }
    });

    ws.on('llm_start', () => {
      if (pendingMsgId.current) updateMsg(pendingMsgId.current, { status: 'thinking' });
    });

    // ── Streaming deltas (word-by-word) ───────────────────────────────
    ws.on('content_delta', (event) => {
      const id = pendingMsgId.current;
      if (!id || !event.delta) return;
      setMessages(prev => prev.map(m => {
        if (m.id !== id) return m;
        const segs = [...(m.segments || [])];
        const last = segs[segs.length - 1];
        if (last && last.type === 'text') {
          segs[segs.length - 1] = { type: 'text', content: last.content + event.delta };
        } else {
          segs.push({ type: 'text', content: event.delta });
        }
        return { ...m, content: (m.content || '') + event.delta, status: 'streaming' as MessageStatus, segments: segs };
      }));
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
      // Update segments to record tool group at this position
      setMessages(prev => prev.map(m => {
        if (m.id !== msgId) return m;
        const segs = [...(m.segments || [])];
        const last = segs[segs.length - 1];
        if (last && last.type === 'tools') {
          segs[segs.length - 1] = { type: 'tools', callIds: [...last.callIds, event.call_id!] };
        } else {
          segs.push({ type: 'tools', callIds: [event.call_id!] });
        }
        return { ...m, segments: segs };
      }));
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
      // Sub-agent completion events are tagged with agent_id by the backend
      // and must NOT terminate the main turn's UI state. They are absorbed
      // by the liveAgents tracker above.
      if (event.agent_id) return;
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
      // Sub-agent errors must not flip the main assistant bubble to error.
      if (event.agent_id) return;
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

    // ── Scheduler events ──────────────────────────────────────────────────
    ws.on('scheduler_start', (event) => {
      const task: SchedulerTask = {
        taskId:        event.task_id,
        label:         event.label || 'Background Task',
        durationMs:    event.duration_ms || 0,
        startedAt:     event.started_at || Date.now(),
        status:        'running',
        currentAction: 'Starting…',
        stats:         {},
        elapsedMs:     0,
        remainingMs:   event.duration_ms || 0,
      };
      const msg: ChatMessage = {
        id:            `sched-${event.task_id}`,
        role:          'assistant',
        content:       '',
        timestamp:     new Date().toISOString(),
        status:        'done',
        schedulerTask: task,
      };
      setMessages(prev => [...prev, msg]);
    });

    ws.on('scheduler_tick', (event) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== `sched-${event.task_id}` || !m.schedulerTask) return m;
        return {
          ...m,
          schedulerTask: {
            ...m.schedulerTask,
            elapsedMs:     event.elapsed_ms     ?? m.schedulerTask.elapsedMs,
            remainingMs:   event.remaining_ms   ?? m.schedulerTask.remainingMs,
            currentAction: event.current_action ?? m.schedulerTask.currentAction,
            stats:         event.stats          ?? m.schedulerTask.stats,
          },
        };
      }));
    });

    ws.on('scheduler_complete', (event) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== `sched-${event.task_id}` || !m.schedulerTask) return m;
        return {
          ...m,
          schedulerTask: {
            ...m.schedulerTask,
            status:        'complete',
            remainingMs:   0,
          },
        };
      }));
    });

    ws.on('scheduler_cancelled', (event) => {
      setMessages(prev => prev.map(m => {
        if (m.id !== `sched-${event.task_id}` || !m.schedulerTask) return m;
        return {
          ...m,
          schedulerTask: { ...m.schedulerTask, status: 'cancelled' },
        };
      }));
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

  // ── Reset all turn-scoped state (pending refs, live agents, timers) ───
  // Shared by newConversation / switchConversation so switching mid-turn
  // never leaves stale correlation entries that could hijack the next turn.
  const resetTurnState = useCallback(() => {
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
    pendingMsgId.current = null;
    pendingToolIds.current.clear();
    agentToCall.current.clear();
    setLiveAgents(new Map());
    setProcessing(false);
  }, []);

  // ── Create new conversation ───────────────────────────────────────────
  const newConversation = useCallback(() => {
    const id = generateSessionId();
    resetTurnState();
    setActiveConvId(id);
    setMessages([]);
    setEvents([]);
    setConversations(prev => [{
      id,
      title: id.slice(-7),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      message_count: 0,
      last_message: null,
    }, ...prev]);
    setMobileSidebar(false);
    setupWs(id);
  }, [setupWs, resetTurnState]);

  // ── Switch conversation ───────────────────────────────────────────────
  const switchConversation = useCallback(async (conv: Conversation) => {
    if (conv.id === activeConvId && !mobileSidebar) return;
    resetTurnState();
    setActiveConvId(conv.id);
    setMessages([]);
    setEvents([]);
    setMobileSidebar(false);
    setupWs(conv.id);

    // Load historical messages from backend
    try {
      const session = await getConversation(conv.id);

      // Build a lookup: message index → rich metadata (toolCalls, reasoning, usage, rounds)
      const metaByIdx = new Map<number, any>();
      (session.message_meta || []).forEach((m: any) => metaByIdx.set(m.msg_index, m));

      // Map with original index preserved (meta lookup keyed by backend msg_index),
      // then filter out hidden style-answer messages that were never shown in UI.
      const msgs: ChatMessage[] = (session.messages || [])
        .map((m: { role: string; content: string }, origIdx: number) => ({ m, origIdx }))
        .filter(({ m }) =>
          !(m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('[STYLE_ANSWERS:'))
        )
        .map(({ m, origIdx: i }) => {
          const meta = metaByIdx.get(i);
          return {
            id:        `${conv.id}-${i}`,
            role:      m.role as 'user' | 'assistant',
            content:   typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            timestamp: session.created_at,
            status:    'done' as MessageStatus,
            ...(meta ? {
              toolCalls: meta.tool_calls?.length > 0 ? meta.tool_calls : undefined,
              reasoning: meta.reasoning  || undefined,
              usage:     meta.usage      || undefined,
              rounds:    meta.rounds     || undefined,
              segments:  meta.segments?.length > 0   ? meta.segments  : undefined,
            } : {}),
          };
        }
      );
      setMessages(msgs);
    } catch {}
  }, [activeConvId, mobileSidebar, setupWs, resetTurnState]);

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
    // Dismiss style card if user sends a regular message — treat as "decide yourself"
    setStyleCard(null);

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

    // Frontend safety timeout — must exceed backend LOOP_TIMEOUT_MS (20min)
    // so the server's own timeout + final 'error' event always wins the race.
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
    }, 22 * 60 * 1000);

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

  // ── Silent retry (ChatGPT/Claude-style regenerate) ───────────────────
  // Instead of injecting a visible "try again" user bubble, we:
  //   1. Reset the target assistant message in-place (clear content, tools,
  //      reasoning; flip status back to 'thinking').
  //   2. Point pendingMsgId at it so the streaming WS events rewrite the
  //      same bubble.
  //   3. Hit /api/chat/regenerate — backend pops the stale assistant turn,
  //      optionally threads in ephemeral feedback, and re-runs the loop.
  // The UI shows ONLY the regenerated response. No extra user turn appears.
  const performSilentRetry = useCallback(async (assistantMsgId: string, feedback?: string) => {
    if (processing) return;
    const target = messages.find(m => m.id === assistantMsgId);
    if (!target || target.role !== 'assistant') return;

    // Reset the bubble in-place
    updateMsg(assistantMsgId, {
      content: '',
      reasoning: '',
      toolCalls: [],
      status: 'thinking',
      rounds: undefined,
      usage: undefined,
    });

    // Wire streaming back to this bubble
    pendingMsgId.current = assistantMsgId;
    pendingToolIds.current.clear();
    agentToCall.current.clear();
    setLiveAgents(new Map());
    setEvents([]);
    setProcessing(true);

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
    }, 22 * 60 * 1000);

    try {
      await regenerateMessage(activeConvId, feedback);
    } catch (err: any) {
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
      updateMsg(assistantMsgId, { content: `Error: ${err.message}`, status: 'error' });
      pendingMsgId.current = null;
      setProcessing(false);
    }
  }, [processing, messages, activeConvId, updateMsg]);

  const handleRetry = useCallback((assistantMsgId: string) => {
    performSilentRetry(assistantMsgId);
  }, [performSilentRetry]);

  const handleRetryWithFeedback = useCallback((assistantMsgId: string, feedback: string) => {
    performSilentRetry(assistantMsgId, feedback);
  }, [performSilentRetry]);

  const handleCancelScheduler = useCallback(async (taskId: string) => {
    setMessages(prev => prev.map(m =>
      m.id === `sched-${taskId}` && m.schedulerTask
        ? { ...m, schedulerTask: { ...m.schedulerTask, status: 'cancelled' } }
        : m
    ));
    try { await cancelSchedulerTask(taskId); } catch {}
  }, []);

  // ── Style card completion — send hidden answers, add only assistant bubble ─
  const handleStyleComplete = useCallback(async (answers: Record<number, string>, questions: StyleQuestion[]) => {
    setStyleCard(null);
    if (processing) return;

    // Format answers as a context message for the AI — hidden from UI
    const formatted = questions.map((q, i) => `Q${i + 1}: "${q.question}" → "${answers[i] ?? 'no answer'}"`).join(', ');
    const hiddenText = `[STYLE_ANSWERS: ${formatted}]`;

    // Create only the assistant bubble (user message stays hidden in UI)
    const assistantId = generateId();
    const assistantMsg: ChatMessage = {
      id: assistantId, role: 'assistant', content: '',
      timestamp: new Date().toISOString(), status: 'thinking',
    };
    pendingMsgId.current = assistantId;
    pendingToolIds.current.clear();
    setMessages(prev => [...prev, assistantMsg]);
    setProcessing(true);

    if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
    processingTimeoutRef.current = setTimeout(() => {
      if (pendingMsgId.current) {
        updateMsg(pendingMsgId.current, { content: 'Request timed out.', status: 'error' });
        pendingMsgId.current = null;
        setProcessing(false);
      }
    }, 22 * 60 * 1000);

    try {
      await sendMessage(hiddenText, activeConvId);
    } catch (err: any) {
      if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
      updateMsg(assistantId, { content: `Error: ${err.message}`, status: 'error' });
      pendingMsgId.current = null;
      setProcessing(false);
    }
  }, [processing, activeConvId, updateMsg]);

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

  // ── Style questions card ──────────────────────────────────────────────
  const [styleCard, setStyleCard] = useState<{ questions: StyleQuestion[] } | null>(null);

  // ── Session info panel ────────────────────────────────────────────────
  const [showSessionPanel,  setShowSessionPanel]  = useState(false);
  const [tokenReduction,    setTokenReduction]    = useState(false);
  const [rawCommandsMode,   setRawCommandsMode]   = useState(false);

  // ── Settings modal ────────────────────────────────────────────────────
  const [showSettings, setShowSettings] = useState(false);
  const [userSettings, setUserSettings] = useState<UserSettings>({ extended_thinking: true, agent_extended_thinking: true, use_pro_model: false });

  // ── GitHub repo link modal ────────────────────────────────────────────
  const [showGithubLink, setShowGithubLink] = useState(false);

  // Track github_repo / github_branch for the active conversation
  const activeConv = useMemo(() => conversations.find(c => c.id === activeConvId) ?? null, [conversations, activeConvId]);
  const activeGithubRepo   = activeConv?.github_repo   ?? null;
  const activeGithubBranch = activeConv?.github_branch ?? null;

  const handleGithubLinked = (repo: string | null, branch: string | null) => {
    setConversations(prev =>
      prev.map(c =>
        c.id === activeConvId
          ? { ...c, github_repo: repo, github_branch: branch }
          : c
      )
    );
  };

  useEffect(() => {
    if (auth.mode !== 'multi_user' || !auth.user) return;
    fetchUserSettings().then(r => setUserSettings(r.settings)).catch(() => {});
  }, [auth.mode, auth.user?.id]);

  const handleSaveSettings = useCallback(async (s: UserSettings) => {
    await saveUserSettings(s);
    // Merge instead of replace — preserve github_username/github_pat which are
    // managed by OAuth flow and never sent through the settings save endpoint.
    setUserSettings(prev => ({ ...prev, ...s }));
  }, []);

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
    ? <UserMenu user={auth.user} onLogout={authActions.logout} onEditProfile={handleEditProfile} onSettings={() => setShowSettings(true)} />
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
          onLogoClick={activeTab === 'chat' ? () => setShowSessionPanel(true) : undefined}
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
          onLogoClick={activeTab === 'chat' ? () => setShowSessionPanel(true) : undefined}
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
            <div className="header-logo-mobile" onClick={() => activeTab === 'chat' && setShowSessionPanel(true)} style={{ cursor: activeTab === 'chat' ? 'pointer' : 'default' }}>
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
            {activeConvTitle && activeConvTitle.length > 7 ? activeConvTitle : ''}
          </div>

          {/* Right: GitHub repo badge + status */}
          <div className="header-right">
            {auth.mode === 'multi_user' && activeTab === 'chat' && (
              <button
                className={`gh-repo-badge ${activeGithubRepo ? 'linked' : ''}`}
                onClick={() => setShowGithubLink(true)}
                title={activeGithubRepo ? `Linked: ${activeGithubRepo} (${activeGithubBranch})` : 'Link GitHub repo'}
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
                </svg>
                {activeGithubRepo ? (
                  <span className="gh-repo-badge-name">
                    {activeGithubRepo.split('/')[1] || activeGithubRepo}
                    <span className="gh-repo-badge-branch"> / {activeGithubBranch}</span>
                  </span>
                ) : (
                  <span className="gh-repo-badge-name">Link repo</span>
                )}
              </button>
            )}
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
                  onCancelScheduler={handleCancelScheduler}
                  greetingName={greetingName}
                  liveAgents={liveAgents}
                  rawCommandsMode={rawCommandsMode}
                />
              </div>
              {styleCard && (
                <StyleQuestionsCard
                  questions={styleCard.questions}
                  onComplete={handleStyleComplete}
                  onDismiss={() => setStyleCard(null)}
                />
              )}
              <InputArea
                onSend={handleSend}
                disabled={processing}
              />
            </>
          )}
          {activeTab === 'workspace' && <Workspace />}
        </main>
      </div>

      {showSessionPanel && (
        <SessionInfoPanel
          open={showSessionPanel}
          onClose={() => setShowSessionPanel(false)}
          convTitle={activeConvTitle}
          messages={messages}
          tokenReduction={tokenReduction}
          onToggleTokenReduction={setTokenReduction}
          rawCommandsMode={rawCommandsMode}
          onToggleRawCommands={setRawCommandsMode}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={userSettings}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {showGithubLink && (
        <GithubLinkModal
          sessionId={activeConvId}
          currentRepo={activeGithubRepo}
          currentBranch={activeGithubBranch}
          onLinked={handleGithubLinked}
          onClose={() => setShowGithubLink(false)}
        />
      )}
    </div>
  );
}

// ── PWA gate — mobile browsers only ──────────────────────────────────────
function isMobileDevice(): boolean {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
function isPWAStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as any).standalone === true;
}

function PWAInstallScreen() {
  const isIOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
  return (
    <div className="pwa-install-screen">
      <div className="pwa-install-card">
        <img src="https://r.convro.eu/content/Stable/realises/ds73" className="pwa-install-logo" alt="DeeperSeek" />
        <h1 className="pwa-install-title">DeeperSeek</h1>
        <p className="pwa-install-sub">
          Add the app to your home screen to continue.
        </p>
        <div className="pwa-install-steps">
          {isIOS ? (
            <>
              <div className="pwa-install-step">
                <span className="pwa-step-num">1</span>
                <span>Tap the <strong>Share</strong> button <span className="pwa-icon">⬆</span> at the bottom of Safari</span>
              </div>
              <div className="pwa-install-step">
                <span className="pwa-step-num">2</span>
                <span>Scroll down and tap <strong>"Add to Home Screen"</strong></span>
              </div>
              <div className="pwa-install-step">
                <span className="pwa-step-num">3</span>
                <span>Tap <strong>"Add"</strong> — then open DeeperSeek from your home screen</span>
              </div>
            </>
          ) : (
            <>
              <div className="pwa-install-step">
                <span className="pwa-step-num">1</span>
                <span>Tap <strong>⋮ Menu</strong> in your browser</span>
              </div>
              <div className="pwa-install-step">
                <span className="pwa-step-num">2</span>
                <span>Tap <strong>"Add to Home screen"</strong> or <strong>"Install app"</strong></span>
              </div>
              <div className="pwa-install-step">
                <span className="pwa-step-num">3</span>
                <span>Open DeeperSeek from your home screen</span>
              </div>
            </>
          )}
        </div>
        <p className="pwa-install-hint">
          The app runs faster and feels native when installed.
        </p>
      </div>
    </div>
  );
}

// ── Mount ─────────────────────────────────────────────────────────────────
const rootEl = document.getElementById('root')!;
const isMobile  = isMobileDevice();
const isStandalone = isPWAStandalone();
createRoot(rootEl).render(
  isMobile && !isStandalone ? <PWAInstallScreen /> : <App />
);
