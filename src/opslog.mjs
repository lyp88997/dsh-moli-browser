/**
 * 观测日志（JSONL 追加，按类型分文件）。
 *
 * 设计约束：
 *  - **写入永不抛错**：观测不能把浏览器调用搞挂，任何 IO 失败都吞掉并返回 false。
 *  - **体积有界**：超过上限就把文件保留尾部一半（JSONL 半行只可能出现在崩溃时，读的时候跳过）。
 *  - **权限 0600**：console/network 里可能有 cookie、Authorization 头等敏感内容。
 *
 * 三种日志：ops（provider 每次操作）、console（页面 console 流）、network（请求/响应）。
 * 由插件侧写入，`browsersvc` CLI 与宿主侧只读路由读回。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRoot } from './config.mjs';

export const LOG_KINDS = {
  ops: { file: 'ops.jsonl', maxBytes: 1 << 20 },
  console: { file: 'console.jsonl', maxBytes: 1 << 20 },
  network: { file: 'network.jsonl', maxBytes: 2 << 20 },
};

export function logFileFor(root, kind) {
  const spec = LOG_KINDS[kind];
  if (!spec) throw new Error(`未知的观测日志类型：${kind}`);
  return join(root, spec.file);
}

/** 超过上限就保留尾部一半行（一次性重写，代价可接受：文件本来就 ≤ 上限的下一倍）。 */
function trim(file, maxBytes) {
  if (!existsSync(file) || statSync(file).size <= maxBytes) return;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = lines.slice(-Math.max(1, Math.floor(lines.length / 2)));
  writeFileSync(file, `${keep.join('\n')}\n`, { mode: 0o600 });
}

/** 追加一条记录；返回是否写入成功（失败一律静默）。 */
export function appendEntry(kind, entry, { root = defaultRoot(), maxBytes } = {}) {
  try {
    const limit = maxBytes ?? LOG_KINDS[kind]?.maxBytes ?? 1 << 20;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const file = logFileFor(root, kind);
    trim(file, limit);
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** 读回最近 lines 条（按写入顺序，旧的在前）。 */
export function readEntries(kind, { root = defaultRoot(), lines = 50 } = {}) {
  const file = logFileFor(root, kind);
  if (!existsSync(file)) return { file, total: 0, entries: [] };
  const all = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const keep = Math.max(1, Math.floor(lines));
  const entries = [];
  for (const line of all.slice(-keep)) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      /* 崩溃截断的半行：跳过 */
    }
  }
  return { file, total: all.length, entries };
}

/**
 * 清理日志：保留尾部 keep 条（keep = 0 即清空）。
 *
 * 与写入路径的「永不抛错」相反：这是用户点「清理」或自动清理触发的交互操作，
 * IO 失败要如实报错让面板能提示，不能假装成功。返回保留的条数。
 */
export function clearEntries(kind, { root = defaultRoot(), keep = 0 } = {}) {
  const file = logFileFor(root, kind);
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const size = Math.max(0, Math.floor(Number(keep)) || 0);
  const tail = size > 0 ? lines.slice(-size) : [];
  writeFileSync(file, tail.length ? `${tail.join('\n')}\n` : '', { mode: 0o600 });
  return tail.length;
}

export const appendOp = (entry, options) => appendEntry('ops', entry, options);
export const appendConsole = (entry, options) => appendEntry('console', entry, options);
export const appendNetwork = (entry, options) => appendEntry('network', entry, options);
export const readOps = (options) => readEntries('ops', options);
export const readConsole = (options) => readEntries('console', options);
export const readNetwork = (options) => readEntries('network', options);

/** 截断长文本用于落盘（console 文本、URL、错误原因等）。 */
export function clip(value, max = 300) {
  if (typeof value !== 'string') return value;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 参数/结果这类可能含大对象的字段：序列化成一段被截断的文本（读方当字符串展示）。 */
export function clipJson(value, max = 300) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = '"<不可序列化>"';
  }
  if (text === undefined) text = 'null';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
