/**
 * Drawbridge - Real-time Excalidraw diagram server
 *
 * HTTP + WebSocket bridge that lets any AI (Claude, GPT, etc.) or script
 * push diagram elements to an Excalidraw canvas in real time.
 *
 * HTTP API (default port 3062, configurable via DRAWBRIDGE_API_PORT):
 *   POST /api/session/:id/elements - Replace all elements
 *   POST /api/session/:id/append  - Add elements (progressive drawing)
 *   POST /api/session/:id/clear   - Clear canvas
 *   POST /api/session/:id/viewport - Set camera position/zoom
 *   POST /api/session/:id/undo    - Undo last operation
 *   GET  /api/session/:id         - Get current elements
 *   GET  /api/sessions            - List active sessions
 *   GET  /health                  - Health check
 *
 * Persistence:
 *   Sessions are persisted to disk using append-only logs + periodic snapshots.
 *   Data stored in ./data/ (configurable via DRAWBRIDGE_DATA_DIR).
 *   Undo replays the log minus the last entry.
 *
 * WebSocket (default port 3061, configurable via DRAWBRIDGE_WS_PORT):
 *   ws://host:PORT/ws/:sessionId  - Real-time bidirectional updates
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';

const WS_PORT = parseInt(process.env.DRAWBRIDGE_WS_PORT || '3061');
const API_PORT = parseInt(process.env.DRAWBRIDGE_API_PORT || '3062');
const DATA_DIR = process.env.DRAWBRIDGE_DATA_DIR || join(import.meta.dirname, 'data');
const SNAPSHOT_INTERVAL = 20; // Write snapshot every N operations

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

// --- Persistence: Append-only log + snapshot ---

function snapshotPath(sessionId) {
  return join(DATA_DIR, `${sessionId}.snapshot.json`);
}

function logPath(sessionId) {
  return join(DATA_DIR, `${sessionId}.log`);
}

function writeSnapshot(sessionId, session) {
  const tmp = snapshotPath(sessionId) + '.tmp';
  writeFileSync(tmp, JSON.stringify({
    elements: session.elements,
    appState: session.appState,
    viewport: session.viewport,
  }));
  renameSync(tmp, snapshotPath(sessionId));
  // Truncate log after snapshot
  writeFileSync(logPath(sessionId), '');
  session._opsSinceSnapshot = 0;
}

function appendLog(sessionId, session, op) {
  appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n');
  session._opsSinceSnapshot = (session._opsSinceSnapshot || 0) + 1;
  if (session._opsSinceSnapshot >= SNAPSHOT_INTERVAL) {
    writeSnapshot(sessionId, session);
  }
}

function applyOp(session, op) {
  switch (op.type) {
    case 'set':
      session.elements = op.elements;
      if (op.appState) session.appState = op.appState;
      break;
    case 'append':
      session.elements = [...session.elements, ...op.elements];
      break;
    case 'clear':
      session.elements = [];
      session.appState = null;
      session.viewport = null;
      break;
    case 'viewport':
      session.viewport = op.viewport;
      break;
    case 'update':
      session.elements = op.elements;
      break;
  }
}

function loadSession(sessionId) {
  const session = { elements: [], appState: null, viewport: null, clients: new Set(), _opsSinceSnapshot: 0 };

  // Load snapshot if exists
  const sp = snapshotPath(sessionId);
  if (existsSync(sp)) {
    try {
      const snap = JSON.parse(readFileSync(sp, 'utf-8'));
      session.elements = snap.elements || [];
      session.appState = snap.appState || null;
      session.viewport = snap.viewport || null;
    } catch (err) {
      console.error(`[Persist] Failed to load snapshot for ${sessionId}:`, err.message);
    }
  }

  // Replay log entries
  const lp = logPath(sessionId);
  if (existsSync(lp)) {
    try {
      const lines = readFileSync(lp, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        applyOp(session, JSON.parse(line));
      }
      session._opsSinceSnapshot = lines.length;
    } catch (err) {
      console.error(`[Persist] Failed to replay log for ${sessionId}:`, err.message);
    }
  }

  return session;
}

function deleteSessionFiles(sessionId) {
  try { unlinkSync(snapshotPath(sessionId)); } catch {}
  try { unlinkSync(logPath(sessionId)); } catch {}
}

// Pop the last operation from the log, rebuild state
function undoLastOp(sessionId, session) {
  const lp = logPath(sessionId);
  let lines = [];
  if (existsSync(lp)) {
    lines = readFileSync(lp, 'utf-8').split('\n').filter(l => l.trim());
  }

  if (lines.length === 0) {
    // Nothing in log — would need to restore from previous snapshot, which we don't keep
    return false;
  }

  // Remove last line
  lines.pop();
  writeFileSync(lp, lines.length > 0 ? lines.join('\n') + '\n' : '');

  // Rebuild from snapshot + remaining log
  const rebuilt = loadSession(sessionId);
  session.elements = rebuilt.elements;
  session.appState = rebuilt.appState;
  session.viewport = rebuilt.viewport;
  session._opsSinceSnapshot = rebuilt._opsSinceSnapshot;

  return true;
}

// Session storage: sessionId -> { elements, clients, viewport, _opsSinceSnapshot }
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    const session = loadSession(id);
    sessions.set(id, session);
    if (session.elements.length > 0) {
      console.log(`[Persist] Restored session ${id}: ${session.elements.length} elements`);
    }
  }
  return sessions.get(id);
}

/**
 * Extract cameraUpdate pseudo-elements from an elements array.
 * Returns { drawElements, viewports } where viewports are camera commands
 * and drawElements are real Excalidraw elements.
 */
function extractViewportUpdates(elements) {
  const drawElements = [];
  const viewports = [];
  for (const el of elements) {
    if (el.type === 'cameraUpdate' || el.type === 'viewportUpdate') {
      viewports.push({ x: el.x || 0, y: el.y || 0, width: el.width || 800, height: el.height || 600 });
    } else {
      drawElements.push(el);
    }
  }
  return { drawElements, viewports };
}

function broadcast(session, msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  }
}

// --- WebSocket Server (port 3061) ---

const wsServer = createServer();
const wss = new WebSocketServer({ noServer: true });

wsServer.on('upgrade', (request, socket, head) => {
  const { pathname } = parse(request.url || '');
  const match = pathname?.match(/^\/ws\/(.+)$/);

  if (!match) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const sessionId = match[1];
    const session = getSession(sessionId);
    session.clients.add(ws);

    console.log(`[WS] Client connected to session: ${sessionId} (${session.clients.size} clients)`);

    // Send current state on connect
    if (session.elements.length > 0) {
      ws.send(JSON.stringify({
        type: 'elements',
        elements: session.elements,
        appState: session.appState,
      }));
    }
    // Send current viewport if set
    if (session.viewport) {
      ws.send(JSON.stringify({
        type: 'viewport',
        viewport: session.viewport,
      }));
    }

    // Debounce persistence for user edits (onChange fires on every mouse move)
    let persistTimer = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'update') {
          session.elements = msg.elements;
          // Debounce disk writes — only persist after 500ms of quiet
          if (persistTimer) clearTimeout(persistTimer);
          persistTimer = setTimeout(() => {
            appendLog(sessionId, session, { type: 'update', elements: session.elements });
          }, 500);
          // Broadcast to other clients immediately (not the sender)
          for (const client of session.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'elements',
                elements: msg.elements,
              }));
            }
          }
        }
      } catch (err) {
        console.error('[WS] Message parse error:', err);
      }
    });

    ws.on('close', () => {
      // Flush any pending debounced persist
      if (persistTimer) {
        clearTimeout(persistTimer);
        appendLog(sessionId, session, { type: 'update', elements: session.elements });
      }
      session.clients.delete(ws);
      console.log(`[WS] Client disconnected from session: ${sessionId} (${session.clients.size} clients)`);
      // Evict from memory after 5 minutes with no clients (data stays on disk)
      if (session.clients.size === 0) {
        setTimeout(() => {
          const s = sessions.get(sessionId);
          if (s && s.clients.size === 0) {
            // Write final snapshot before evicting from memory
            if (s.elements.length > 0) {
              writeSnapshot(sessionId, s);
            }
            sessions.delete(sessionId);
            console.log(`[WS] Session evicted from memory: ${sessionId} (data persisted on disk)`);
          }
        }, 5 * 60 * 1000);
      }
    });
  });
});

wsServer.listen(WS_PORT, () => {
  console.log(`[WS] WebSocket server running on port ${WS_PORT}`);
});

// --- HTTP API Server (port 3062) ---

const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS for local dev
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  const sessionCount = sessions.size;
  let clientCount = 0;
  for (const s of sessions.values()) clientCount += s.clients.size;
  res.json({ status: 'ok', sessions: sessionCount, clients: clientCount });
});

// List active sessions
app.get('/api/sessions', (_req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      elementCount: session.elements.length,
      clientCount: session.clients.size,
    });
  }
  res.json(list);
});

// Get session elements
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({
    id: req.params.id,
    elements: session.elements,
    appState: session.appState,
    viewport: session.viewport,
  });
});

// Replace all elements in a session (strips cameraUpdate pseudo-elements)
app.post('/api/session/:id/elements', (req, res) => {
  const session = getSession(req.params.id);
  const { elements, appState } = req.body;
  const { drawElements, viewports } = extractViewportUpdates(elements || []);

  session.elements = drawElements;
  if (appState) session.appState = appState;
  appendLog(req.params.id, session, { type: 'set', elements: drawElements, appState: appState || null });

  // Send elements to all clients
  broadcast(session, {
    type: 'elements',
    elements: session.elements,
    appState: session.appState,
  });

  // Send viewport updates (use last one as the final camera position)
  if (viewports.length > 0) {
    const viewport = viewports[viewports.length - 1];
    session.viewport = viewport;
    appendLog(req.params.id, session, { type: 'viewport', viewport });
    broadcast(session, { type: 'viewport', viewport });
  }

  res.json({ success: true, elementCount: session.elements.length, clients: session.clients.size });
});

// Append elements to a session (strips cameraUpdate pseudo-elements)
app.post('/api/session/:id/append', (req, res) => {
  const session = getSession(req.params.id);
  const { elements } = req.body;

  if (elements && elements.length) {
    const { drawElements, viewports } = extractViewportUpdates(elements);

    if (drawElements.length > 0) {
      session.elements = [...session.elements, ...drawElements];
      appendLog(req.params.id, session, { type: 'append', elements: drawElements });
      broadcast(session, { type: 'append', elements: drawElements });
    }

    if (viewports.length > 0) {
      const viewport = viewports[viewports.length - 1];
      session.viewport = viewport;
      appendLog(req.params.id, session, { type: 'viewport', viewport });
      broadcast(session, { type: 'viewport', viewport });
    }
  }

  res.json({ success: true, elementCount: session.elements.length });
});

// Set viewport/camera directly
app.post('/api/session/:id/viewport', (req, res) => {
  const session = getSession(req.params.id);
  const { x, y, width, height } = req.body;

  const viewport = {
    x: x || 0,
    y: y || 0,
    width: width || 800,
    height: height || 600,
  };

  session.viewport = viewport;
  broadcast(session, { type: 'viewport', viewport });

  res.json({ success: true, viewport });
});

// Clear session
app.post('/api/session/:id/clear', (req, res) => {
  const session = getSession(req.params.id);
  session.elements = [];
  session.appState = null;
  session.viewport = null;
  deleteSessionFiles(req.params.id);

  broadcast(session, { type: 'clear' });

  res.json({ success: true });
});

// Undo last operation
app.post('/api/session/:id/undo', (req, res) => {
  const session = getSession(req.params.id);
  const success = undoLastOp(req.params.id, session);

  if (success) {
    broadcast(session, {
      type: 'elements',
      elements: session.elements,
      appState: session.appState,
    });
    res.json({ success: true, elementCount: session.elements.length });
  } else {
    res.json({ success: false, message: 'Nothing to undo' });
  }
});

app.listen(API_PORT, () => {
  console.log(`[HTTP] API server running on port ${API_PORT}`);
});
