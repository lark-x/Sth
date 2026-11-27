import { spawn } from 'node:child_process';
import { stopHostProcess } from './host-process.mjs';

// ACP can validate authentication before any prompt. Unexpected account access
// stops the probe before model execution. Never send authenticate or logout.
export function antigravityAuthStatus(launcher, { env, cwd, timeout = 20_000 }) {
  return new Promise((done, reject) => {
    const child = spawn(launcher.command, [...launcher.args, 'acp', '--gemini-dir', '.gemini',
      '--app-data-dir', 'sth-acp', '--disable-telemetry'], { env, cwd, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    let initialized;
    let outcome;
    const timer = setTimeout(() => { outcome = { status: 'timeout' }; void stopHostProcess(child); }, timeout);
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    function send(id, method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); }
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1_000_000) { outcome = { status: 'invalid_acp_response' }; void stopHostProcess(child); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (!message.result?.agentInfo) { outcome = { status: 'acp_initialization_failed' }; void stopHostProcess(child); return; }
          initialized = { agent: message.result.agentInfo, authMethods: (message.result.authMethods || []).map(item => item.id) };
          send(2, 'session/new', { cwd, mcpServers: [] });
        } else if (message.id === 2) {
          outcome = message.error?.code === -32000 && message.error?.message === 'Authentication required'
            ? { status: 'authentication_required', ...initialized, error: { code: -32000, message: 'Authentication required' } }
            : { status: message.result?.sessionId ? 'unexpected_authenticated_session' : 'acp_session_failed', ...initialized,
              ...(message.error ? { errorCode: message.error.code } : {}) };
          void stopHostProcess(child);
        }
      }
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start the Antigravity ACP executable.')); });
    child.once('close', () => { clearTimeout(timer); done(outcome || { status: 'acp_exited' }); });
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'sth-host-probe', version: '1.0.0' } });
  });
}
