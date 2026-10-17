import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function processTable() {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8', env: {}, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).trim().split('\n').filter(Boolean).map(row => {
    const [pid, parent, group, state] = row.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), live: !state.startsWith('Z') };
  });
}

export async function runVerification(command, args, { cwd, env, timeout = 240000 } = {}) {
  if (process.platform === 'win32') throw new Error('Verification requires POSIX process groups');
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', failure;
    const owned = new Set();
    const killOwned = () => {
      if (!child.pid) return;
      try {
        const rows = processTable();
        owned.add(child.pid);
        for (const row of rows) if (row.group === child.pid) owned.add(row.pid);
        let changed;
        do {
          changed = false;
          for (const row of rows) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
        } while (changed);
        for (const pid of [...owned].reverse()) {
          if (!rows.some(row => row.pid === pid && row.live)) continue;
          try { process.kill(pid, 'SIGKILL'); } catch (error) {
            if (error.code === 'ESRCH') continue;
            if (error.code === 'EPERM' && process.platform === 'darwin' && !processTable().some(row => row.pid === pid && row.live)) continue;
            throw error;
          }
        }
      } catch (error) { failure ||= error; }
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) {
        if (error.code === 'ESRCH') return;
        if (error.code === 'EPERM' && process.platform === 'darwin') {
          try { if (!processTable().some(row => row.group === child.pid && row.live)) return; } catch {}
        }
        failure ||= error;
      }
    };
    const interrupted = () => { failure ||= new Error(`${command} interrupted`); killOwned(); };
    process.on('SIGTERM', interrupted);
    process.on('SIGINT', interrupted);
    const timer = setTimeout(() => { failure ||= new Error(`${command} timed out after ${timeout}ms`); killOwned(); }, timeout);
    for (const [stream, append] of [[child.stdout, text => { stdout += text; }], [child.stderr, text => { stderr += text; }]]) {
      stream.setEncoding('utf8');
      stream.on('data', text => {
        append(text);
        if (stdout.length + stderr.length > 8 * 1024 * 1024) { failure ||= new Error('Verification output limit exceeded'); killOwned(); }
      });
    }
    child.once('error', error => { failure = error; });
    child.once('exit', killOwned);
    child.once('close', async (code, signal) => {
      clearTimeout(timer);
      killOwned();
      try {
        for (let attempt = 0; child.pid; attempt++) {
          if (!processTable().some(row => owned.has(row.pid) && row.live)) break;
          if (attempt === 100) throw new Error('Verification descendants did not terminate');
          await delay(20);
        }
      } catch (error) { failure ||= error; }
      process.removeListener('SIGTERM', interrupted);
      process.removeListener('SIGINT', interrupted);
      if (failure || code !== 0) reject(new Error(`${failure?.message || `${command} failed (${code ?? signal})`}: ${String(stderr || stdout).slice(-8000)}`));
      else resolve(stdout);
    });
  });
}
