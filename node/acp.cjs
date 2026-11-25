const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const MAX_OUTPUT_BYTES = 512 * 1024;
const sessions = new Map();
const active = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message }, result: null });
}

function textFromPrompt(prompt) {
  if (typeof prompt === 'string') return prompt;
  if (!Array.isArray(prompt)) return '';
  return prompt.map((block) => {
    if (!block || typeof block !== 'object') return '';
    if (block.type === 'text' && typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
  }).join('');
}

function publish(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text }
      }
    }
  });
}

function runPrompt(id, sessionId, promptText) {
  const session = sessions.get(sessionId);
  if (!session) {
    fail(id, -32602, 'Unknown sessionId');
    return;
  }
  if (active.has(sessionId)) {
    fail(id, -32000, 'A prompt is already running for this session');
    return;
  }

  const args = ['agent', '--classic', '--no-markdown', '-m', promptText];
  const child = spawn('nanobot', args, { cwd: session.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  active.set(sessionId, child);

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    active.delete(sessionId);
    fail(id, -32000, '无法启动 nanobot：' + String(error && error.message || error));
  });
  child.on('close', (code) => {
    active.delete(sessionId);
    const text = stdout || stderr || 'nanobot 未返回输出';
    publish(sessionId, text.slice(0, MAX_OUTPUT_BYTES));
    reply(id, { stopReason: code === 0 ? 'end_turn' : 'error' });
  });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' }, result: null });
    return;
  }
  if (!request || typeof request !== 'object') return;

  const id = request.id;
  const params = request.params || {};

  if (request.method === 'initialize') {
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false },
        sessionCapabilities: {}
      },
      agentInfo: { name: 'nanobot', title: 'Nanobot Harness', version: 'acp-bridge-1.0.1' },
      authMethods: []
    });
    return;
  }
  if (request.method === 'session/new') {
    const sessionId = randomUUID();
    sessions.set(sessionId, { cwd: typeof params.cwd === 'string' ? params.cwd : process.cwd() });
    reply(id, { sessionId });
    return;
  }
  if (request.method === 'session/prompt') {
    runPrompt(id, params.sessionId, textFromPrompt(params.prompt));
    return;
  }
  if (request.method === 'session/cancel') {
    const child = active.get(params.sessionId);
    if (child && !child.killed) child.kill('SIGTERM');
    if (id !== undefined) reply(id, {});
    return;
  }
  if (request.method === 'session/close') {
    const child = active.get(params.sessionId);
    if (child && !child.killed) child.kill('SIGTERM');
    active.delete(params.sessionId);
    sessions.delete(params.sessionId);
    if (id !== undefined) reply(id, {});
    return;
  }
  if (id !== undefined) fail(id, -32601, 'Method not found');
});

