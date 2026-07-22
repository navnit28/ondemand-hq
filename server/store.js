// store.js — in-memory, session-scoped conversation store. Resets on restart (by design).
import crypto from 'node:crypto';

const conversations = new Map(); // id -> {id, title, createdAt, updatedAt, feature, odSessionId, messages:[], wizard}

export function createConversation({ id = crypto.randomUUID(), title = 'New chat', feature = 'chat' } = {}) {
  const now = new Date().toISOString();
  const conv = { id, title, feature, createdAt: now, updatedAt: now, odSessionId: null, messages: [], wizard: null };
  conversations.set(id, conv);
  return conv;
}

export function getConversation(id) { return conversations.get(id) || null; }

export function listConversations() {
  // Sidebar list: newest first, grouped client-side by date.
  return [...conversations.values()]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(({ id, title, feature, createdAt, updatedAt }) => ({ id, title, feature, createdAt, updatedAt }));
}

export function touch(conv, fields = {}) {
  Object.assign(conv, fields, { updatedAt: new Date().toISOString() });
}

export function addMessage(conv, msg) {
  const m = { id: crypto.randomUUID(), ts: new Date().toISOString(), ...msg };
  conv.messages.push(m);
  touch(conv);
  return m;
}

// Uploaded files (in-memory, session-scoped)
const files = new Map(); // fileId -> {id,name,mime,size,buffer,text}
export function putFile(f) { files.set(f.id, f); return f; }
export function getFile(id) { return files.get(id) || null; }

// Generated exports (in-memory)
const exportsMap = new Map(); // exportId -> {id,name,mime,buffer,createdAt,citations,gaps}
export function putExport(e) { exportsMap.set(e.id, e); return e; }
export function getExport(id) { return exportsMap.get(id) || null; }
