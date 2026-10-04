#!/usr/bin/env node
/**
 * 端到端验收（零依赖：只用 node 内置 fetch / WebSocket / http）。
 *
 * 覆盖 M1 的全部承诺：
 *   1) CDP 就绪且协议版本正确
 *   2) 只绑回环（host 网络下的硬安全要求）
 *   3) 多客户端 + 隔离上下文（cookie 互不可见）
 *   4) 浏览器崩溃后自动重启、代理自动改指向
 *   5) 无客户端时按 idle 自杀并清理状态
 *
 * 用法：node scripts/verify-daemon.mjs
 */
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/browsersvc.mjs', import.meta.url));
const IDLE_MS = 5000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};

const guard = setTimeout(() => {
  console.error('\n超时（120s），提前退出');
  process.exit(1);
}, 120_000);
guard.unref?.();

async function probe(port, timeoutMs = 2000, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** 解析 /proc/net/tcp{,6}，返回该端口的 LISTEN 条目。 */
function listeners(port) {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out = [];
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n').slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const [addr, p] = parts[1].split(':');
      if (p === hex && parts[3] === '0A') out.push({ file, addr });
    }
  }
  return out;
}

const LOOPBACK4 = '0100007F';
const LOOPBACK6 = '00000000000000000000000001000000';
const ANY4 = '00000000';
const ANY6 = '00000000000000000000000000000000';

function assertLoopback(label, port) {
  const ls = listeners(port);
  const exposed = ls.filter((l) => l.addr === ANY4 || l.addr === ANY6);
  const ok = ls.length > 0 && exposed.length === 0;
  check(label, ok, ls.length === 0 ? `端口 ${port} 无监听` : `监听=${ls.map((l) => `${l.addr}(${l.file.split('/').pop()})`).join(',')}`);
  return ok;
}

/** 极简 CDP 客户端（原生 WebSocket）。wsUrl 必须是 /json/version 给出的地址（已被代理改写成
 *  走代理 + 带 token），直连内部端口会绕过凭据门 —— 那正是本脚本要证明不成立的事。 */
function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
      else resolve(msg.result);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message ?? 'unknown'}`)));
  });
  return {
    ready,
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`CDP 超时: ${method}`));
          }
        }, 20_000).unref?.();
      });
    },
    close: () => ws.close(),
  };
}

const evalIn = async (cdp, sessionId, expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
  return r.result?.value;
};

/** 在一个隔离上下文里开页、等加载完成，返回 sessionId。 */
async function openIsolatedContext(cdp, origin) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', {});
  const { targetId } = await cdp.send('Target.createTarget', { url: origin, browserContextId });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  for (let i = 0; i < 60; i += 1) {
    if ((await evalIn(cdp, sessionId, 'document.readyState')) === 'complete') break;
    await sleep(100);
  }
  return { browserContextId, targetId, sessionId };
}

// ── 1. 本地源（不依赖外网） ────────────────────────────────────────────────
const originServer = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end('<!doctype html><title>iso</title><h1>ok</h1>');
});
await new Promise((r) => originServer.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${originServer.address().port}/`;

// ── 2. 起守护进程 ─────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), 'browsersvc-verify-'));
const child = spawn(process.execPath, [BIN, 'run', `--root=${root}`, '--port=0', `--idle-ms=${IDLE_MS}`], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
// 任何提前退出（check 失败 / 未捕获异常）都要收掉内核和临时目录，别留孤儿（F18）。
const extraRoots = [];
let rootMissing;
let rootStuck;
let rootStop;
const cleanup = () => {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  for (const dir of [root, ...extraRoots]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
  }
};
process.on('exit', cleanup);
let out = '';
let err = '';
child.stdout.on('data', (d) => {
  out += d.toString();
});
child.stderr.on('data', (d) => {
  err += d.toString();
});

let info = null;
for (let i = 0; i < 150 && !info; i += 1) {
  await sleep(200);
  const line = out.split('\n').find((l) => l.includes('"ready":true'));
  if (line) info = JSON.parse(line);
  if (child.exitCode !== null) break;
}

if (!info) {
  check('守护进程启动', false, `未就绪；stderr=${err.trim().slice(0, 300)} log=${join(root, 'service.log')}`);
  console.log(`\n日志尾部:\n${existsSync(join(root, 'service.log')) ? readFileSync(join(root, 'service.log'), 'utf8').split('\n').slice(-12).join('\n') : '(无)'}`);
  process.exit(1);
}
check('守护进程启动', true, `公开端口 ${info.port} → 内部端口 ${info.internalPort}`);

const port = info.port;
const token = info.token;
const statePath = join(root, 'service.json');

// ── 2b. 公开端口的凭据门与路径白名单（F7） ────────────────────────────────
check('状态文件含 token 且不对外开放', typeof token === 'string' && token.length > 0 && (statSync(statePath).mode & 0o077) === 0, `mode=${(statSync(statePath).mode & 0o777).toString(8)}`);
const unauth = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.status).catch(() => 0);
check('无 token 访问公开端口被拒 (401)', unauth === 401, `status=${unauth}`);
const forbidden = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', headers: { authorization: `Bearer ${token}` } }).then((r) => r.status).catch(() => 0);
check('白名单外的路径被拒 (403)', forbidden === 403, `status=${forbidden}`);

const version = await probe(port, 2000, token);
check('CDP /json/version', version?.['Protocol-Version'] === '1.3', `Browser=${version?.Browser}`);
check('元数据 ws 地址被改写为走代理并带 token', typeof version?.webSocketDebuggerUrl === 'string' && new URL(version.webSocketDebuggerUrl).port === String(port) && version.webSocketDebuggerUrl.includes('token='), version?.webSocketDebuggerUrl);

// 同一条连接上的第二个请求也必须过凭据门与白名单：代理只解析首个请求头，若放行 keep-alive，
// 后续请求就是绕过检查的裸管道（F27）。
{
  const sock = net.createConnection({ host: '127.0.0.1', port });
  const chunks = [];
  let closed = false;
  sock.on('data', (c) => chunks.push(c));
  sock.on('close', () => {
    closed = true;
  });
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET /json/protocol HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${token}\r\nconnection: keep-alive\r\n\r\n`);
  await sleep(800);
  const firstText = Buffer.concat(chunks).toString('latin1');
  const firstOk = firstText.startsWith('HTTP/1.1 200');
  const firstLen = firstText.length;
  let secondText = '';
  let writeErr = '';
  try {
    sock.write(`PUT /json/new?about:blank HTTP/1.1\r\nhost: 127.0.0.1\r\nconnection: keep-alive\r\n\r\n`);
    await sleep(800);
    secondText = Buffer.concat(chunks).toString('latin1').slice(firstLen);
  } catch (e) {
    writeErr = `写入失败: ${e.code ?? e.message}`;
  }
  check('首个请求正常 200（同一条连接复用前的基线）', firstOk, `first="${firstText.split('\r\n')[0]}"`);
  check(
    '同一连接上的第二个请求（无凭据 PUT /json/new）拿不到 200（F27）',
    !secondText.includes('HTTP/1.1 200'),
    secondText ? `second="${secondText.split('\r\n')[0]}"` : `未收到第二个响应${writeErr ? `（${writeErr}）` : ''}`,
  );
  await sleep(4000);
  check('代理在响应后主动收掉非升级连接（不悬挂、不占连接计数）', closed === true, `closed=${closed}`);
  sock.destroy();
}

// 真正需要长连接的是 CDP WebSocket：空闲 11s 后仍须可用（头超时定时器必须在头收全后就撤掉，F20）。
{
  const cdp = connectCdp(version.webSocketDebuggerUrl);
  await cdp.ready;
  await sleep(11_000);
  let product = '';
  try {
    product = (await cdp.send('Browser.getVersion')).product;
  } catch (e) {
    product = `失败: ${e.message}`;
  }
  check('CDP WebSocket 空闲 11s 后仍可用（F20，真正长连接路径）', /Chrome\//.test(product), product);
  cdp.close();
}

// ── 3. 只绑回环 ───────────────────────────────────────────────────────────
assertLoopback('公开端口只绑 127.0.0.1', port);
assertLoopback('内部端口只绑 127.0.0.1', info.internalPort);

// ── 4. 隔离上下文 ─────────────────────────────────────────────────────────
try {
  const cdp = connectCdp(version.webSocketDebuggerUrl);
  await cdp.ready;
  const a = await openIsolatedContext(cdp, origin);
  const b = await openIsolatedContext(cdp, origin);
  check('两个隔离上下文（不同 browserContextId）', a.browserContextId !== b.browserContextId, `${a.browserContextId?.slice(0, 8)} vs ${b.browserContextId?.slice(0, 8)}`);
  const cookieA = await evalIn(cdp, a.sessionId, "document.cookie='iso=ctx1'; document.cookie");
  const cookieB = await evalIn(cdp, b.sessionId, 'document.cookie');
  check('上下文 A 能写 cookie', cookieA === 'iso=ctx1', `A="${cookieA}"`);
  check('上下文 B 看不到 A 的 cookie（隔离生效）', cookieB === '', `B="${cookieB}"`);
  const title = await evalIn(cdp, a.sessionId, 'document.title');
  check('页面真实渲染', title === 'iso', `title="${title}"`);
  cdp.close();
} catch (e) {
  check('隔离上下文测试', false, e.message);
}

// ── 5. 崩溃自动重启 ───────────────────────────────────────────────────────
const stateFile = statePath;
const before = JSON.parse(readFileSync(stateFile, 'utf8'));
process.kill(before.browserPid, 'SIGKILL');
let after = null;
for (let i = 0; i < 60; i += 1) {
  await sleep(500);
  const v = await probe(port, 2000, token);
  const st = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null;
  if (v && st && st.browserPid && st.browserPid !== before.browserPid) {
    after = st;
    break;
  }
}
check('浏览器被杀后自动重启', Boolean(after), after ? `browserPid ${before.browserPid} → ${after.browserPid}` : '未在 30s 内恢复');
if (after) check('重启后代理仍可用（自动改指向）', Boolean(await probe(port, 2000, token)), `内部端口 ${after.internalPort}`);

// ── 6. 空闲自杀 ───────────────────────────────────────────────────────────
for (let i = 0; i < 80 && child.exitCode === null; i += 1) await sleep(250);
const gone = child.exitCode !== null;
check('空闲后自动退出', gone, `exitCode=${child.exitCode}`);
check('退出后清理状态文件', !existsSync(stateFile));
check('退出后端口释放', (await probe(port, 800, token)) === null);

// ── 7. CLI 防御性行为（配置校验 / 启动失败不留孤儿 / logs 参数 / stop 身份校验） ──
const runCli = (args, timeoutMs = 30_000) =>
  new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => {
      stdout += d;
    });
    p.stderr.on('data', (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      try {
        p.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }, timeoutMs);
    timer.unref?.();
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

const badPort = await runCli(['status', '--port=99999']);
check('越界 --port 被配置校验拒绝 (exit 2)', badPort.code === 2 && /无效的 port/.test(badPort.stdout), `code=${badPort.code} out=${badPort.stdout.trim().slice(0, 120)}`);

// F26：--internal-port-base 必须真的生效（原先只读 config.json 的同名键，CLI 传了被静默忽略，
// 于是 USAGE 里宣传的参数其实无效）。这里用一个不常见的基址，断言内核确实从它开始选端口。
const rootIntBase = mkdtempSync(join(tmpdir(), 'dshsvc-intbase-'));
extraRoots.push(rootIntBase);
const intBase = 19700;
await runCli(['start', `--root=${rootIntBase}`, '--port=0', '--internal-port-base=' + intBase, '--idle-ms=120000'], 60_000);
const intBaseOut = await runCli(['status', `--root=${rootIntBase}`]);
let intBaseInfo = {};
try {
  intBaseInfo = JSON.parse(intBaseOut.stdout);
} catch {
  /* 保持空 */
}
check('--internal-port-base 覆盖默认 9300', intBaseInfo.internalPort === intBase, `internalPort=${intBaseInfo.internalPort} 期望=${intBase}`);
await runCli(['stop', `--root=${rootIntBase}`], 60_000);

const badLines = await runCli(['logs', `--root=${root}`, '--lines=0']);
check('--lines=0 被拒 (exit 2)', badLines.code === 2 && /invalid --lines/.test(badLines.stdout), `code=${badLines.code}`);

rootMissing = mkdtempSync(join(tmpdir(), 'browsersvc-verify-missing-'));
extraRoots.push(rootMissing);
const missing = await runCli(['run', `--root=${rootMissing}`, '--port=0', '--kernel=/nonexistent/chrome', '--idle-ms=3000']);
check('内核不存在时启动失败且不留状态文件', missing.code !== 0 && !existsSync(join(rootMissing, 'service.json')) && /不存在/.test(missing.stdout + missing.stderr), `code=${missing.code} out=${(missing.stdout + missing.stderr).trim().slice(0, 140)}`);

// 内核起来了但 CDP 永远不就绪：必须杀内核 + 干净退出，不能留下没有状态文件的孤儿（F2）。
rootStuck = mkdtempSync(join(tmpdir(), 'browsersvc-verify-stuck-'));
extraRoots.push(rootStuck);
const fakeKernel = join(rootStuck, 'fake-kernel.mjs');
const fakePidFile = join(rootStuck, 'kernel.pid');
// 必须有 shebang：守护进程是按可执行文件直接 execve 的（不经过 shell）。
writeFileSync(fakeKernel, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(fakePidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
// 先不给她可执行位：内核可执行性校验必须拒绝，且不留状态文件（F4）。
const notExec = await runCli(['run', `--root=${rootStuck}`, '--port=0', `--kernel=${fakeKernel}`, '--start-timeout=1500', '--idle-ms=3000']);
check('内核不可执行时启动失败且不留状态文件', notExec.code !== 0 && !existsSync(join(rootStuck, 'service.json')) && /不可执行/.test(notExec.stdout + notExec.stderr), `code=${notExec.code} out=${(notExec.stdout + notExec.stderr).trim().slice(0, 140)}`);
chmodSync(fakeKernel, 0o755);

const stuck = await runCli(['run', `--root=${rootStuck}`, '--port=0', `--kernel=${fakeKernel}`, '--start-timeout=1500', '--idle-ms=3000']);
const kernelPid = existsSync(fakePidFile) ? Number(readFileSync(fakePidFile, 'utf8')) : null;
let kernelAlive = false;
if (kernelPid) {
  try {
    process.kill(kernelPid, 0);
    kernelAlive = true;
  } catch {
    kernelAlive = false;
  }
}
check('内核未就绪时启动失败（不静默成功）', stuck.code !== 0 && /未就绪/.test(stuck.stdout + stuck.stderr), `code=${stuck.code} out=${(stuck.stdout + stuck.stderr).trim().slice(0, 140)}`);
check('启动失败后不留孤儿内核', kernelPid !== null && !kernelAlive, `kernelPid=${kernelPid} alive=${kernelAlive}`);
check('启动失败后不留状态文件', !existsSync(join(rootStuck, 'service.json')));

// stop 身份校验（F3）：状态文件里的 pid 不是 browsersvc/内核时必须拒绝动手。
if (process.platform === 'linux') {
  rootStop = mkdtempSync(join(tmpdir(), 'browsersvc-verify-stop-'));
  extraRoots.push(rootStop);
  const dummy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(join(rootStop, 'service.json'), JSON.stringify({ supervisorPid: dummy.pid, browserPid: dummy.pid, port: 1, internalPort: 9300, listening: true, token: 'x' }));
  const refused = await runCli(['stop', `--root=${rootStop}`]);
  let dummyAlive = false;
  try {
    process.kill(dummy.pid, 0);
    dummyAlive = true;
  } catch {
    dummyAlive = false;
  }
  check('stop 身份校验：拒绝杀不匹配的进程', refused.code === 1 && /身份校验未通过/.test(refused.stdout) && dummyAlive, `code=${refused.code} alive=${dummyAlive}`);
  const forced = await runCli(['stop', `--root=${rootStop}`, '--force']);
  check('stop --force 可强制清理', forced.code === 0 && /"stopped": true/.test(forced.stdout), `code=${forced.code}`);
  try {
    dummy.kill('SIGKILL');
  } catch {
    /* 已被 --force 收掉 */
  }
} else {
  check('stop 身份校验（仅 linux 有 /proc）', true, `platform=${process.platform}`);
}

// F23：print() 会 process.exit，restart 曾因此在 stop 之后直接退出 —— 表现为「只停不起」，
// 实例被停掉却报 stopped:true 就结束了。这里用隔离 root 真实跑一遍 start → restart → stop。
const rootRestart = mkdtempSync(join(tmpdir(), 'browsersvc-verify-restart-'));
extraRoots.push(rootRestart);
const startedFirst = await runCli(['start', `--root=${rootRestart}`, '--port=0', '--idle-ms=120000'], 60_000);
check('restart 前置：隔离实例可启动', startedFirst.code === 0, `code=${startedFirst.code} ${startedFirst.stdout.slice(0, 120)}`);
const tokenBeforeRestart = JSON.parse(readFileSync(join(rootRestart, 'service.json'), 'utf8')).token;
const restartedCli = await runCli(['restart', `--root=${rootRestart}`, '--port=0', '--idle-ms=120000'], 60_000);
let restartedOut = {};
try {
  restartedOut = JSON.parse(restartedCli.stdout);
} catch {
  restartedOut = {};
}
const tokenAfterRestart = existsSync(join(rootRestart, 'service.json')) ? JSON.parse(readFileSync(join(rootRestart, 'service.json'), 'utf8')).token : null;
check('restart 真的停旧起新（F23）', restartedCli.code === 0 && restartedOut.restarted === true && restartedOut.stopped === true && restartedOut.started === true, `code=${restartedCli.code} ${restartedCli.stdout.slice(0, 160)}`);
check('restart 后 token 换新', typeof tokenAfterRestart === 'string' && tokenAfterRestart !== tokenBeforeRestart, `${String(tokenBeforeRestart).slice(0, 8)} → ${String(tokenAfterRestart).slice(0, 8)}`);
const stoppedRestart = await runCli(['stop', `--root=${rootRestart}`], 60_000);
check('restart 后的实例可正常 stop', stoppedRestart.code === 0, `code=${stoppedRestart.code}`);

// ── 汇总 ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
await new Promise((r) => originServer.close(r));
rmSync(root, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
