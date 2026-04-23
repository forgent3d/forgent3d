/**
 * Built-in MCP server for the AI CAD companion previewer
 * ------------------------------------------
 * - transport: Streamable HTTP on fixed localhost port
 * - 4 tools: list_parts / get_part_info / screenshot_part / rebuild_part
 * - ctx is injected from electron/main.js; all runtime state is accessed via callbacks
 * - Each MCP client (Cursor / curl) gets isolated McpServer + Transport on initialize,
 *   then POST/GET/DELETE is routed by Mcp-Session-Id so curl testing does not break Cursor sessions.
 *
 * SDK is ESM while main.js is CJS, so SDK is loaded via dynamic import().
 */

const http = require('http');
const { randomUUID } = require('crypto');

let state = null;

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bodyContainsInitialize(parsed) {
  if (parsed == null) return false;
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr.some((m) => m && typeof m === 'object' && m.method === 'initialize');
}

function sessionIdFromReq(req) {
  return String(req.headers['mcp-session-id'] || '').trim();
}

function buildMcpServer(ctx, { McpServer, z }) {
  const server = new McpServer({
    name: 'aicad',
    version: '0.1.0'
  });

  server.registerTool(
    'list_parts',
    {
      title: 'List all models in the current project',
      description: [
        'Purpose: return project kernel, source file type, active model, and model list (including screenshot/geometry cache states).',
        'Prerequisite: none.',
        'If failed: if error is returned, verify previewer has opened a project and retry.'
      ].join('\n'),
      inputSchema: {}
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify(ctx.listParts(), null, 2) }]
    })
  );

  server.registerTool(
    'get_part_info',
    {
      title: 'Get quantitative geometry info for a model',
      description: [
        'Purpose: return bbox, faceCount, cacheStale, kind, sourceFile, and description for numerical geometry verification.',
        'Prerequisite: recommended to call list_parts first to confirm model name and kernel type.',
        'If failed: call rebuild_part first; if still failing, call list_parts to verify model name and active state, then retry.'
      ].join('\n'),
      inputSchema: {
        part: z.string().describe('Model directory name, for example "bracket"')
      }
    },
    async ({ part }) => {
      const info = await ctx.getPartInfo(part);
      const isError = !!info.error;
      return {
        isError,
        content: [{ type: 'text', text: JSON.stringify(info, null, 2) }]
      };
    }
  );

  server.registerTool(
    'screenshot_part',
    {
      title: 'Get a 3D screenshot (PNG) for a model',
      description: [
        'Purpose: return the latest PNG for the requested view; the active model will switch during the call.',
        'Prerequisite: recommended to run rebuild_part successfully first to avoid stale screenshots.',
        'If failed: run rebuild_part first; if the screenshot is still missing, call list_parts to confirm the model exists and retry.'
      ].join('\n'),
      inputSchema: {
        part: z.string().describe('Model directory name'),
        view: z.enum(['iso', 'front', 'side', 'top']).optional().describe('Screenshot view, defaults to iso')
      }
    },
    async ({ part, view }) => {
      const actualView = view || 'iso';
      const png = await ctx.getPartScreenshot(part, actualView);
      if (!png) {
        return {
          isError: true,
          content: [{
            type: 'text',
            text:
              `No screenshot cache for model "${part}" (view: ${actualView}).\n` +
              `Next: call rebuild_part({"part":"${part}"}).\n` +
              `If it still fails, call list_parts to confirm "${part}" exists and name is correct, then call screenshot_part again.`
          }]
        };
      }
      return {
        content: [
          { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
          {
            type: 'text',
            text:
              `${actualView} screenshot for model "${part}". ` +
              `If another angle is needed, trigger the latest render through the model tools first, then call this tool again.`
          }
        ]
      };
    }
  );

  server.registerTool(
    'rebuild_part',
    {
      title: 'Force rebuild a model and wait for completion',
      description: [
        'Purpose: synchronously rebuild the model and return ok/stderr/cacheSize/faceCount/kernel; this is the only trusted verification entry.',
        'Prerequisite: the model must exist under models/<name>/ and the latest code must be saved.',
        'If failed: make minimal fix based on stderr and retry; after success call get_part_info/screenshot_part.'
      ].join('\n'),
      inputSchema: {
        part: z.string()
      }
    },
    async ({ part }) => {
      const result = await ctx.rebuildPartSync(part);
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    }
  );

  return server;
}

async function disposeSessionEntry(entry) {
  if (!entry) return;
  try { await entry.transport.close(); } catch {}
  try { await entry.server.close(); } catch {}
}

async function start(ctx, { port = 41234 } = {}) {
  if (state) throw new Error('MCP server is already started');

  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const { z } = await import('zod');

  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/mcp') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const sid = sessionIdFromReq(req);

      if (req.method === 'DELETE') {
        if (!sid || !sessions.has(sid)) {
          res.writeHead(sid ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: sid ? -32001 : -32000, message: sid ? 'Session not found' : 'Mcp-Session-Id required' },
            id: null
          }));
          return;
        }
        const entry = sessions.get(sid);
        sessions.delete(sid);
        await disposeSessionEntry(entry);
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === 'GET') {
        if (!sid || !sessions.has(sid)) {
          res.writeHead(sid ? 404 : 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: sid ? -32001 : -32000, message: sid ? 'Session not found' : 'Mcp-Session-Id required' },
            id: null
          }));
          return;
        }
        await sessions.get(sid).transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'POST') {
        const buf = await readRequestBody(req);
        let parsedBody;
        try {
          parsedBody = buf.length ? JSON.parse(buf.toString('utf8')) : null;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'Parse error: Invalid JSON' },
            id: null
          }));
          return;
        }

        if (bodyContainsInitialize(parsedBody)) {
          const mcpServer = buildMcpServer(ctx, { McpServer, z });
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID()
          });
          await mcpServer.connect(transport);
          await transport.handleRequest(req, res, parsedBody);
          const newSid = transport.sessionId;
          if (newSid) sessions.set(newSid, { server: mcpServer, transport });
          return;
        }

        if (!sid || !sessions.has(sid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            error: {
              code: -32000,
              message: sid ? 'Session not found' : 'Mcp-Session-Id required (send initialize first)'
            },
            id: null
          }));
          return;
        }

        await sessions.get(sid).transport.handleRequest(req, res, parsedBody);
        return;
      }

      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, POST, DELETE, OPTIONS' });
      res.end('Method Not Allowed');
    } catch (e) {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`MCP error: ${e?.message || e}`);
      }
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      httpServer.off('error', onError);
      reject(err);
    };
    httpServer.once('error', onError);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  state = { sessions, httpServer, port };
  return { port, url: `http://127.0.0.1:${port}/mcp` };
}

async function stop() {
  if (!state) return;
  const { sessions, httpServer } = state;
  state = null;
  for (const entry of sessions.values()) {
    await disposeSessionEntry(entry);
  }
  sessions.clear();
  try {
    await new Promise((r) => httpServer.close(() => r()));
  } catch {}
}

function isRunning() {
  return !!state;
}

/** @returns {{ port: number, url: string } | null} */
function getListenInfo() {
  if (!state) return null;
  return { port: state.port, url: `http://127.0.0.1:${state.port}/mcp` };
}

module.exports = { start, stop, isRunning, getListenInfo };
