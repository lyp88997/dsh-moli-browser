// 判定 CJK 是否真的渲染出字形：等长不同汉字的截图若完全一致 ⇒ 全是豆腐块（缺字体）
import { createRequire } from 'node:module';
const require = createRequire('/home/node/.dsh/profiles/web/node_modules/');
const puppeteer = require('puppeteer-core');
const crypto = await import('node:crypto');

const browser = await puppeteer.launch({
  executablePath: '/home/node/DSH/.browser/chromium-wrapper.sh',
  headless: true,
});
const page = await browser.newPage();
await page.setViewport({ width: 420, height: 140 });

const CJK = ['中文测试', '测试中文', '永和九年']; // 纯汉字、等长：若字形真的渲染，三者截图必须互不相同
const shots = {};
for (const s of [...CJK, 'ABCD测试']) {
  const html = `<body style="margin:0;background:#fff;font:28px sans-serif"><div>${s}</div></body>`;
  await page.goto('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 150));
  shots[s] = crypto.createHash('sha256').update(await page.screenshot()).digest('hex').slice(0, 16);
}
console.log(JSON.stringify(shots, null, 1));
const uniq = new Set(Object.values(shots));
console.log('唯一指纹数=' + uniq.size + ' / ' + Object.keys(shots).length);
const cjkUniq = new Set(CJK.map((s) => shots[s])).size;
console.log(cjkUniq === 1
  ? '⇒ 纯汉字截图完全相同：汉字未渲染（缺 CJK 字体，豆腐块）'
  : '⇒ 纯汉字截图互不相同：汉字字形确实渲染了');
await browser.close();
