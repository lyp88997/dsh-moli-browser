/**
 * seam 探针（诊断/冒烟用，不属于交付特性）。
 *
 * 在一个真实 DSH 进程里通过 `ctx.browser` seam 跑一遍完整浏览器流程，
 * 结果追加到 /tmp/m2-seam-probe.log。用来验证「seam → dsh-moli-browser
 * （provider id = cdp-daemon）→ 自动拉起 browsersvc → daemon CDP」这条链路在 DSH 里真的通。
 */
import { appendFileSync } from 'node:fs';

export const name = 'm2-seam-probe';
export const inject = ['browser'];

const TARGET_URL = process.env.M2_PROBE_URL || 'http://127.0.0.1:9413/';

function log(line) {
  appendFileSync('/tmp/m2-seam-probe.log', `${new Date().toISOString()} pid=${process.pid} ${line}\n`);
}

/** provider 由另一个插件条目注册，apply 顺序不保证 ⇒ 等到 seam 能解析出 provider。 */
async function waitForProvider(ctx, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await ctx.browser.open('m2-seam-probe');
    } catch (error) {
      if (error?.code !== 'BROWSER_PROVIDER_CONFIGURED_MISSING' && error?.code !== 'BROWSER_PROVIDER_UNAVAILABLE') throw error;
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

export async function apply(ctx) {
  try {
    log('apply entered');
    const session = await waitForProvider(ctx);
    log(`open -> ${JSON.stringify(session)}`);
    await ctx.browser.openUrl(session, { url: TARGET_URL });
    const snapshot = await ctx.browser.snapshot(session);
    log(
      `snapshot -> url=${snapshot.url} title=${JSON.stringify(snapshot.title)} elements=${snapshot.elements?.length} first=${JSON.stringify(snapshot.elements?.[0])}`,
    );
    const content = await ctx.browser.content(session, { format: 'txt' });
    log(`content -> ${JSON.stringify(String(content.content).slice(0, 90))}`);
    const executed = await ctx.browser.execute(session, { script: 'document.querySelector("h1").textContent' });
    log(`execute -> ${JSON.stringify(executed)}`);
    const a11y = await ctx.browser.a11y(session, { maxNodes: 20 });
    log(`a11y -> count=${a11y.count} nodes=${a11y.nodes?.length}`);
    const tabs = await ctx.browser.listTabs(session);
    log(`listTabs -> ${JSON.stringify(tabs)}`);
    await ctx.browser.close(session);
    log('closed -> DONE');
    // M2_PROBE_HOLD=1 时保持进程存活，便于在外部改动 patch 观察热重载行为。
    if (process.env.M2_PROBE_HOLD) setInterval(() => {}, 60000);
  } catch (error) {
    log(`FAILED -> code=${error?.code} name=${error?.name} message=${error?.message}`);
  }
}
