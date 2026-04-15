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

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  status: MessageStatus;
  reasoning?: string;
  toolCalls?: ToolCallRecord[];
  rounds?: number;
  usage?: { prompt_tokens: number; completion_tokens: number };
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
  /** True when the user has pinned this conversation to the top of the sidebar. */
  pinned?: boolean;
  pinned_at?: string | null;
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
