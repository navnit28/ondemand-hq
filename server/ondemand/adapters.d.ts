// Typed surface of the OnDemand integration boundary (schemas mirror the live docs
// digested in NOTES.md 2026-07-19/20 — sessions, streamed submitquery SSE, STT, TTS,
// workflow execute/stream_logs). Credentials never cross this boundary to the client.

export interface VoiceContext {
  selectedCountry?: string | null;
  selectedRegion?: string | null;
  activeLayer?: string | null;
  timelineRange?: { from?: string; to?: string } | null;
  selectedMarker?: string | null;
  activeFilters?: Record<string, unknown> | null;
  cameraFocus?: { lat: number; lng: number } | null;
}

export interface StreamEventFrame {
  eventType?: string;
  answer?: string;
  sessionId?: string;
  messageId?: string;
  usage?: Record<string, number>;
  [k: string]: unknown;
}

export function createSession(
  externalUserId: string,
  agentIds?: string[],
  opts?: { timeoutMs?: number }
): Promise<string>;

export function streamQuery(args: {
  sessionId: string;
  query: string;
  endpointId: string;
  reasoningEffort?: 'low' | 'medium' | 'max';
  fulfillmentPrompt?: string;
  fulfillmentOnly?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (eventType: string, frame: StreamEventFrame) => void;
}): Promise<{ fullAnswer: string; usage: Record<string, number> | null }>;

export function speechToText(
  audioUrl: string,
  opts?: { timeoutMs?: number }
): Promise<{ ok: boolean; text?: string; status?: number; message?: string; notSubscribed?: boolean }>;

export function textToSpeech(args: {
  input: string;
  model?: 'tts-1' | 'tts-1-hd';
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer';
  timeoutMs?: number;
}): Promise<{ ok: boolean; data?: unknown; status?: number; message?: string; notSubscribed?: boolean }>;

export function executeWorkflow(
  workflowId: string,
  opts?: { timeoutMs?: number }
): Promise<{ executionID?: string; data?: unknown }>;

export function streamWorkflowLogs(
  executionID: string,
  onLine: (chunk: string) => void,
  opts?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<void>;
