/**
 * 在一次性隔离 DSH_HOME 里补出「宿主 peer 目录」——真实部署里 boot 过就有。
 *
 * 机制：宿主 dsh 包根 = `command -v dsh` 的真身上溯两级；它的 `node_modules/@deepseek-ai`
 * 就是宿主提供给各 profile 的 peer（cordis / dsh-tools / schemastery …）。真实部署的
 * `$DSH_HOME/profiles/node_modules/@deepseek-ai` 是**实体目录**，除这些 peer 外还含一条 `dsh`
 * 自身（本包启动期探测读宿主版本用）；故这里逐个软链，再补一条 dsh —— 不能把整目录做成一条
 * 指向宿主目录的软链：那样往里补 dsh 会写进只读的宿主目录（EACCES）。
 *
 * 仅供验收脚本使用；产品代码不依赖它。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function linkHostPeers({ root, dshBin = 'dsh' }) {
  try {
    const dshAi = join(root, 'profiles', 'node_modules', '@deepseek-ai');
    const which = spawnSync('sh', ['-c', `command -v ${dshBin}`], { encoding: 'utf8' }).stdout.trim();
    if (!which) throw new Error(`找不到 ${dshBin}`);
    const pkgRoot = dirname(dirname(realpathSync(which))); // …/node_modules/@deepseek-ai/dsh
    // 两种装法的 peer 落点不同：全局装（宿主真实布局）在包内 `<pkgRoot>/node_modules/@deepseek-ai`；
    // `npm install --prefix` 装的（多版本矩阵用）被 npm 提升到 `<prefix>/node_modules/@deepseek-ai`。
    const hostAi = [join(pkgRoot, 'node_modules', '@deepseek-ai'), dirname(pkgRoot)]
      .find((dir) => existsSync(join(dir, 'cordis')) || existsSync(join(dir, 'schemastery')));
    if (!hostAi) throw new Error(`找不到宿主 peer 目录（试过 ${pkgRoot}/node_modules 与 ${dirname(pkgRoot)}）`);
    if (!existsSync(dshAi)) {
      mkdirSync(dshAi, { recursive: true });
      for (const entry of readdirSync(hostAi)) {
        if (entry !== 'dsh') symlinkSync(join(hostAi, entry), join(dshAi, entry));
      }
    }
    if (!existsSync(join(dshAi, 'dsh'))) symlinkSync(pkgRoot, join(dshAi, 'dsh'));
    return { ok: true, pkgRoot, hostAi };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
