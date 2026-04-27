export type MessageRole   = 'user' | 'assistant';
export type MessageStatus = 'thinking' | 'streaming' | 'done' | 'error';

export interface ToolCallRecord {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  status: 'pending' | 'done' | 'error';
  duration_ms?: number;
  /** When this tool call spawned a sub-agent, the sub-agent's id is set here
   *  so the UI can pull that agent's live state from the App-level
   *  `liveAgents` map and render it inline beneath the badge. */
  spawnedAgentId?: string;
}

/** Real-time view of a sub-agent's progress, derived purely from WS events.
 *  Lives in App-level state (lifted from the polling-based `agents.tsx` tab)
 *  so both the Agents sidebar tab AND the inline chat can render the same
 *  live data without separate polling loops. */
export interface LiveAgent {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  /** Last tool the sub-agent invoked (for "Running… web_search" UI). */
  currentTool?: string;
  toolCount: number;
  /** Last text snippet streamed from the sub-agent (truncated). */
  lastText?: string;
  /** Final answer once the agent finishes. */
  result?: string;
  error?: string;
  startedAt: string;
  completedAt?: string;
  /** Count of websocket events received — useful for "is it still alive" UI. */
  eventCount: number;
  lastEventAt: string;
}

export interface Attachment {
  /** Locally generated ID for tracking before upload */
  localId: string;
  name: string;
  type: string;           // MIME type
  size: number;
  /** Preview URL for images (object URL) */
  previewUrl?: string;
  /** Base64-encoded content — set for images < 5 MB */
  data?: string;
  /** Plain text content — set for text/plain, JSON, etc. */
  text?: string;
  /** Server path after upload */
  path?: string;
}

export type Segment =
  | { type: 'text';  content: string }
  | { type: 'tools'; callIds: string[] };

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  status: MessageStatus;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  rounds?: number;
  usage?: { prompt_tokens: number; completion_tokens: number; cache_hit_tokens?: number; model?: string };
  /** Interleaved content+tools ordering for Raw Commands Mode */
  segments?: Segment[];
  /** Attachments displayed inline — only on user messages */
  attachments?: Attachment[];
}

export interface AgentEvent {
  type: string;
  agent_id?: string;
  agent_type?: string;
  tool?: string;
  call_id?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: string;
  content?: string;
  reasoning?: string;
  duration_ms?: number;
  rounds?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
  timestamp?: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message?: string | null;
  pinned?: boolean;
  pinned_at?: string | null;
  github_repo?: string | null;
  github_branch?: string | null;
}

export interface WorkspaceJob {
  job_id: string;
  description?: string;
  created_at: string;
  status?: string;
}

export function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export function generateLocalId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
