/**
 * 注入页面执行的纯函数集合。
 * 约束：这些函数会被 Playwright 序列化后送进页面，因此**不能引用任何外部作用域**
 * （模块级常量、其它函数都不存在），只能使用浏览器内建 API（每个函数最多接收一个参数）。
 */

/** 可见性（含祖先 display:none / visibility:hidden）。 */
export function collectSnapshot({ maxElements }) {
  const KIND_BY_TAG = {
    a: 'link',
    button: 'button',
    input: 'input',
    textarea: 'textarea',
    select: 'select',
    option: 'other',
    summary: 'other',
  };
  const INTERACTIVE = 'a[href],button,input,textarea,select,summary,[role],[contenteditable="true"],label';
  const isVisible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    return true;
  };
  const cssPath = (el) => {
    if (el.id) return `#${window.CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.classList.length > 0) part += `.${window.CSS.escape(node.classList[0])}`;
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const kindOf = (el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      return 'input';
    }
    if (el.getAttribute('role') === 'button') return 'button';
    if (el.getAttribute('role') === 'link') return 'link';
    if (el.getAttribute('role') === 'textbox') return 'input';
    return KIND_BY_TAG[tag] ?? 'other';
  };
  const labelOf = (el) => {
    const attr = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title');
    if (attr) return attr.trim();
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const type = (el.getAttribute('type') ?? '').toLowerCase();
      if (type !== 'password' && typeof el.value === 'string' && el.value.length > 0) return el.value.trim();
    }
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    return text;
  };
  const out = [];
  const nodes = document.querySelectorAll(INTERACTIVE);
  let truncated = false;
  for (const el of nodes) {
    if (out.length >= maxElements) {
      truncated = true;
      break;
    }
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    out.push({
      ref: out.length + 1,
      kind: kindOf(el),
      label: labelOf(el).slice(0, 120),
      selector: cssPath(el),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      frame: el.ownerDocument !== document ? true : undefined,
    });
  }
  return { elements: out, truncated, url: location.href, title: document.title };
}

/** 无障碍树（DOM 推断：role/name/value/states + 坐标，best-effort）。 */
export function collectA11y({ maxNodes, includeHidden }) {
  const implicitRole = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'label') return 'label';
    if (tag === 'summary') return 'button';
    return 'generic';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target?.textContent) return target.textContent.replace(/\s+/g, ' ').trim();
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    if (el.id) {
      const label = document.querySelector(`label[for="${window.CSS.escape(el.id)}"]`);
      if (label?.textContent) return label.textContent.replace(/\s+/g, ' ').trim();
    }
    const text = (el.getAttribute('alt') || el.textContent || '').replace(/\s+/g, ' ').trim();
    return text;
  };
  const statesOf = (el) => {
    const states = [];
    const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
    states.push(disabled ? 'disabled' : 'enabled');
    // checked/selected 必须看 IDL 属性：JS 勾选不会写回 checked/selected 特性
    const ariaChecked = el.getAttribute('aria-checked');
    const propChecked = el.type === 'checkbox' || el.type === 'radio' ? el.checked : null;
    if (propChecked === true || ariaChecked === 'true' || el.hasAttribute('checked')) states.push('checked');
    else if (propChecked === false || ariaChecked === 'false') states.push('unchecked');
    if (el.getAttribute('aria-selected') === 'true') states.push('selected');
    if (el.getAttribute('aria-expanded')) states.push(el.getAttribute('aria-expanded') === 'true' ? 'expanded' : 'collapsed');
    if (el.getAttribute('aria-hidden') === 'true') states.push('hidden');
    return states;
  };
  const depthOf = (el) => {
    let depth = 0;
    let node = el.parentElement;
    while (node) {
      depth += 1;
      node = node.parentElement;
    }
    return depth;
  };
  const nodes = [];
  const all = document.querySelectorAll('a,button,input,select,textarea,img,h1,h2,h3,h4,h5,h6,[role],[aria-label],[contenteditable="true"]');
  let truncated = false;
  for (const el of all) {
    if (nodes.length >= maxNodes) {
      truncated = true;
      break;
    }
    const style = window.getComputedStyle(el);
    const hidden = style.display === 'none' || style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true';
    if (hidden && !includeHidden) continue;
    const rect = el.getBoundingClientRect();
    const isFormControl = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    nodes.push({
      ref: nodes.length + 1,
      role: implicitRole(el),
      name: nameOf(el).slice(0, 120),
      value: isFormControl && typeof el.value === 'string' && el.value.length > 0 ? el.value : null,
      states: statesOf(el),
      depth: depthOf(el),
      tag: el.tagName.toLowerCase(),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      frame: el.ownerDocument !== document ? true : undefined,
    });
  }
  return { nodes, truncated, url: location.href, title: document.title };
}

/** 机器人校验（CAPTCHA / 拦截页）标记检测。 */
export function detectChallengeMarkers() {
  const text = `${document.title} ${(document.body?.innerText ?? '').slice(0, 4000)}`.toLowerCase();
  const has = (selector) => document.querySelector(selector) !== null;
  if (has('iframe[src*="challenges.cloudflare.com"], #challenge-form, .cf-challenge') || text.includes('just a moment') || text.includes('attention required')) {
    return { blocked: true, kind: 'cloudflare', reason: 'Cloudflare 拦截页（"Just a moment"/challenge form）' };
  }
  if (has('iframe[src*="hcaptcha.com"], div.h-captcha, [data-hcaptcha-widget-id]')) {
    return { blocked: true, kind: 'hcaptcha', reason: 'hCaptcha 组件存在' };
  }
  if (has('iframe[src*="recaptcha"], div.g-recaptcha, [data-sitekey][class*="recaptcha"]')) {
    return { blocked: true, kind: 'recaptcha', reason: 'reCAPTCHA 组件存在' };
  }
  if (has('iframe[src*="challenges.cloudflare.com/turnstile"], div.cf-turnstile')) {
    return { blocked: true, kind: 'turnstile', reason: 'Cloudflare Turnstile 组件存在' };
  }
  if (text.includes('verify you are human') || text.includes('unusual traffic') || text.includes('请完成安全验证')) {
    return { blocked: true, kind: 'generic', reason: '页面文本命中人机校验特征' };
  }
  return { blocked: false };
}

/** 取内容：html / txt / json / markdown（无外部依赖的极简 HTML→MD）。 */
export function collectContent({ format, selector, maxChars }) {
  const scope = selector ? document.querySelector(selector) : document.body;
  if (!scope) return { content: '', truncated: false, missing: true };
  const html = scope.innerHTML ?? '';
  const text = scope.innerText ?? '';
  let content;
  if (format === 'html') {
    // 指定 selector 时给该元素的完整 HTML，否则给整页 body 的内部 HTML。
    content = selector ? scope.outerHTML : html;
  } else if (format === 'txt') {
    content = text;
  } else if (format === 'json') {
    const links = Array.from(scope.querySelectorAll('a[href]')).slice(0, 200).map((a) => ({ text: (a.textContent ?? '').trim(), href: a.href }));
    const headings = Array.from(scope.querySelectorAll('h1,h2,h3,h4,h5,h6')).slice(0, 200).map((h) => ({ level: Number(h.tagName[1]), text: (h.textContent ?? '').trim() }));
    content = JSON.stringify({ url: location.href, title: document.title, text, links, headings });
  } else {
    const clone = scope.cloneNode(true);
    for (const bad of clone.querySelectorAll('script,style,noscript,svg')) bad.remove();
    let md = clone.innerHTML;
    md = md.replace(/<\s*(h[1-6])[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, tag, inner) => `\n${'#'.repeat(Number(tag[1]))} ${inner.replace(/<[^>]+>/g, '').trim()}\n`);
    md = md.replace(/<\s*a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, (_m, href, inner) => `[${inner.replace(/<[^>]+>/g, '').trim()}](${href})`);
    md = md.replace(/<\s*(strong|b)[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi, (_m, _t, inner) => `**${inner.replace(/<[^>]+>/g, '').trim()}**`);
    md = md.replace(/<\s*li[^>]*>([\s\S]*?)<\s*\/\s*li\s*>/gi, (_m, inner) => `\n- ${inner.replace(/<[^>]+>/g, '').trim()}`);
    md = md.replace(/<\s*br\s*\/?\s*>/gi, '\n');
    md = md.replace(/<\s*\/\s*(p|div|tr|section|article|ul|ol|table)\s*>/gi, '\n');
    md = md.replace(/<[^>]+>/g, '');
    md = md.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    md = md.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    content = md;
  }
  // 截断不能把代理对劈开（F13）：切点落在高代理（0xD800-0xDBFF）上时往前退一位，
  // 否则返回的字符串尾是一个孤立代理项，JSON 序列化后是 U+FFFD 或直接报错。
  const limit = typeof maxChars === 'number' && Number.isFinite(maxChars) && maxChars >= 0 ? maxChars : content.length;
  let cut = Math.min(content.length, limit);
  if (cut > 0 && cut < content.length) {
    const code = content.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  }
  const truncated = cut < content.length;
  return { content: truncated ? content.slice(0, cut) : content, truncated };
}

/** 结构化抽取（静态 CSS，CSP 安全）。selector 支持 `sel@attr`，href/src 绝对化。 */
export function collectScrape({ item, fields }) {
  const nodes = document.querySelectorAll(item);
  const items = [];
  for (const node of nodes) {
    const row = {};
    for (const field of fields) {
      const at = field.selector.indexOf('@');
      const selector = at > 0 ? field.selector.slice(0, at) : field.selector;
      const attr = at > 0 ? field.selector.slice(at + 1) : null;
      let target = null;
      try {
        target = selector === '' ? node : node.querySelector(selector);
      } catch {
        target = null;
      }
      if (!target) {
        row[field.name] = null;
        continue;
      }
      if (attr) {
        const raw = target.getAttribute(attr);
        row[field.name] = raw === null ? null : attr === 'href' || attr === 'src' ? target[attr] ?? raw : raw;
      } else {
        row[field.name] = (target.textContent ?? '').replace(/\s+/g, ' ').trim();
      }
    }
    items.push(row);
  }
  return { count: items.length, items };
}

/** 元素当前值（input/textarea/select/checkbox/radio/contenteditable）。 */
export function readElementValue(el) {
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'select') {
    const option = el.selectedOptions?.[0] ?? null;
    return { value: el.value, selectedText: option ? (option.textContent ?? '').trim() : undefined };
  }
  if (tag === 'input' && (type === 'checkbox' || type === 'radio')) return { value: null, checked: el.checked };
  if (tag === 'input' || tag === 'textarea') return { value: el.value };
  return { value: el.isContentEditable ? (el.textContent ?? '') : null };
}

/** 批量表单填写：按 selector / name / label / placeholder 定位。 */
export function fillFields({ fields, submit }) {
  // 注意：页面内函数不能引用模块作用域的其它函数（序列化后不存在），这里内联一份写入逻辑。
  const writeValue = (el, value) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    const fire = () => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    if (tag === 'select') {
      const options = Array.from(el.options ?? []);
      const match = options.find((o) => o.value === String(value)) ?? options.find((o) => (o.textContent ?? '').trim() === String(value));
      if (!match) return { ok: false, method: 'select', error: `没有匹配的 option: ${String(value)}` };
      el.value = match.value;
      fire();
      return { ok: true, method: 'select', value: el.value };
    }
    if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
      const want = typeof value === 'boolean' ? value : String(value) !== 'false' && String(value) !== '0' && String(value) !== '';
      if (el.checked !== want) el.click();
      return { ok: true, method: type, value: String(el.checked) };
    }
    if (tag === 'input' || tag === 'textarea') {
      const proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, String(value));
      else el.value = String(value);
      fire();
      return { ok: true, method: tag, value: el.value };
    }
    if (el.isContentEditable) {
      el.textContent = String(value);
      fire();
      return { ok: true, method: 'contenteditable', value: el.textContent ?? '' };
    }
    return { ok: false, method: 'unknown', error: `不支持的元素: <${tag}>` };
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const locate = (field) => {
    const scope = field.selector ? document.querySelector(field.selector) : document;
    if (!scope) return null;
    if (field.name) {
      const el = scope.querySelector(`[name="${window.CSS.escape(field.name)}"]`);
      if (el) return el;
    }
    if (field.label) {
      const labels = Array.from(scope.querySelectorAll('label'));
      const hit = labels.find((l) => (l.textContent ?? '').trim().includes(field.label));
      if (hit) {
        if (hit.control) return hit.control;
        const forId = hit.getAttribute('for');
        if (forId) {
          const el = document.getElementById(forId);
          if (el) return el;
        }
        const inner = hit.querySelector('input,textarea,select');
        if (inner) return inner;
      }
      const byAria = scope.querySelector(`[aria-label*="${field.label}"]`);
      if (byAria) return byAria;
    }
    if (field.placeholder) {
      const el = scope.querySelector(`[placeholder*="${field.placeholder}"]`);
      if (el) return el;
    }
    return null;
  };
  const results = [];
  for (const field of fields) {
    const describe = field.selector ?? field.name ?? field.label ?? field.placeholder ?? '(未指定)';
    const el = locate(field);
    if (!el) {
      results.push({ ok: false, target: describe, error: '未找到匹配元素' });
      continue;
    }
    if (!visible(el)) {
      results.push({ ok: false, target: describe, error: '元素不可见' });
      continue;
    }
    const written = writeValue(el, field.value);
    results.push(written.ok ? { ok: true, target: describe, method: written.method } : { ok: false, target: describe, error: written.error });
  }
  let submitted = false;
  if (submit) {
    const first = results.find((r) => r.ok);
    if (first) {
      const el = locate(fields[results.indexOf(first)]);
      const form = el?.form ?? el?.closest('form') ?? null;
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        submitted = true;
      }
    }
  }
  return { fields: results, submitted };
}
