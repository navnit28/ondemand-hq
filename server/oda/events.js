// events.js — ODA in-process event bus + SSE fan-out (MIGRATION_MAP M5/M13).
//
// M5: no timer/interval fakes progress anywhere in this file — every ODARunEvent
// frame emitted here corresponds to a REAL backend state transition recorded by
// runStore.js. The one exception is the 25s keepalive comment ping written per
// SSE connection below (': keepalive\n\n'): that is a transport-level comment
// frame, never parsed as an event by an SSE client, and carries no run state.
// M13: subscribe() replays the durable run.events log (seq > since) to a newly
// attached client before wiring it up live, so a reconnecting tab (page refresh,
// dropped network) recovers exactly the frames it missed — the run document is
// the source of truth, the SSE stream is just its live tail.
//
// Transport pattern reused verbatim from the existing /api/chat SSE endpoint in
// server/index.js (~lines 97-135): res.writeHead with text/event-stream, headers
// disabling proxy buffering, res.write('...\n\n') frames, and an interval-based
// ': keepalive\n\n' comment so intermediary proxies/serverless runtimes do not
// idle the connection out. Unlike /api/chat (which sends bare `data:` frames),
// SSE clients here also get a named `event:<type>` line so `EventSource`
// listeners can `addEventListener(type, …)` per ODARunEventType.
//
// Plain ES module. No external dependencies.

/**
 * @typedef {import('./contracts.d.ts').ODARun} ODARun
 * @typedef {import('./contracts.d.ts').ODARunEvent} ODARunEvent
 * @typedef {import('./contracts.d.ts').ODARunEventType} ODARunEventType
 */

/** @type {Map<string, Set<import('http').ServerResponse>>} runId -> subscribed SSE responses */
const subscribers = new Map();

/** Every legal ODARunEventType, in emission-order-ish grouping — see contracts.d.ts. */
export const EVENT_TYPES = Object.freeze([
  'run.created',
  'request.interpreted',
  'pipeline.selected',
  'skill.queued',
  'skill.started',
  'skill.progress',
  'question.required',
  'evidence.added',
  'artifact.created',
  'artifact.preview.updated',
  'verification.started',
  'verification.failed',
  'verification.passed',
  'skill.completed',
  'run.completed',
  'run.failed',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

/**
 * Build, append and fan out a durable ODARunEvent.
 *
 * The event is pushed onto `run.events` (the durable log the caller — runStore —
 * persists to disk immediately after); it is then written live to every SSE
 * response currently subscribed to `run.runId`. This function never persists
 * anything itself: runStore.js owns disk write-through so every mutation goes
 * through one place.
 *
 * @param {ODARun} run
 * @param {ODARunEventType} type
 * @param {object} data
 * @returns {ODARunEvent}
 */
export function emitRunEvent(run, type, data) {
  if (!EVENT_TYPE_SET.has(type)) {
    throw new Error(`ODA_UNKNOWN_EVENT_TYPE: '${type}' is not one of ${EVENT_TYPES.join(', ')}`);
  }
  /** @type {ODARunEvent} */
  const event = {
    seq: run.events.length + 1,
    runId: run.runId,
    type,
    ts: new Date().toISOString(),
    data: data ?? {},
  };
  run.events.push(event);

  const frame = `event:${type}\ndata:${JSON.stringify(event)}\n\n`;
  const conns = subscribers.get(run.runId);
  if (conns) {
    for (const res of conns) {
      if (res.writableEnded) continue;
      res.write(frame);
      res.flush?.();
    }
  }
  return event;
}

/**
 * Attach an Express `res` as an SSE subscriber for `runId`.
 *
 * Sets the standard SSE headers, optionally replays the durable event log for
 * reconnection recovery (M13), registers the connection for live fan-out, and
 * starts a 25s keepalive comment ping. Cleans itself up when the client closes
 * the connection.
 *
 * @param {string} runId
 * @param {import('http').ServerResponse} res
 * @param {{ since?: number, run?: ODARun|null }} [opts]
 */
export function subscribe(runId, res, { since = 0, run = null } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  // M13 reconnection recovery: replay everything the client missed before
  // wiring it into live fan-out, so the client never sees a gap in `seq`.
  if (run) {
    for (const event of run.events) {
      if (event.seq > since) {
        res.write(`event:${event.type}\ndata:${JSON.stringify(event)}\n\n`);
      }
    }
    res.flush?.();
  }

  let conns = subscribers.get(runId);
  if (!conns) {
    conns = new Set();
    subscribers.set(runId, conns);
  }
  conns.add(res);

  // Transport-level comment frame only — never an ODARunEvent, never parsed by
  // EventSource listeners. Keeps proxies/serverless runtimes from idling out.
  const keepalive = setInterval(() => {
    if (res.writableEnded) return;
    res.write(': keepalive\n\n');
    res.flush?.();
  }, 25000);

  const cleanup = () => {
    clearInterval(keepalive);
    const set = subscribers.get(runId);
    if (set) {
      set.delete(res);
      if (set.size === 0) subscribers.delete(runId);
    }
  };
  res.on('close', cleanup);
}

/**
 * Number of SSE connections currently subscribed to `runId`.
 * @param {string} runId
 * @returns {number}
 */
export function subscriberCount(runId) {
  return subscribers.get(runId)?.size ?? 0;
}
