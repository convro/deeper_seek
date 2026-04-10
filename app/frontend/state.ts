export type MessageRole = 'user' | 'assistant';
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
