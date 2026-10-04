// 立即可用的浏览助手（无需改 DSH 配置、无需重启 dsh）
// 复用已装好的用户态 Chromium（.browser/chromium-wrapper.sh）与 DSH 自带 puppeteer-core。
//
//   node browse.mjs text  <url>            打印页面可见文本
//   node browse.mjs html  <url>            打印渲染后的 HTML
//   node browse.mjs shot  <url> <out.png>  截图到文件
//   node browse.mjs eval  <url> <js>       在页面执行表达式并打印结果
//
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire('/home/node/.dsh/profiles/web/node_modules/');
const puppeteer = require('puppeteer-core');

const [, , cmd, url, arg] = process.argv;
if (!cmd || !url) {
  console.error('用法: node browse.mjs <text|html|shot|eval> <url> [arg]');
  process.exit(2);
}

const browser = await puppeteer.launch({
  executablePath: '/home/node/DSH/.browser/chromium-wrapper.sh',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  if (cmd === 'text') console.log(await page.evaluate(() => document.body?.innerText ?? ''));
  else if (cmd === 'html') console.log(await page.content());
  else if (cmd === 'shot') {
    writeFileSync(arg, await page.screenshot({ fullPage: true }));
    console.log('已写入 ' + arg);
  } else if (cmd === 'eval') console.log(JSON.stringify(await page.evaluate(arg)));
  else {
    console.error('未知子命令: ' + cmd);
    process.exitCode = 2;
  }
} finally {
  await browser.close();
}
