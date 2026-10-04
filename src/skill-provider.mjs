/**
 * skill-provider.mjs —— 把随包的两份技能注册成 DSH 的**内置技能提供者**（和 dsh-univer-office 同一种形态）。
 *
 * 为什么不能只落盘：DSH 的技能有两个来源层，显示身份完全不同。
 *   ① 磁盘根目录（dsh-skill-filesystem）：项目 `.dsh/skills` rank 100、`.agents/skills` 200、
 *      customSkillDirs 300、`$DSH_HOME/skills` 400（source `user-dsh`）、`~/.agents/skills` 500、
 *      宿主自带 bundled 目录 600 —— 我们在 400，技能中心里就是「用户级技能」。
 *   ② 插件侧提供者：`ctx.skills.registerProvider()`，`source` / `rank` 由提供者自己给。
 *      dsh-univer-office 给的是 `source:'bundled'` + `rank:600`（dsh-skill 导出的 BUNDLED_SKILL_RANK），
 *      技能中心据此显示成「系统内置」。
 *   ③ 同一层里 rank **小的先赢**（dsh-skill/lib/index.js 的 compareIndexedCandidates + collectLayer 的
 *      seen 去重，重名后者被丢弃并打一行 warn）⇒ 同一个技能名既落盘（400）又注册内置（600）时，
 *      磁盘那份会盖住内置那份。所以「显示成系统内置」与「把文件拷进 $DSH_HOME/skills」不能同时成立，
 *      默认只走提供者（要文件给 DSH 以外的工具读，用 `browsersvc skills --install`，见 README）。
 *
 * 技能正文与 frontmatter 就是 `skills/<name>/SKILL.md`，读的时候现读，改文件不用重启插件。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SKILLS_SOURCE } from './skills.mjs';

/** 技能提供者名（必须全局唯一，`dsh-skill` 用它做重名检查）。 */
export const PROVIDER_NAME = 'browser-service';
/** dsh-skill 的 BUNDLED_SKILL_RANK：内置/随包来源的标准等级。 */
export const BUNDLED_SKILL_RANK = 600;
/** 随包技能名（与 skills/ 下的目录名一致）。 */
export const SKILL_NAMES = ['browser', 'browser-runtime'];
/** 默认调用策略：模型可自动调用、用户可用 /<name> 调用。 */
const DEFAULT_INVOCATION = { modelInvocable: true, userInvocable: true };

/** 去掉开头的 YAML frontmatter，只留正文（内置技能正文不带 frontmatter，和 univer 一致）。 */
export function stripFrontmatter(text) {
  if (!text.startsWith('---\n')) return text;
  const end = text.indexOf('\n---\n', 4);
  return end === -1 ? text : text.slice(end + 5);
}

/**
 * 极简 frontmatter 读取：只认我们自己的 `key: value` 单行格式（技能文件由本包维护，不引入 YAML 依赖）。
 * @returns {{description:string, whenToUse:string|null, modelInvocable:boolean, userInvocable:boolean}}
 */
export function parseSkillFrontmatter(text) {
  const out = { description: '', whenToUse: null, modelInvocable: true, userInvocable: true };
  if (!text.startsWith('---\n')) return out;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return out;
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key === 'description') out.description = value;
    else if (key === 'whenToUse') out.whenToUse = value;
    else if (key === 'disable-model-invocation') out.modelInvocable = value !== 'true';
  }
  return out;
}

/** 读一个随包技能（读不到或没有描述时返回 null，并说明原因）。 */
export function readSkill(name, source = SKILLS_SOURCE) {
  const dir = join(source, name);
  const file = join(dir, 'SKILL.md');
  if (!existsSync(file)) return { skill: null, reason: `找不到 ${file}` };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { skill: null, reason: `读不到 ${file}（${error.message}）` };
  }
  const meta = parseSkillFrontmatter(text);
  if (meta.description.length === 0) return { skill: null, reason: `${file} 的 frontmatter 里没有 description` };
  return {
    skill: {
      name,
      description: meta.description,
      whenToUse: meta.whenToUse,
      invocation: { modelInvocable: meta.modelInvocable, userInvocable: meta.userInvocable },
      content: stripFrontmatter(text),
      path: file,
      dir,
    },
  };
}

/**
 * 造一个技能提供者（`ctx.skills.registerProvider(() => createSkillsProvider({log}))`）。
 * 契约见 dsh-skill/lib/index.js：`{name, list(), get(candidate)}`；candidate 必须有
 * name/description/invocation/source/rank/provider，`get()` 返回带 content 的完整定义。
 */
export function createSkillsProvider({ source = SKILLS_SOURCE, names = SKILL_NAMES, log } = {}) {
  const resolve = (name) => {
    const { skill, reason } = readSkill(name, source);
    if (skill === null) log?.warn?.(`browser-moli: 随包技能 "${name}" 不可用 —— ${reason}`);
    return skill;
  };
  const candidateOf = (skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse === null ? {} : { whenToUse: skill.whenToUse }),
    invocation: skill.invocation,
    provider: PROVIDER_NAME,
    source: 'bundled',
    rank: BUNDLED_SKILL_RANK,
    resourceBase: { kind: 'directory', path: `${skill.dir}/` },
    locator: skill.path,
  });
  return {
    name: PROVIDER_NAME,
    list() {
      const candidates = [];
      for (const name of names) {
        const skill = resolve(name);
        if (skill !== null) candidates.push(candidateOf(skill));
      }
      return Promise.resolve(candidates);
    },
    get(candidate) {
      const name = typeof candidate?.name === 'string' ? candidate.name : '';
      const skill = resolve(name);
      if (skill === null) throw new Error(`随包技能 "${name}" 读不到（${source}）`);
      return Promise.resolve({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === null ? {} : { whenToUse: skill.whenToUse }),
        invocation: skill.invocation,
        provider: PROVIDER_NAME,
        source: 'bundled',
        content: skill.content,
        path: skill.path,
        resourceBase: { kind: 'directory', path: `${skill.dir}/` },
      });
    },
  };
}

/** 仅供测试/文档：本包内置技能是否齐全。 */
export function inspectBundledSkills(source = SKILLS_SOURCE, names = SKILL_NAMES) {
  return names.map((name) => {
    const { skill, reason } = readSkill(name, source);
    return skill === null
      ? { name, ok: false, reason }
      : { name, ok: true, description: skill.description, invocation: skill.invocation, dir: skill.dir, bytes: skill.content.length };
  });
}

export { DEFAULT_INVOCATION };
