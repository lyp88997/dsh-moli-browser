/**
 * 浏览器守护进程（supervisor）：
 *   spawn 内核 → 等 CDP 就绪 → 在公开端口起回环代理 → 写状态文件 → 空闲自杀 / 崩溃重启。
 * 状态文件只对本机用户可读（0600），里面的 token 就是访问公开端口的凭据。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { assertKernelExecutable, browserArgs, ensureRoot, logFile, stateFile } from './config.mjs';
import { createProxy } from './proxy.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function probeVersion(port, timeoutMs = 2000, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function pickPort(base) {
  for (let i = 0; i < 500; i += 1) {
    const p = base + i;
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port from ${base}`);
}

export function readState(root) {
  const file = stateFile(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 前台运行守护进程；调用方 await 它直到退出。 */
export async function runSupervisor(cfg, { log = (m) => appendFileSync(logFile(cfg.root), `${new Date().toISOString()} ${m}\n`) } = {}) {
  ensureRoot(cfg.root);
  if (!cfg.kernel) throw new Error('未找到浏览器内核：用 --kernel <路径>、--wrapper <路径> 或 DSH_BROWSER_CHROME / DSH_BROWSER_WRAPPER 指定');
  assertKernelExecutable(cfg.kernel);

  const token = randomUUID();
  let shuttingDown = false;
  let browser = null;
  let proxy = null;
  let idleTimer = null;
  let lastActivityAt = Date.now();
  let restarts = 0;
  let respawning = false;
  let startedAt = null;
  let restartWindowStart = Date.now();
  let internalPort = await pickPort(cfg.internalPortBase);
  const version = {};
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const writeState = (extra = {}) => {
    startedAt ??= new Date().toISOString();
    const state = {
      supervisorPid: process.pid,
      browserPid: browser?.pid ?? null,
      port: proxy?.port ?? null,
      internalPort,
      listening: Boolean(proxy?.listening),
      token,
      kernel: cfg.kernel,
      kernelKind: cfg.kernelKind,
      protocolVersion: version['Protocol-Version'] ?? null,
      browserVersion: version.Browser ?? null,
      startedAt,
      idleMs: cfg.idleMs,
      ...extra,
    };
    writeFileSync(stateFile(cfg.root), JSON.stringify(state, null, 2), { mode: 0o600 });
    return state;
  };

  const waitHealthy = async (port, deadlineMs) => {
    const until = Date.now() + deadlineMs;
    while (Date.now() < until) {
      if (shuttingDown) return null;
      const v = await probeVersion(port, 2000, token);
      if (v) return v;
      await sleep(150);
    }
    return null;
  };

  const shutdown = async (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearInterval(idleTimer);
    log(`shutdown: ${reason}`);
    if (proxy) await proxy.close();
    // 用 spawn 返回的子进程句柄判活，不要用裸 pid：pid 可被系统复用，
    // isAlive(pid) 对任何同 uid 进程都为 true，会对陌生进程发 SIGKILL。
    const child = browser;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 30 && child.exitCode === null && child.signalCode === null; i += 1) await sleep(100);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    rmSync(stateFile(cfg.root), { force: true });
    resolveDone({ reason });
  };

  // 信号与退出钩子必须在拉起内核之前就装好：启动窗口（最长 startTimeoutMs）内收到
  // SIGTERM/SIGINT 若走 Node 默认行为，会留下没有状态文件、事后无法回收的孤儿内核。
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => void shutdown(`signal:${sig}`));
  }
  process.once('exit', () => {
    try {
      browser?.kill?.('SIGKILL');
    } catch {
      /* 退出钩子里只能尽力而为 */
    }
  });

  const spawnBrowser = async () => {
    if (shuttingDown) throw new Error('已取消启动（守护进程正在退出）');
    internalPort = await pickPort(cfg.internalPortBase);
    const args = browserArgs(cfg, internalPort);
    log(`spawn ${cfg.kernel} ${args.join(' ')}`);
    const out = openSync(logFile(cfg.root), 'a', 0o600);
    const child = spawn(cfg.kernel, args, { stdio: ['ignore', out, out], env: process.env });
    browser = child;
    if (shuttingDown) {
      child.kill('SIGKILL');
      throw new Error('已取消启动（守护进程正在退出）');
    }
    // 没有 'error' 监听时 spawn 失败会以 `Unhandled 'error' event` 从进程顶层崩掉。
    child.on('error', (error) => {
      log(`spawn error: ${error.message}`);
      if (shuttingDown) return;
      void shutdown('spawn-error');
    });
    child.on('exit', (code, signal) => {
      log(`browser exited code=${code} signal=${signal}`);
      if (shuttingDown) return;
      const now = Date.now();
      if (now - restartWindowStart > cfg.restartWindowMs) {
        restartWindowStart = now;
        restarts = 0;
      }
      restarts += 1;
      if (restarts > cfg.maxRestarts) {
        log(`restart budget exhausted (${restarts - 1}) -> shutdown`);
        void shutdown('crash-loop');
        return;
      }
      if (respawning) {
        log('respawn already in flight -> skip');
        return;
      }
      respawning = true;
      log(`restart #${restarts}`);
      void (async () => {
        try {
          await spawnBrowser();
        } catch (err) {
          log(`respawn failed: ${err.message}`);
          void shutdown('respawn-failed');
        } finally {
          respawning = false;
        }
      })();
    });
    const v = await waitHealthy(internalPort, cfg.startTimeoutMs);
    if (!v) {
      log(`kernel not ready in ${cfg.startTimeoutMs}ms -> kill`);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      throw new Error(`浏览器在 ${cfg.startTimeoutMs}ms 内未就绪（见 ${logFile(cfg.root)}）`);
    }
    Object.assign(version, v);
    proxy?.setTarget(internalPort);
    if (proxy) writeState();
    log(`cdp ready on 127.0.0.1:${internalPort} (${v.Browser})`);
  };

  let state;
  try {
    await spawnBrowser();

    proxy = createProxy({
      listenPort: cfg.port,
      targetPort: internalPort,
      token,
      log,
      onConnect: () => {
        lastActivityAt = Date.now();
      },
    });
    const publicPort = await proxy.listen();
    const viaProxy = await waitHealthy(publicPort, 5000);
    if (!viaProxy) throw new Error(`代理端口 ${publicPort} 无法访问 CDP（见 ${logFile(cfg.root)}）`);
    lastActivityAt = Date.now();

    state = writeState();
    log(`listening on 127.0.0.1:${publicPort} -> :${internalPort}（要求 Bearer token）`);
    process.stdout.write(`${JSON.stringify({ ready: true, ...state })}\n`);
  } catch (error) {
    // 启动中途失败（端口撞车、代理健康检查超时…）：先把已拉起的资源收干净再抛，
    // 否则会留下没有状态文件、事后无法回收的孤儿 chromium。
    await shutdown('startup-failed');
    throw error;
  }

  idleTimer = setInterval(() => {
    if (shuttingDown) return;
    if (proxy.connections === 0 && Date.now() - lastActivityAt >= cfg.idleMs) void shutdown('idle');
  }, Math.min(1000, Math.max(200, Math.floor(cfg.idleMs / 4))));
  idleTimer.unref?.();

  await done;
  return state;
}
