/**
 * 回环 TCP 代理：对外暴露 CDP 端口，转发到浏览器实际监听的内部端口。
 *
 * 为什么不让浏览器直接对外监听：
 *  1) 本机是 host 网络，任何对外端口都等于把"完全操控浏览器（含读 cookie）"开放给主机上任意进程；
 *     代理只绑 127.0.0.1，并强制 `Authorization: Bearer <token>`（token 每次启动随机生成，
 *     存在 0600 的状态文件里），同时只放行读元数据与 /devtools 通道，挡掉 /json/new|close|activate
 *     这类控制接口。
 *  2) 代理知道"当前有没有客户端连着" ⇒ 精确的空闲回收，不需要猜 CDP 活动。
 *  3) 元数据响应里的 webSocketDebuggerUrl 会被改写成代理自己的地址（并带上 token），
 *     否则代理等于把内部端口告诉了调用方，真实会话会绕开代理（凭据门与连接计数同时失真）。
 */
import net from 'node:net';

const META = new Set(['/json/version', '/json/list']);

export function createProxy({ listenPort, targetPort, host = '127.0.0.1', token, log = () => {}, onConnect = () => {} }) {
  if (!token) throw new Error('createProxy 需要 token（公开端口不允许无凭据开放）');
  const sockets = new Set();
  let connections = 0;
  let target = targetPort;

  const server = net.createServer((client) => {
    sockets.add(client);
    let upstream = null;
    let counted = false;
    let settled = false;
    let graceTimer = null;
    let headTimer = null;

    const release = () => {
      if (!counted) return;
      counted = false;
      connections = Math.max(0, connections - 1);
    };
    const destroyBoth = () => {
      if (upstream && !upstream.destroyed) upstream.destroy();
      if (!client.destroyed) client.destroy();
    };
    // 任一侧 close/error 时调用，幂等：立刻正确减计数，并在 5s 后强拆仍未结束的半开连接。
    const settle = () => {
      if (settled) return;
      settled = true;
      release();
      if (headTimer) clearTimeout(headTimer);
      graceTimer = setTimeout(destroyBoth, 5000);
      graceTimer.unref?.();
    };
    const abort = () => {
      settle();
      destroyBoth();
    };
    const reject = (code, message) => {
      const reason = { 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 408: 'Request Timeout', 431: 'Request Header Fields Too Large' }[code] ?? 'Error';
      const body = `${message}\n`;
      log(`proxy: ${code} ${message}`);
      client.end(`HTTP/1.1 ${code} ${reason}\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      settle();
    };

    const publicPort = () => {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : listenPort;
    };
    /** 把头部里的 connection 改写成 close。代理每条连接只解析首个请求头，之后是裸管道，
     *  若允许 keep-alive，同一连接上的第二个请求就会绕过凭据门与白名单（F27）。 */
    const withConnectionClose = (head) =>
      /(^|\r\n)connection:[^\r\n]*/i.test(head) ? head.replace(/(^|\r\n)connection:[^\r\n]*/i, '$1connection: close') : `${head}\r\nconnection: close`;
    /** 同一个改写的 Buffer 版本：只动头部，body 原样保留。 */
    const pinClose = (buf) => {
      const split = buf.indexOf('\r\n\r\n');
      if (split === -1) return buf;
      return Buffer.concat([Buffer.from(withConnectionClose(buf.subarray(0, split).toString('latin1')), 'latin1'), buf.subarray(split)]);
    };

    /** 把元数据 JSON 里的 WebSocket 地址改成走代理，并附上 token。 */
    const rewriteMeta = (body) =>
      Buffer.from(
        body
          .toString('utf8')
          .replace(/"webSocketDebuggerUrl"\s*:\s*"ws:\/\/[^/"]+(\/[^"]*)"/g, (m, path) => {
            const sep = path.includes('?') ? '&' : '?';
            return `"webSocketDebuggerUrl":"ws://${host}:${publicPort()}${path}${sep}token=${token}"`;
          }),
        'utf8',
      );

    const forward = (first) => {
      upstream = net.connect({ host, port: target });
      sockets.add(upstream);
      counted = true;
      connections += 1;
      onConnect();
      upstream.on('error', abort);
      upstream.on('close', () => {
        if (!client.destroyed) client.end();
        settle();
      });
      client.on('close', () => {
        if (upstream && !upstream.destroyed) upstream.end();
        settle();
      });
      return upstream;
    };

    const handle = (method, rawPath, headers, first, wantsMeta) => {
      let url;
      try {
        url = new URL(rawPath, `http://${host}`);
      } catch {
        return reject(400, 'bad request path');
      }
      const authed = headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
      if (!authed) return reject(401, `missing or invalid token for ${method} ${url.pathname}`);
      const path = url.pathname.replace(/\/$/, '') || '/';
      const allowed = path.startsWith('/devtools/') || ((method === 'GET' || method === 'HEAD') && (META.has(path) || path === '/json/protocol'));
      if (!allowed) return reject(403, `path not allowed: ${url.pathname}`);

      // WebSocket 升级请求必须保持长连接；其余请求一律 pin 成 close，避免同一条连接上的
      // 后续请求跳过凭据门与白名单（F27）。
      const isUpgrade = typeof headers.upgrade === 'string' && headers.upgrade.length > 0;
      const upFirst = isUpgrade ? first : pinClose(first);
      const up = forward(upFirst);
      if (isUpgrade) {
        // WebSocket 升级：必须双向 pipe（长连接）。
        client.unshift(upFirst);
        client.pipe(up);
        up.pipe(client);
        return;
      }
      if (!wantsMeta) {
        // 普通 HTTP（非升级）：只单向转发，绝不把客户端接回上游 —— 代理只检查过首个请求头，
        // 再接回去就等于同一条连接上的后续请求全部免检（F27）。非升级请求都是一次性的，
        // 上游空闲 2s 就收尾，免得连接悬挂（连接计数会挡住空闲自杀）。
        const finish = () => {
          if (!client.destroyed) client.end();
          settle();
        };
        let idle = setTimeout(finish, 2000);
        idle.unref?.();
        up.on('data', () => {
          clearTimeout(idle);
          idle = setTimeout(finish, 2000);
        });
        up.on('close', () => clearTimeout(idle));
        up.write(upFirst);
        up.pipe(client);
        return;
      }

      // 元数据响应：先把请求投给上游（这条分支不走 pipe，必须显式写），
      // 等 body 到齐后改写 webSocketDebuggerUrl 再回给客户端。
      let resp = Buffer.alloc(0);
      const onResp = (chunk) => {
        resp = Buffer.concat([resp, chunk]);
        const split = resp.indexOf('\r\n\r\n');
        if (split === -1) {
          if (resp.length > 64 * 1024) up.destroy();
          return;
        }
        const headText = resp.subarray(0, split).toString('latin1');
        const status = Number(headText.split('\r\n')[0].split(' ')[1] ?? 0);
        const len = Number(/content-length:\s*(\d+)/i.exec(headText)?.[1] ?? NaN);
        if (!Number.isInteger(len)) return; // 拿不到长度就继续攒（正常 chrome 一定带 content-length）
        const body = resp.subarray(split + 4);
        if (body.length < len) return;
        up.off('data', onResp);
        up.pause();
        const head = withConnectionClose(status === 200 ? headText.replace(/content-length:\s*\d+/i, `content-length: ${rewriteMeta(body.subarray(0, len)).length}`) : headText);
        const payload = status === 200 ? rewriteMeta(body.subarray(0, len)) : body.subarray(0, len);
        client.write(`${head}\r\n\r\n`);
        client.write(payload);
        const rest = body.subarray(len);
        if (rest.length) client.write(rest);
        // 这条连接不能交还给 keep-alive：代理只解析过一个请求头，之后是裸管道（F27）。
        client.end();
      };
      up.write(upFirst);
      up.on('data', onResp);
    };

    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const split = buffered.indexOf('\r\n\r\n');
      if (split === -1) {
        if (buffered.length > 16 * 1024) {
          client.off('data', onData);
          reject(431, 'request headers too large');
        }
        return;
      }
      client.off('data', onData);
      // 头收全就必须撤掉 10s 的头超时定时器：否则它会在请求成功 10s 后触发 408，
      // 把已经建立的连接（含 CDP WebSocket 长连接）一起拆掉（F20）。
      if (headTimer) {
        clearTimeout(headTimer);
        headTimer = null;
      }
      const lines = buffered.subarray(0, split).toString('latin1').split('\r\n');
      const [method, rawPath] = (lines[0] ?? '').split(' ');
      const headers = {};
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      if (!method || !rawPath) return reject(400, 'bad request line');
      let pathname = '/';
      try {
        pathname = new URL(rawPath, `http://${host}`).pathname.replace(/\/$/, '') || '/';
      } catch {
        /* 交给 handle 统一拒绝 */
      }
      handle(method, rawPath, headers, buffered, method === 'GET' && META.has(pathname));
    };

    headTimer = setTimeout(() => {
      client.off('data', onData);
      reject(408, 'request headers timeout');
    }, 10_000);
    headTimer.unref?.();
    client.on('data', onData);
    client.on('error', abort);
  });

  server.on('error', (err) => log(`proxy error: ${err.message}`));

  return {
    get connections() {
      return connections;
    },
    get targetPort() {
      return target;
    },
    /** 浏览器重启后会换端口，代理必须跟着改指向。 */
    setTarget(port) {
      target = port;
    },
    get listening() {
      return server.listening;
    },
    get port() {
      const addr = server.address();
      return addr && typeof addr === 'object' ? addr.port : listenPort;
    },
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, host, () => {
          server.off('error', reject);
          resolve(this.port);
        });
      });
    },
    close() {
      for (const s of sockets) s.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
