// Global application state types and stores

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  status?: 'pending' | 'streaming' | 'done' | 'error';
}

export interface AgentEvent {
  type: string;
  agent_id?: string;
  agent_type?: string;
  tool?: string;
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

export interface Agent {
  id: string;
  type: string;
  status: 'running' | 'completed' | 'failed' | 'killed';
  task_preview: string;
  started_at: string;
  completed_at?: string;
  tool_calls?: number;
}

export interface WorkspaceJob {
  job_id: string;
  description?: string;
  created_at: string;
  status?: string;
}

export interface AppState {
  sessionId: string;
  messages: ChatMessage[];
  events: AgentEvent[];
  agents: Agent[];
  jobs: WorkspaceJob[];
  activeJobId: string | null;
  isProcessing: boolean;
  wsConnected: boolean;
  activeTab: 'chat' | 'workspace' | 'agents';
}

// Generate a session ID
export function generateSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}
