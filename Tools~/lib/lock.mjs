import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const HEARTBEAT_MS = 5_000;
const STALE_MS = 30_000;
const ownerFile = (dir) => path.join(dir, 'owner.json');

function readOwner(dir) {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(dir), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * A holder touches its owner file every few seconds. The lock is stale when that heartbeat stops,
 * which works across sandboxes and PID namespaces where checking the pid would not.
 */
function isStale(dir) {
  const stat = fs.statSync(ownerFile(dir), { throwIfNoEntry: false }) ?? fs.statSync(dir, { throwIfNoEntry: false });
  return Boolean(stat) && Date.now() - stat.mtimeMs > STALE_MS;
}

/**
 * Runs fn while holding UIKit/.locks/<name>, so parallel agents do not interleave writes to shared
 * outputs. A holder only removes its own lock (token check). Released on return, throw and process.exit;
 * a crashed holder's lock is broken 30 s after its last heartbeat.
 */
export async function withLock(project, name, fn, { timeoutMs = 300_000 } = {}) {
  const dir = path.join(project.dir, '.locks', name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const token = `${process.pid}-${crypto.randomUUID()}`;
  const start = Date.now();

  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(ownerFile(dir), JSON.stringify({ pid: process.pid, token }));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // Read the owner before the stale check: by the time we act, another waiter may have replaced it.
    const staleToken = readOwner(dir)?.token;
    if (isStale(dir)) {
      // Move the stale lock aside atomically; if it turns out to be someone's fresh lock, put it back.
      // Known narrow race: if a third process takes the lock between the rename and the rename-back,
      // the put-back fails and two holders can overlap. It needs a stale lock to exist first.
      const aside = `${dir}.stale-${token}`;
      try {
        fs.renameSync(dir, aside);
        if (readOwner(aside)?.token !== staleToken) fs.renameSync(aside, dir);
        else fs.rmSync(aside, { recursive: true, force: true });
      } catch {
        // Another waiter got there first; just try again.
      }
      continue;
    }
    if (Date.now() - start > timeoutMs)
      throw new Error(`lock "${name}" held by pid ${readOwner(dir)?.pid} for over ${timeoutMs / 1000}s (${dir})`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const heartbeat = setInterval(() => {
    const now = new Date();
    try {
      fs.utimesSync(ownerFile(dir), now, now);
    } catch {
      // Lock dir gone (released or broken); nothing to refresh.
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const release = () => {
    clearInterval(heartbeat);
    if (readOwner(dir)?.token === token) fs.rmSync(dir, { recursive: true, force: true });
  };
  process.once('exit', release);
  try {
    return await fn();
  } finally {
    release();
    process.removeListener('exit', release);
  }
}
