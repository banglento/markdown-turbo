// markdown-turbo — a dependency-free Markdown renderer whose output is byte-identical to
// marked 18.1.3 with default options (gfm: true, breaks: false, pedantic: false, async: false).
//
// Design: an offset-based block scanner (charCode dispatch, indexOf line scanning) records
// block tokens with their raw inline source; inline rendering is a single left-to-right
// scanner plus a delimiter matcher for emphasis. No imports, no module-level mutable
// state, nothing carried between calls.

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escChar = (c) => HTML_ESCAPE[c];
const RE_ESCAPE_ALL = /[&<>"']/g;
const RE_ESCAPE_SAFE = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_ESCAPE_TEST = /[&<>"']/;
const RE_ESCAPE_SAFE_TEST = /[<>"']|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_ENTITY = /&#(?:(?:\d{1,7})|[Xx][A-Fa-f0-9]{1,6});/;
const RE_ENTITY_G = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function esc(s, all) {
  if (all) return RE_ESCAPE_TEST.test(s) ? s.replace(RE_ESCAPE_ALL, escChar) : s;
  return RE_ESCAPE_SAFE_TEST.test(s) ? s.replace(RE_ESCAPE_SAFE, escChar) : s;
}

function decodeEntities(s) {
  if (!RE_ENTITY.test(s)) return s;
  return s.replace(RE_ENTITY_G, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const cp = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    if (cp === 38) return '&amp;';
    return String.fromCodePoint(cp);
  });
}

function encodeHref(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
}

const RE_WS_RUN = /\s+/g;
function normLabel(s) {
  return s.trim().replace(RE_WS_RUN, ' ').toLowerCase().toUpperCase().toLowerCase();
}

const RE_PUNCT_ESC_G = /\\([\p{P}\p{S}])/gu;
const RE_PUNCT_ESC_TEST = /\\[\p{P}\p{S}]/u;
function unescapePunct(s) {
  return RE_PUNCT_ESC_TEST.test(s) ? s.replace(RE_PUNCT_ESC_G, '$1') : s;
}

const C_TAB = 9, C_NL = 10, C_VT = 11, C_FF = 12, C_CR = 13, C_SP = 32;
const C_BANG = 33, C_DQUOTE = 34, C_HASH = 35, C_STAR = 42, C_PLUS = 43, C_MINUS = 45;
const C_DOT = 46, C_COLON = 58, C_LT = 60, C_GT = 62, C_QUEST = 63;
const C_LBRACK = 91, C_BSLASH = 92, C_RBRACK = 93, C_UNDER = 95, C_BTICK = 96;
const C_PIPE = 124, C_TILDE = 126, C_EQ = 61, C_SQUOTE = 39, C_LPAREN = 40, C_RPAREN = 41;
const C_SLASH = 47, C_AT = 64, C_CARET = 94, C_LBRACE = 123;

function isDigit(c) { return c >= 48 && c <= 57; }
function isAsciiLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAsciiAlphaNum(c) { return isAsciiLetter(c) || isDigit(c); }
function isSpaceTab(c) { return c === C_SP || c === C_TAB; }
function isWs(c) { return c === C_SP || c === C_TAB || c === C_NL || c === C_CR || c === C_FF || c === C_VT; }

const RE_PUNCT = /[\p{P}\p{S}]/u;

function lineEnd(s, from) {
  const i = s.indexOf('\n', from);
  return i < 0 ? s.length : i;
}
function leadSpaces(s, pos, len) {
  let i = pos;
  while (i < len && s.charCodeAt(i) === C_SP) i++;
  return i - pos;
}
function skipSpaceTab(s, pos, len) {
  let i = pos;
  for (; i < len; i++) {
    const c = s.charCodeAt(i);
    if (c !== C_SP && c !== C_TAB) break;
  }
  return i;
}
function isBlankRange(s, a, b) { return skipSpaceTab(s, a, b) === b; }
function indentWidth(s, a, b) {
  let w = 0;
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === C_SP) w++;
    else if (c === C_TAB) w += 4 - (w % 4);
    else break;
  }
  return w;
}
function stripEndChar(s, ch) {
  let i = s.length;
  while (i > 0 && s.charCodeAt(i - 1) === ch) i--;
  return s.slice(0, i);
}
/** Trim trailing blank lines, keeping a single trailing blank line. */
function trimBlankTail(src) {
  const n = src.length;
  if (n === 0) return src;
  let i = n, blanks = 0, cut = -1;
  for (;;) {
    const p = i === 0 ? 0 : src.lastIndexOf('\n', i - 1) + 1;
    if (!isBlankRange(src, p, i)) break;
    blanks++;
    cut = p === 0 ? 0 : p - 1;
    if (p === 0) break;
    i = p - 1;
  }
  if (blanks <= 1) return src;
  return cut <= 0 ? '' : src.slice(0, cut);
}

const BLOCK_TAGS = new Set((
  'address article aside base basefont blockquote body caption center col colgroup dd details ' +
  'dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup ' +
  'option p param search section summary table tbody td tfoot th thead title tr track ul'
).split(' '));

/* ------------------------------------------------------------ block scan */

function scanSpace(s, pos) {
  const n = s.length;
  let i = pos;
  let end = -1;
  for (;;) {
    let j = i;
    while (j < n && isSpaceTab(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === C_NL) { i = j + 1; end = i; continue; }
    if (j === n) { end = j; break; }
    break;
  }
  return end;
}

function dedentCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const e = lineEnd(src, i);
    let sp = 0;
    while (sp < 3 && i + sp < e && src.charCodeAt(i + sp) === C_SP) sp++;
    if (i + sp < e && src.charCodeAt(i + sp) === C_TAB) {
      out += src.slice(i + sp + 1, e);
    } else {
      let k = 0;
      while (k < 4 && i + k < e && src.charCodeAt(i + k) === C_SP) k++;
      out += src.slice(i + k, e);
    }
    if (e < n) { out += '\n'; i = e + 1; } else { i = n; }
  }
  return out;
}

function scanIndentedCode(s, pos) {
  const n = s.length;
  let i = pos;
  let first = true;
  for (;;) {
    const e = lineEnd(s, i);
    let sp = 0;
    while (i + sp < e && s.charCodeAt(i + sp) === C_SP) sp++;
    let contentStart = -1;
    if (sp >= 4) contentStart = i + 4;
    else if (sp <= 3 && i + sp < e && s.charCodeAt(i + sp) === C_TAB) contentStart = i + sp + 1;
    if (contentStart < 0 || contentStart >= e) {
      if (first) return null;
      break;
    }
    first = false;
    i = e < n ? e + 1 : n;
    for (;;) {
      if (i >= n) break;
      const e2 = lineEnd(s, i);
      if (isBlankRange(s, i, e2)) { i = e2 < n ? e2 + 1 : n; continue; }
      break;
    }
    if (i >= n) break;
  }
  const raw = trimBlankTail(s.slice(pos, i));
  return { raw, text: dedentCode(raw) };
}

function scanFence(s, pos) {
  const n = s.length;
  const sp = leadSpaces(s, pos, n);
  if (sp > 3) return null;
  const p = pos + sp;
  if (p >= n) return null;
  const fc = s.charCodeAt(p);
  if (fc !== C_BTICK && fc !== C_TILDE) return null;
  let run = 0;
  while (p + run < n && s.charCodeAt(p + run) === fc) run++;
  if (run < 3) return null;
  const le = lineEnd(s, p);
  if (fc === C_BTICK) {
    const bt = s.indexOf('`', p + run);
    if (bt >= 0 && bt < le) return null;
  }
  const info = s.slice(p + run, le);
  if (le === n) {
    return { raw: s.slice(pos), text: '', lang: info.trim() ? unescapePunct(info.trim()) : info };
  }
  const bodyStart = le + 1;
  let i = bodyStart;
  let contentEnd = -1, rawEnd = -1;
  for (;;) {
    if (i > n) break;
    const cle = i >= n ? n : lineEnd(s, i);
    let q = i, csp = 0;
    while (q < cle && s.charCodeAt(q) === C_SP && csp < 4) { q++; csp++; }
    if (csp <= 3) {
      let r = 0;
      while (q + r < cle && s.charCodeAt(q + r) === fc) r++;
      if (r >= run) {
        let t = q + r;
        while (t < cle && s.charCodeAt(t) === C_SP) t++;
        if (t === cle) { contentEnd = i; rawEnd = cle; break; }
      }
    }
    if (cle >= n) break;
    i = cle + 1;
  }
  let text, raw;
  if (contentEnd < 0) {
    raw = s.slice(pos);
    text = s.slice(bodyStart);
    if (text.endsWith('\n')) text = text.slice(0, -1);
  } else {
    raw = s.slice(pos, rawEnd);
    text = s.slice(bodyStart, contentEnd);
    if (text.endsWith('\n')) text = text.slice(0, -1);
  }
  // indent compensation for backtick fences indented at the opening line
  if (sp > 0 && fc === C_BTICK) {
    let out = '';
    let j = 0;
    const tn = text.length;
    while (j < tn) {
      const e2 = lineEnd(text, j);
      let k = j;
      while (k < e2 && isWs(text.charCodeAt(k))) k++;
      const strip = Math.min(k - j, sp);
      out += text.slice(j + strip, e2);
      if (e2 < tn) { out += '\n'; j = e2 + 1; } else j = tn;
    }
    text = out;
  }
  return { raw, text, lang: info.trim() ? unescapePunct(info.trim()) : info };
}

function scanHeading(s, pos) {
  const n = s.length;
  const sp = leadSpaces(s, pos, n);
  if (sp > 3) return null;
  const p = pos + sp;
  let run = 0;
  while (p + run < n && s.charCodeAt(p + run) === C_HASH) run++;
  if (run < 1 || run > 6) return null;
  const after = p + run;
  if (after < n && !isWs(s.charCodeAt(after))) return null;
  const le = lineEnd(s, after);
  let text = s.slice(after, le).trim();
  if (text.length > 0 && text.charCodeAt(text.length - 1) === C_HASH) {
    const stripped = stripEndChar(text, C_HASH);
    if (stripped.length === 0 || stripped.endsWith(' ') || stripped.endsWith('\t')) text = stripped.trim();
  }
  let rawEnd = le;
  while (rawEnd < n && s.charCodeAt(rawEnd) === C_NL) rawEnd++;
  return { rawEnd, depth: run, text };
}

function scanHr(s, pos) {
  const n = s.length;
  const sp = leadSpaces(s, pos, n);
  if (sp > 3) return -1;
  const p = pos + sp;
  if (p >= n) return -1;
  const c = s.charCodeAt(p);
  if (c !== C_MINUS && c !== C_UNDER && c !== C_STAR) return -1;
  const le = lineEnd(s, p);
  let count = 0;
  for (let i = p; i < le; i++) {
    const ch = s.charCodeAt(i);
    if (ch === c) count++;
    else if (ch !== C_SP && ch !== C_TAB) return -1;
  }
  if (count < 3) return -1;
  let end = le;
  while (end < n && s.charCodeAt(end) === C_NL) end++;
  return end;
}

function isHrLine(s, i, le) {
  let p = i, sp = 0;
  while (p < le && s.charCodeAt(p) === C_SP) { p++; sp++; }
  if (sp > 3 || p >= le) return false;
  const c = s.charCodeAt(p);
  if (c !== C_MINUS && c !== C_UNDER && c !== C_STAR) return false;
  let count = 0;
  for (let k = p; k < le; k++) {
    const ch = s.charCodeAt(k);
    if (ch === c) count++;
    else if (ch !== C_SP && ch !== C_TAB) return false;
  }
  return count >= 3;
}

function scanToBlankLine(s, from) {
  const n = s.length;
  let i = from;
  for (;;) {
    if (i >= n) return n;
    const le = lineEnd(s, i);
    if (le >= n) return n;
    const ne = lineEnd(s, le + 1);
    if (isBlankRange(s, le + 1, ne)) return le;
    i = le + 1;
  }
}

function scanHtmlBlock(s, pos) {
  const n = s.length;
  const sp = leadSpaces(s, pos, n);
  if (sp > 3) return null;
  const p = pos + sp;
  if (p >= n || s.charCodeAt(p) !== C_LT) return null;
  let i = p + 1;
  if (i >= n) return null;
  const c = s.charCodeAt(i);
  const lineEndAfter = (at) => lineEnd(s, at);
  const finish = (e, pre) => {
    // consumed runs through the following blank-line run; the raw keeps the
    // newline after the last content line only per marked's branch rules:
    // pre-family (keepNl): kept unless the next line is completely empty;
    // block-tag/generic: kept only when it is the last char of the input.
    let e2 = e;
    if (e2 < n && s.charCodeAt(e2) === C_NL) {
      e2++;
      let i = e2;
      while (i < n) {
        const le2 = lineEnd(s, i);
        if (isBlankRange(s, i, le2)) { i = le2 < n ? le2 + 1 : n; } else break;
      }
      e2 = i;
    }
    let raw = s.slice(pos, e);
    if (e < n) {
      if (pre.keepNl) {
        if (e + 1 >= n || s.charCodeAt(e + 1) !== C_NL) raw += '\n';
      } else if (e + 1 >= n) raw += '\n';
    }
    return { raw, consumed: e2, pre: !!pre.pre };
  };

  if (c === 33) { // '!'
    const c2 = s.charCodeAt(i + 1);
    if (c2 === C_MINUS && s.charCodeAt(i + 2) === C_MINUS) {
      let e = -1;
      const dash = s.indexOf('-->', i + 3);
      const short = s.indexOf('->', i + 3);
      if (short >= 0 && (dash < 0 || short < dash)) e = short + 2;
      else if (dash >= 0) e = dash + 3;
      if (e < 0) e = n;
      else e = lineEndAfter(e);
      return finish(e, { keepNl: true });
    }
    if (c2 === C_LBRACK) {
      if (!s.startsWith('![CDATA[', i)) return null;
      const close = s.indexOf(']]>', i + 8);
      const e = close < 0 ? n : lineEndAfter(close + 3);
      return finish(e, { keepNl: true });
    }
    if (c2 >= 65 && c2 <= 90) {
      const gt = s.indexOf('>', i + 2);
      const e = gt < 0 ? n : lineEndAfter(gt + 1);
      return finish(e, { keepNl: true });
    }
    return null;
  }
  if (c === C_QUEST) {
    const close = s.indexOf('?>', i + 1);
    const e = close < 0 ? n : lineEndAfter(close + 2);
    return finish(e, { keepNl: true });
  }

  const closing = c === C_SLASH;
  const nameStart = closing ? i + 1 : i;
  let j = nameStart;
  while (j < n) {
    const cc = s.charCodeAt(j);
    if (isAsciiAlphaNum(cc) || cc === C_MINUS) j++;
    else break;
  }
  if (j === nameStart || !isAsciiLetter(s.charCodeAt(nameStart))) return null;
  const name = s.slice(nameStart, j).toLowerCase();

  if (!closing && (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea')) {
    if (j < n) {
      const cc = s.charCodeAt(j);
      if (isWs(cc) || cc === C_GT) {
        const needle = '</' + name;
        const idx = s.toLowerCase().indexOf(needle, j);
        let e;
        if (idx < 0) e = n;
        else {
          const gt = s.indexOf('>', idx + needle.length);
          e = gt < 0 ? n : lineEndAfter(gt + 1);
        }
        return finish(e, { keepNl: true, pre: name !== 'textarea' });
      }
    }
    return null;
  }

  if (BLOCK_TAGS.has(name)) {
    let ok = false;
    if (j >= n) ok = true;
    else {
      const cc = s.charCodeAt(j);
      if (cc === C_SP || cc === C_TAB || cc === C_NL) ok = true;
      else if (cc === C_SLASH && s.charCodeAt(j + 1) === C_GT) ok = true;
      else if (cc === C_GT) ok = true;
    }
    if (ok) {
      const e = scanToBlankLine(s, j);
      return finish(e, { keepNl: false });
    }
    if (!closing) return null;
  }

  // generic complete tag on its own line, then until blank line
  if (name === 'script' || name === 'pre' || name === 'style' || name === 'textarea') return null;
  if (closing) {
    let t0 = j;
    while (t0 < n && isWs(s.charCodeAt(t0))) t0++;
    if (s.charCodeAt(t0) !== C_GT) return null;
  }
  let k = j;
  for (;;) {
    const wsStart = k;
    while (k < n && s.charCodeAt(k) === C_SP) k++;
    if (k > wsStart && k < n) {
      const cc = s.charCodeAt(k);
      if (cc === C_GT || cc === C_SLASH) { /* fall through */ }
      else if (isAsciiLetter(cc) || cc === C_UNDER || cc === C_COLON) {
        k++;
        while (k < n) {
          const a = s.charCodeAt(k);
          if (isAsciiAlphaNum(a) || a === C_MINUS || a === C_DOT || a === C_COLON || a === C_UNDER) k++;
          else break;
        }
        let q = k;
        while (q < n && s.charCodeAt(q) === C_SP) q++;
        if (q < n && s.charCodeAt(q) === C_EQ) {
          q++;
          while (q < n && s.charCodeAt(q) === C_SP) q++;
          if (q < n) {
            const vc = s.charCodeAt(q);
            if (vc === 34 || vc === C_SQUOTE) {
              const close = s.indexOf(vc === 34 ? '"' : "'", q + 1);
              if (close < 0 || close > lineEnd(s, q)) return null;
              k = close + 1;
            } else {
              const vs = q;
              while (q < n) {
                const a = s.charCodeAt(q);
                if (isWs(a) || a === 34 || a === C_SQUOTE || a === C_EQ || a === C_LT || a === C_GT || a === C_BTICK) break;
                q++;
              }
              if (q === vs) return null;
              k = q;
            }
          }
        }
        continue;
      } else return null;
    }
    const cc = s.charCodeAt(k);
    if (cc === C_GT) { k++; break; }
    if (cc === C_SLASH && s.charCodeAt(k + 1) === C_GT) { k += 2; break; }
    return null;
  }
  let t = k;
  while (t < n && isSpaceTab(s.charCodeAt(t))) t++;
  if (t < n && s.charCodeAt(t) !== C_NL) return null;
  const e = scanToBlankLine(s, k);
  return finish(e, { keepNl: false });
}

/* ------------------------------------------------- link reference definitions */

function scanTitle(s, at) {
  const n = s.length;
  if (at >= n) return null;
  const q = s.charCodeAt(at);
  let closeCh;
  if (q === 34) closeCh = 34;
  else if (q === C_SQUOTE) closeCh = C_SQUOTE;
  else if (q === C_LPAREN) closeCh = C_RPAREN;
  else return null;
  let i = at + 1;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === C_BSLASH) { i += 2; continue; }
    if (c === closeCh) return { title: s.slice(at + 1, i), end: i + 1 };
    if (c === C_NL) {
      if (q === 34) return null;
      if (q === C_SQUOTE && s.charCodeAt(i + 1) === C_NL) return null;
    }
    i++;
  }
  return null;
}

function scanDefinition(s, pos) {
  const n = s.length;
  const sp = leadSpaces(s, pos, n);
  if (sp > 3) return null;
  let i = pos + sp;
  if (i >= n || s.charCodeAt(i) !== C_LBRACK) return null;
  i++;
  {
    let la = i;
    while (la < n && isWs(s.charCodeAt(la))) la++;
    if (la < n && s.charCodeAt(la) === C_RBRACK) return null;
  }
  const labelStart = i;
  let hasLabel = false;
  for (;;) {
    if (i >= n) return null;
    const c = s.charCodeAt(i);
    if (c === C_BSLASH) {
      if (i + 1 >= n) return null;
      i += 2; hasLabel = true;
    } else if (c === C_LBRACK || c === C_RBRACK) break;
    else if (c === C_NL) {
      let la = i + 1;
      while (la < n && isSpaceTab(s.charCodeAt(la))) la++;
      if (la >= n || s.charCodeAt(la) === C_NL) break;
      i++; hasLabel = true;
    } else { i++; hasLabel = true; }
  }
  if (!hasLabel) return null;
  const label = s.slice(labelStart, i);
  if (i >= n || s.charCodeAt(i) !== C_RBRACK) return null;
  i++;
  if (i >= n || s.charCodeAt(i) !== C_COLON) return null;
  i++;
  while (i < n && s.charCodeAt(i) === C_SP) i++;
  if (i < n && s.charCodeAt(i) === C_NL) {
    let j = i + 1;
    while (j < n && isSpaceTab(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === C_NL) return null;
    i = j;
  }
  if (i >= n) return null;
  let href;
  if (s.charCodeAt(i) === C_LT) {
    const close = s.indexOf('>', i + 1);
    if (close < 0 || close > lineEnd(s, i)) return null;
    href = s.slice(i, close + 1);
    i = close + 1;
  } else {
    const start = i;
    if (isWs(s.charCodeAt(i))) return null;
    while (i < n && !isWs(s.charCodeAt(i))) i++;
    href = s.slice(start, i);
  }
  let title;
  const afterDest = i;
  let j = i;
  let k = j;
  while (k < n && s.charCodeAt(k) === C_SP) k++;
  if (k > j && k < n) {
    let q = k;
    while (q < n && isWs(s.charCodeAt(q))) q++;
    const t = scanTitle(s, q);
    if (t) { title = t.title; i = t.end; }
    else i = k;
  } else if (k < n && s.charCodeAt(k) === C_NL) {
    let q = k + 1;
    while (q < n && isSpaceTab(s.charCodeAt(q))) q++;
    const t = scanTitle(s, q);
    if (t) { title = t.title; i = t.end; }
  } else i = k;
  while (i < n && s.charCodeAt(i) === C_SP) i++;
  if (i < n && s.charCodeAt(i) !== C_NL) {
    if (title === undefined) return null;
    // a would-be title that is not alone on the line voids only the title
    title = undefined;
    i = afterDest;
    while (i < n && s.charCodeAt(i) === C_SP) i++;
    if (i < n && s.charCodeAt(i) !== C_NL) return null;
  }
  let rawEnd = i;
  while (rawEnd < n && s.charCodeAt(rawEnd) === C_NL) rawEnd++;
  return {
    consumed: rawEnd,
    raw: stripEndChar(s.slice(pos, rawEnd), C_NL),
    tag: normLabel(label.replace(/\\([\[\]])/g, '$1')),
    href: href.startsWith('<') ? unescapePunct(href.slice(1, -1)) : unescapePunct(href),
    title: title === undefined ? undefined : unescapePunct(title),
  };
}

/* ------------------------------------------------------------------ tables */

function splitRow(row) {
  const cells = [];
  const pieces = [];
  let cellStart = 0;
  for (let i = 0; i < row.length; i++) {
    if (row.charCodeAt(i) !== C_PIPE) continue;
    let bs = 0, p = i - 1;
    while (p >= 0 && row.charCodeAt(p) === C_BSLASH) { bs++; p--; }
    if (bs % 2 === 1) continue;
    pieces.push(row.slice(cellStart, i));
    cellStart = i + 1;
  }
  pieces.push(row.slice(cellStart));
  if (pieces.length === 1) return [pieces[0].trim()];
  let start = 0;
  if (!pieces[0].trim()) start = 1;
  let end = pieces.length;
  if (end > start && !pieces[end - 1].trim()) end--;
  for (let k = start; k < end; k++) {
    let v = pieces[k].trim();
    if (v.indexOf('\\|') >= 0) v = v.replace(/\\\|/g, '|');
    cells.push(v);
  }
  return cells;
}

function parseTableAlign(delim) {
  let d = delim;
  if (d.charCodeAt(0) === C_PIPE) d = d.slice(1);
  d = d.replace(/\| *$/, '');
  const parts = d.split('|');
  const aligns = [];
  for (const cell of parts) {
    if (/^ *-+: *$/.test(cell)) aligns.push('right');
    else if (/^ *:-+: *$/.test(cell)) aligns.push('center');
    else if (/^ *:-+ *$/.test(cell)) aligns.push('left');
    else if (/^ *-+:? *$/.test(cell) || /^ *-+ *$/.test(cell)) aligns.push(null);
    else return null;
  }
  return aligns;
}

function interruptsTable(s, i, le) {
  if (isHrLine(s, i, le)) return true;
  const sp = leadSpaces(s, i, le);
  if (sp > 3) return indentWidth(s, i, le) >= 4;
  const p = i + sp;
  if (p >= le) return false;
  const c = s.charCodeAt(p);
  if (c === C_HASH) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === C_HASH) r++;
    return r <= 6 && (p + r === le || isWs(s.charCodeAt(p + r)));
  }
  if (c === C_GT) return true;
  if (c === C_BTICK || c === C_TILDE) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === c) r++;
    return r >= 3;
  }
  if (isListMarkerLine(s, p, le)) return true;
  if (c === C_LT && htmlBlockStart(s, p, le)) return true;
  return false;
}

function scanTable(s, pos) {
  const n = s.length;
  let i = pos;
  while (i < n && s.charCodeAt(i) === C_SP) i++;
  if (i >= n) return null;
  const c0 = s.charCodeAt(i);
  if (c0 === C_NL) return null;
  const headerEnd = lineEnd(s, i);
  const headerLine = s.slice(i, headerEnd);
  if (headerEnd >= n) return null;
  const dStart = headerEnd + 1;
  if (dStart >= n) return null;
  const dSp = leadSpaces(s, dStart, n);
  if (dSp > 3) return null;
  const dEnd = lineEnd(s, dStart + dSp);
  const delim = s.slice(dStart + dSp, dEnd);
  if (delim.indexOf(':') < 0 && delim.indexOf('|') < 0) return null;
  if (!/^(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/.test(delim)) return null;
  const aligns = parseTableAlign(delim);
  if (!aligns) return null;
  const header = splitRow(headerLine);
  if (header.length !== aligns.length) return null;
  let j = dEnd < n ? dEnd + 1 : n;
  const rows = [];
  let connEnd = j;
  while (j < n) {
    const le = lineEnd(s, j);
    let onlySpaces = true;
    for (let k = j; k < le; k++) if (s.charCodeAt(k) !== C_SP) { onlySpaces = false; break; }
    if (onlySpaces) break;
    if (interruptsTable(s, j, le)) break;
    rows.push(s.slice(j, le));
    connEnd = le < n ? le + 1 : n;
    j = le < n ? le + 1 : n;
  }
  let rawEnd = connEnd;
  while (rawEnd < n && s.charCodeAt(rawEnd) === C_NL) rawEnd++;
  return { consumed: rawEnd, raw: stripEndChar(s.slice(pos, rawEnd), C_NL), header, aligns, rows };
}

/* -------------------------------------------------------- setext headings */

function isTableDelimiterLine(s, p, le) {
  let i = p;
  if (i < le && s.charCodeAt(i) === C_PIPE) i++;
  let pipes = 0;
  for (;;) {
    while (i < le) {
      const c = s.charCodeAt(i);
      if (c === C_COLON || c === C_MINUS || c === C_SP) i++;
      else break;
    }
    if (i < le && s.charCodeAt(i) === C_PIPE) { pipes++; i++; continue; }
    break;
  }
  if (pipes < 1) return false;
  while (i < le) {
    const c = s.charCodeAt(i);
    if (c === C_COLON || c === C_MINUS || c === C_SP) i++;
    else return false;
  }
  return i === le;
}

function lineStartsBlock(s, i, le) {
  const sp = leadSpaces(s, i, le);
  if (sp > 3) return true;
  const p = i + sp;
  if (p >= le) return false;
  const c = s.charCodeAt(p);
  if (isListMarkerLine(s, p, le)) return true;
  if (c === C_BTICK || c === C_TILDE) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === c) r++;
    if (r >= 3) return true;
  }
  if (c === C_GT) return true;
  if (c === C_HASH) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === C_HASH) r++;
    if (r <= 6 && (p + r >= le || isWs(s.charCodeAt(p + r)))) return true;
  }
  if (c === C_LT) {
    // only CommonMark html-block starts (conditions 1-6) count as block starts;
    // generic tags (span, br, a, ...) are paragraph content
    if (htmlInterruptsParagraph(s, p, le)) return true;
    let i = p + 1;
    if (s.charCodeAt(i) !== C_SLASH) {
      let j = i;
      while (j < le && isAsciiLetter(s.charCodeAt(j))) j++;
      const nm = s.slice(i, j).toLowerCase();
      if (nm === 'script' || nm === 'pre' || nm === 'style' || nm === 'textarea') {
        if (j >= le) return true;
        const cc = s.charCodeAt(j);
        if (cc === C_SP || cc === C_TAB || cc === C_GT) return true;
      }
    }
    return false;
  }
  if (c === C_PIPE) {
    if (isTableDelimiterLine(s, p, le)) return true;
  }
  return false;
}

function scanSetext(s, pos) {
  const n = s.length;
  if (pos >= n) return null;
  const le0 = lineEnd(s, pos);
  if (lineStartsBlock(s, pos, le0)) return null;
  let i = pos;
  for (;;) {
    const le = lineEnd(s, i);
    if (le < n) {
      const uStart = le + 1;
      const uSp = leadSpaces(s, uStart, n);
      if (uSp <= 3) {
        const u = uStart + uSp;
        const uc = s.charCodeAt(u);
        if (uc === C_EQ || uc === C_MINUS) {
          let r = 0;
          while (u + r < n && s.charCodeAt(u + r) === uc) r++;
          let t = u + r;
          while (t < n && (s.charCodeAt(t) === C_SP || s.charCodeAt(t) === C_TAB)) t++;
          if ((t >= n || s.charCodeAt(t) === C_NL) && le > pos) {
            const text = s.slice(pos, le).trim();
            let rawEnd = t;
            while (rawEnd < n && s.charCodeAt(rawEnd) === C_NL) rawEnd++;
            return { consumed: rawEnd, raw: stripEndChar(s.slice(pos, rawEnd), C_NL), depth: uc === C_EQ ? 1 : 2, text };
          }
        }
      }
    }
    if (le >= n) return null;
    const next = le + 1;
    const nle = lineEnd(s, next);
    if (isBlankRange(s, next, nle)) return null;
    if (lineStartsBlock(s, next, nle)) return null;
    i = next;
  }
}

/* ---------------------------------------------------------- block driver */

function newLexer() {
  return { links: Object.create(null), top: true, noUrl: false };
}

function appendToText(tok, addText, addRaw) {
  tok.raw += (tok.raw.charCodeAt(tok.raw.length - 1) === C_NL ? '' : '\n') + addRaw;
  tok.text += '\n' + addText;
}

function blockTokens(lex, src, tokens, merge) {
  while (src.length > 0) {
    let m;
    const spaceEnd = scanSpace(src, 0);
    if (spaceEnd > 0) {
      const raw = src.slice(0, spaceEnd);
      src = src.slice(spaceEnd);
      const last = tokens[tokens.length - 1];
      if (raw.length === 1 && last !== undefined) last.raw += '\n';
      else tokens.push({ type: 'space', raw });
      continue;
    }
    if ((m = scanIndentedCode(src, 0))) {
      src = src.slice(m.raw.length);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        appendToText(last, m.text, m.raw);
      } else {
        tokens.push({ type: 'code', raw: m.raw, text: m.text, lang: undefined });
      }
      continue;
    }
    if ((m = scanFence(src, 0))) {
      src = src.slice(m.raw.length);
      tokens.push({ type: 'code', raw: m.raw, text: m.text, lang: m.lang });
      continue;
    }
    if ((m = scanHeading(src, 0))) {
      tokens.push({ type: 'heading', raw: src.slice(0, m.rawEnd), depth: m.depth, text: m.text });
      src = src.slice(m.rawEnd);
      continue;
    }
    const hrEnd = scanHr(src, 0);
    if (hrEnd >= 0) {
      tokens.push({ type: 'hr', raw: src.slice(0, hrEnd) });
      src = src.slice(hrEnd);
      continue;
    }
    if ((m = scanBlockquote(lex, src))) {
      src = src.slice(m.len);
      tokens.push(m.token);
      continue;
    }
    if ((m = scanList(lex, src))) {
      src = src.slice(m.len);
      tokens.push(m.token);
      continue;
    }
    if ((m = scanHtmlBlock(src, 0))) {
      src = src.slice(m.consumed);
      tokens.push({ type: 'html', block: true, raw: m.raw, pre: m.pre, text: m.raw });
      continue;
    }
    if ((m = scanDefinition(src, 0))) {
      src = src.slice(m.consumed);
      const last = tokens[tokens.length - 1];
      if (last && (last.type === 'paragraph' || last.type === 'text')) {
        appendToText(last, m.raw, m.raw);
      } else {
        if (!lex.links[m.tag]) lex.links[m.tag] = { href: m.href, title: m.title };
        tokens.push({ type: 'def', raw: m.raw, tag: m.tag, href: m.href, title: m.title });
      }
      continue;
    }
    if ((m = scanTable(src, 0))) {
      src = src.slice(m.consumed);
      tokens.push({ type: 'table', raw: m.raw, header: m.header, aligns: m.aligns, rows: m.rows });
      continue;
    }
    if ((m = scanSetext(src, 0))) {
      src = src.slice(m.consumed);
      tokens.push({ type: 'heading', raw: m.raw, depth: m.depth, text: m.text });
      continue;
    }
    if (lex.top) {
      const pEnd = scanParagraph(src, 0);
      if (pEnd > 0) {
        const raw = src.slice(0, pEnd);
        let text = raw;
        if (text.charCodeAt(text.length - 1) === C_NL) text = text.slice(0, -1);
        const last = tokens[tokens.length - 1];
        if (merge && last && last.type === 'paragraph') {
          appendToText(last, text, raw);
        } else {
          tokens.push({ type: 'paragraph', raw, text });
        }
        src = src.slice(pEnd);
        continue;
      }
    }
    const le = lineEnd(src, 0);
    if (le > 0) {
      const raw = src.slice(0, le);
      src = src.slice(le);
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') appendToText(last, raw, raw);
      else tokens.push({ type: 'text', raw, text: raw });
      continue;
    }
    src = src.slice(1);
  }
  return tokens;
}

function scanParagraph(s, pos) {
  const n = s.length;
  let i = lineEnd(s, pos);
  for (;;) {
    if (i >= n) return n;
    const next = i + 1;
    const le = lineEnd(s, next);
    if (le === next) return i;
    if (isBlankRange(s, next, le)) {
      if (le >= n) { i = le; continue; }
      return i;
    }
    if (isParagraphStop(s, next, le)) return i;
    i = le;
  }
}

function isParagraphStop(s, i, le) {
  const sp = leadSpaces(s, i, le);
  if (sp > 3) return false;
  const p = i + sp;
  if (p >= le) return true;
  const c = s.charCodeAt(p);
  if (c === C_MINUS || c === C_STAR || c === C_PLUS) {
    if (isHrLine(s, i, le)) return true;
    return isListMarkerTight(s, p, le);
  }
  if (c === C_GT) return true;
  if (c === C_HASH) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === C_HASH) r++;
    if (r <= 6 && (p + r >= le || isWs(s.charCodeAt(p + r)))) return true;
    return false;
  }
  if (c === C_BTICK) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === C_BTICK) r++;
    if (r < 3) return false;
    for (let k = p + r; k < le; k++) if (s.charCodeAt(k) === C_BTICK) return false;
    return true;
  }
  if (c === C_TILDE) {
    let r = 0;
    while (p + r < le && s.charCodeAt(p + r) === C_TILDE) r++;
    return r >= 3;
  }
  if (c === C_LT) return htmlInterruptsParagraph(s, p, le);
  if (isDigit(c)) {
    let j = p;
    while (j < le && isDigit(s.charCodeAt(j)) && j - p < 10) j++;
    if (j - p > 9) return false;
    const d = s.charCodeAt(j);
    if ((d === C_DOT || d === C_RPAREN) && j + 1 < le) {
      if (s.charCodeAt(j + 1) === C_SP || s.charCodeAt(j + 1) === C_TAB) {
        if (s.slice(p, j) !== '1') return false;
        return skipSpaceTab(s, j + 1, le) < le;
      }
    }
    return false;
  }
  return false;
}

function isListMarkerTight(s, p, le) {
  const j = p + 1;
  if (j >= le) return false;
  const c = s.charCodeAt(j);
  if (c !== C_SP && c !== C_TAB) return false;
  return skipSpaceTab(s, j, le) < le;
}

function htmlInterruptsParagraph(s, p, le) {
  let i = p + 1;
  if (i >= le) return false;
  const c = s.charCodeAt(i);
  if (c === C_BANG) {
    const c2 = s.charCodeAt(i + 1);
    if (c2 === C_MINUS) return s.charCodeAt(i + 2) === C_MINUS;
    if (c2 === C_LBRACK) return s.startsWith('![CDATA[', i);
    return c2 >= 65 && c2 <= 90;
  }
  if (c === C_QUEST) return true;
  const closing = c === C_SLASH;
  if (closing) i++;
  const ns = i;
  while (i < le && isAsciiLetter(s.charCodeAt(i))) i++;
  if (i === ns) return false;
  const name = s.slice(ns, i).toLowerCase();
  if (!BLOCK_TAGS.has(name)) return false;
  if (i >= le) return false;
  const cc = s.charCodeAt(i);
  if (cc === C_SP || cc === C_NL) return true;
  if (cc === C_GT) return true;
  if (cc === C_SLASH && s.charCodeAt(i + 1) === C_GT) return true;
  return false;
}

/* ------------------------------------------------------- lists & quotes */

/** List marker at `p` (indent already stripped). Returns {bull, ordered, start, delim, len} or null. */
function matchListMarker(s, p, le) {
  if (p >= le) return null;
  const c = s.charCodeAt(p);
  if (c === C_STAR || c === C_PLUS || c === C_MINUS) {
    const j = p + 1;
    if (j >= le) return { bull: s[p], ordered: false, start: 0, len: 1, blank: true };
    const nc = s.charCodeAt(j);
    if (nc !== C_SP && nc !== C_TAB) return null;
    return { bull: s[p], ordered: false, start: 0, len: 1, blank: false };
  }
  if (isDigit(c)) {
    let j = p;
    while (j < le && isDigit(s.charCodeAt(j)) && j - p < 9) j++;
    if (j - p > 9 || j >= le) return null;
    const d = s.charCodeAt(j);
    if (d !== C_DOT && d !== C_RPAREN) return null;
    const k = j + 1;
    if (k >= le) return { bull: s.slice(p, k), ordered: true, start: parseInt(s.slice(p, j), 10), len: k - p, blank: true };
    const nc = s.charCodeAt(k);
    if (nc !== C_SP && nc !== C_TAB) return null;
    return { bull: s.slice(p, k), ordered: true, start: parseInt(s.slice(p, j), 10), len: k - p, blank: false };
  }
  return null;
}

function isListMarkerLine(s, p, le) { return matchListMarker(s, p, le) !== null; }

/** Could an html block start at `p` (line bounds le)? Used for table interruption. */
function htmlBlockStart(s, p, le) {
  if (s.charCodeAt(p) !== C_LT) return false;
  const save = s;
  const sub = scanHtmlBlock(save, p);
  return sub !== null;
}

/** Remove up to `cols` columns from the start of a single line string. */
function dedentLine(line, cols) {
  let f = 0;
  while (f < line.length && (line[f] === ' ' || line[f] === '\t')) f++;
  if (f === 0) return line;
  let col = 0;
  for (let i = 0; i < f; i++) col += line[i] === '\t' ? 4 - (col % 4) : 1;
  if (col <= cols) return line.slice(f);
  return ' '.repeat(col - cols) + line.slice(f);
}

/**
 * Inside a list item, a line indented by 4+ that continues a paragraph
 * (previous line non-blank, not itself code) loses that indent, matching
 * marked's text+code merge in non-top contexts.
 */
function dedentParaContinuations(text) {
  if (!text.includes('\n')) return text;
  const lines = text.split('\n');
  let inFence = false, fenceCh = '', fenceRun = 0;
  let prevBlank = true, prevCode = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    const trimmed = line.replace(/^ +/, '');
    if (inFence) {
      let r = 0;
      while (trimmed[r] === fenceCh) r++;
      if (r >= fenceRun && /^ *$/.test(trimmed.slice(r))) inFence = false;
      prevBlank = false; prevCode = false;
      continue;
    }
    const fm = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fm && line.length - trimmed.length <= 3) {
      inFence = true; fenceCh = fm[1][0]; fenceRun = fm[1].length;
      prevBlank = false; prevCode = false;
      continue;
    }
    if (/^[ \t]*$/.test(line)) { prevBlank = true; prevCode = false; continue; }
    if (idx > 0) {
      let col = 0, f = 0;
      while (f < line.length && (line[f] === ' ' || line[f] === '\t')) { col += line[f] === '\t' ? 4 - (col % 4) : 1; f++; }
      if (col >= 4) {
        if (!prevBlank && !prevCode) { lines[idx] = dedentLine(line, 4); prevCode = false; }
        else prevCode = true;
      } else prevCode = false;
    }
    prevBlank = false;
  }
  return lines.join('\n');
}

/** Split `src` into lines keeping offsets: [{start, end(no \n), next}] */
function splitLines(s) {
  const lines = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const e = lineEnd(s, i);
    lines.push({ start: i, end: e, next: e < n ? e + 1 : n });
    i = e + 1;
  }
  if (n === 0 || s.charCodeAt(n - 1) === C_NL) lines.push({ start: n, end: n, next: n });
  return lines;
}

/** Visual column of offset `to` within line starting `from` (tabs to stops of 4). */
function colOf(s, from, to) {
  let col = 0;
  for (let i = from; i < to; i++) {
    if (s.charCodeAt(i) === C_TAB) col += 4 - (col % 4);
    else col++;
  }
  return col;
}

/** Content of line s[a..b) with `cols` visual columns stripped from its start:
    leading whitespace is re-emitted as spaces measured in original columns. */
function stripColsStr(s, a, b, cols, from) {
  let f = from === undefined ? a : from;
  while (f < b && isSpaceTab(s.charCodeAt(f))) f++;
  if (f >= b) return '';
  const col = colOf(s, a, f);
  return ' '.repeat(Math.max(0, col - cols)) + s.slice(f, b);
}

/** Does this line start a block that ends blockquote lazy continuation? */
function bqLazyStop(s, a, b) {
  const sp = leadSpaces(s, a, b);
  const p = a + sp;
  if (p >= b) return true;
  const c = s.charCodeAt(p);
  if (sp <= 3) {
    if (c === C_GT) return true;
    if (isHrLine(s, a, b)) return true;
    if (c === C_HASH) {
      let r = 0;
      while (p + r < b && s.charCodeAt(p + r) === C_HASH) r++;
      if (r <= 6 && (p + r >= b || isWs(s.charCodeAt(p + r)))) return true;
    }
    if (c === C_BTICK || c === C_TILDE) {
      let r = 0;
      while (p + r < b && s.charCodeAt(p + r) === c) r++;
      if (r >= 3) return true;
    }
    if (matchListMarker(s, p, b)) return true;
    if (c === C_LT && htmlInterruptsParagraph(s, p, b)) return true;
  }
  return false;
}

/**
 * Blockquote. Returns {len, token} or null.
 * Collects `>` lines plus lazy paragraph continuations, strips markers,
 * and lexes the interior recursively.
 */
function stripMarkerLine(line) {
  let p = 0;
  while (p < line.length && line[p] === ' ') p++;
  if (p > 3 || line[p] !== '>') return line;
  const rest = line.slice(p + 1);
  if (/^[ \t]*$/.test(rest)) {
    return (rest[0] === ' ' || rest[0] === '\t') ? rest.slice(1) : '';
  }
  const markerCol = p;
  const nx = rest[0];
  const contentCol = markerCol + 1 + (nx === ' ' || nx === '\t' ? 1 : 0);
  return stripColsStr(line, 0, line.length, contentCol, p + 1);
}

function isMarkerLine(line) {
  let p = 0;
  while (p < line.length && line[p] === ' ') p++;
  return p <= 3 && line[p] === '>';
}

/**
 * Blockquote. Returns {len, token} or null.
 * Lines are collected (markers plus lazy paragraph continuations), then
 * lexed segment by segment with paragraph merging across segments,
 * mirroring how marked assembles a quote.
 */
/** Strip nested blockquote markers from a single line, leaving the innermost content. */
function deepContent(txt) {
  let t = txt;
  while (isMarkerLine(t)) t = stripMarkerLine(t);
  return t;
}

/** Would this (innermost) content line leave a paragraph open for lazy continuation? */
function paraOpenOf(c) {
  let t = c;
  for (;;) {
    if (isMarkerLine(t)) { t = stripMarkerLine(t); continue; }
    const sp = leadSpaces(t, 0, t.length);
    if (sp > 3) break;
    const mk = matchListMarker(t, sp, t.length);
    if (!mk) break;
    let j = sp + mk.len;
    while (j < t.length && (t[j] === ' ' || t[j] === '\t')) j++;
    if (j >= t.length) return false;
    t = t.slice(j);
  }
  if (t.trim() === '') return false;
  if (indentWidth(t, 0, t.length) >= 4) return false;
  return !lineStartsBlock(t, 0, t.length);
}

function scanBlockquote(lex, s) {
  const le0 = lineEnd(s, 0);
  const spG = leadSpaces(s, 0, le0);
  if (spG > 3 || s.charCodeAt(spG) !== C_GT) return null;
  const lines = splitLines(s);
  const first = lines[0];
  const sp0 = leadSpaces(s, first.start, first.end);
  if (sp0 > 3) return null;
  if (s.charCodeAt(first.start + sp0) !== C_GT) return null;
  // ---- collect raw lines
  const qlines = [];
  let openPara = false;
  let inFence = false, fenceCh = '', fenceRun = 0;
  let li = 0;
  for (; li < lines.length; li++) {
    const L = lines[li];
    const rawLine = s.slice(L.start, L.end);
    if (isMarkerLine(rawLine)) {
      qlines.push(rawLine);
      const txt = stripMarkerLine(rawLine);
      const deep = deepContent(txt);
      if (deep.trim() === '') { openPara = false; inFence = false; }
      else if (inFence) {
        let r = 0;
        const tt = deep.replace(/^ +/, '');
        while (tt[r] === fenceCh) r++;
        if (r >= fenceRun && /^ *$/.test(tt.slice(r))) inFence = false;
        openPara = false;
      } else {
        const fm = /^(`{3,}|~{3,})/.exec(deep.replace(/^ +/, ''));
        if (fm && indentWidth(deep, 0, deep.length) <= 3) {
          inFence = true; fenceCh = fm[1][0]; fenceRun = fm[1].length;
          openPara = false;
        } else {
          openPara = paraOpenOf(deep);
        }
      }
      continue;
    }
    if (isBlankRange(s, L.start, L.end)) {
      if (inFence) { qlines.push(rawLine); continue; }
      break;
    }
    if (inFence) {
      qlines.push(rawLine);
      const tt = rawLine.replace(/^ {0,3}/, '');
      let r = 0;
      while (tt[r] === fenceCh) r++;
      if (r >= fenceRun && /^ *$/.test(tt.slice(r))) inFence = false;
      continue;
    }
    if (openPara && !bqLazyStop(s, L.start, L.end)) {
      qlines.push(rawLine);
      continue;
    }
    break;
  }
  if (qlines.length === 0) return null;
  // ---- lex in segments with merging
  const tokens = [];
  const textParts = [];
  let qi = 0;
  let usedLines = 0;
  while (qi < qlines.length) {
    const seg = [];
    let seenMarker = false;
    while (qi < qlines.length) {
      const line = qlines[qi];
      if (isMarkerLine(line)) { seg.push(line); seenMarker = true; qi++; }
      else if (!seenMarker) { seg.push(line); qi++; }
      else break;
    }
    let h = seg.join('\n');
    h = h.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    const u = h.split('\n').map(stripMarkerLine).join('\n');
    textParts.push(u);
    const savedTop = lex.top;
    lex.top = true;
    blockTokens(lex, u, tokens, true);
    lex.top = savedTop;
    usedLines = qi;
    const last = tokens[tokens.length - 1];
    if (!last) break;
    if (last.type === 'code' || last.type === 'heading' || last.type === 'hr' || last.type === 'html' || last.type === 'table') break;
    if (last.type === 'blockquote' && qi < qlines.length) {
      const rest = qlines.slice(qi).map(stripMarkerLine).join('\n');
      const combined = last.raw + '\n' + rest;
      const sub = scanBlockquote(lex, combined);
      if (sub) {
        tokens[tokens.length - 1] = sub.token;
        textParts[textParts.length - 1] = combined.split('\n').map(stripMarkerLine).join('\n');
        if (sub.len >= combined.length) { usedLines = qlines.length; qi = qlines.length; break; }
        const consumedRest = combined.slice(0, sub.len).split('\n').length - last.raw.split('\n').length;
        qi += Math.max(0, consumedRest);
        usedLines = qi;
        if (qi < qlines.length && isMarkerLine(qlines[qi])) continue;
      }
      break;
    }
    if (last.type === 'list' && qi < qlines.length) {
      const restRaw = qlines.slice(qi);
      const combinedSrc = last.raw + '\n' + restRaw.join('\n');
      const sub = scanList(lex, combinedSrc);
      if (sub && sub.len > last.raw.length + 1) {
        const appended = combinedSrc.slice(last.raw.length + 1, sub.len);
        const f = appended === '' ? 0 : appended.split('\n').length;
        if (f > 0) {
          tokens[tokens.length - 1] = sub.token;
          textParts[textParts.length - 1] += '\n' + restRaw.slice(0, f).join('\n');
          qi += f;
          usedLines = qi;
        }
      }
    }
  }
  const rawLen = usedLines < lines.length ? lines[usedLines - 1].next : s.length;
  const inner = textParts.join('\n');
  return { len: rawLen, token: { type: 'blockquote', raw: s.slice(0, rawLen), tokens, text: inner } };
}

/**
 * List. Returns {len, token} or null.
 * Items are collected line-wise: content indented to the item's content
 * column is stripped and lexed recursively; unindented paragraph lines
 * may continue an item lazily.
 */


/** Expand tabs in a string to spaces, tab stops every 4 columns from col 0. */
function expandLineTabs(str) {
  if (!str.includes('\t')) return str;
  let out = '';
  let col = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\t') { const wdt = 4 - (col % 4); out += ' '.repeat(wdt); col += wdt; }
    else { out += str[i]; col++; }
  }
  return out;
}

/** marked's list begin-breaks: fence/heading/html/quote/hr/any-bullet starting at
 *  a space-indent < contentCol ends the item's content collection. */
function listBeginBreak(s, ls, le, contentCol) {
  let sp = 0;
  while (ls + sp < le && s.charCodeAt(ls + sp) === C_SP) sp++;
  if (sp > Math.min(contentCol - 1, 3)) return false;
  const i = ls + sp;
  if (i >= le) return false;
  const c = s.charCodeAt(i);
  if (c === 96 || c === 126) { // ` or ~ fence (3+)
    return s.charCodeAt(i + 1) === c && s.charCodeAt(i + 2) === c;
  }
  if (c === 35) { // # heading: 1-6 then ws/EOL
    let k = 0;
    while (s.charCodeAt(i + k) === 35 && k < 7) k++;
    if (k > 6) return false;
    const a = s.charCodeAt(i + k);
    return i + k >= le || a === C_SP || a === C_TAB;
  }
  if (c === 62) return true; // > blockquote
  if (c === 60) { // < html begin
    const rest = s.slice(i, le);
    if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![CDATA[')) return true;
    if (/^<![A-Za-z]/.test(rest)) return true;
    const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (tm) {
      const nm = tm[1].toLowerCase();
      if (nm === 'script' || nm === 'pre' || nm === 'style' || nm === 'textarea') {
        const a = rest.charCodeAt(tm[0].length);
        return tm[0].length >= rest.length || a === C_SP || a === C_TAB || a === 62 || a === 10;
      }
      if (BLOCK_TAGS.has(nm)) {
        const a = rest.charCodeAt(tm[0].length);
        return tm[0].length >= rest.length || a === C_SP || a === C_TAB || a === 62 || (a === 47 && rest.charCodeAt(tm[0].length + 1) === 62);
      }
    }
    return false;
  }
  if (c === 42 || c === 45 || c === 43) { // bullet, or hr (* / -)
    // hr: 3+ of same char with spaces/tabs between
    if (c !== 43 && isHrLine(s, ls, le)) return true;
    const a = s.charCodeAt(i + 1);
    return i + 1 >= le || a === C_SP || a === C_TAB;
  }
  if (c >= 49 && c <= 57) { // ordered bullet begin: \d{1,9}[.)]
    let k = 0;
    while (k < 9 && s.charCodeAt(i + k) >= 48 && s.charCodeAt(i + k) <= 57) k++;
    const d = s.charCodeAt(i + k);
    if (d === 46 || d === 41) {
      const a = s.charCodeAt(i + k + 1);
      return i + k + 1 >= le || a === C_SP || a === C_TAB;
    }
    return false;
  }
  if (c === 95 && isHrLine(s, ls, le)) return true; // _ hr
  return false;
}

/** begin tests against a stripped previous content line (marked tests m with the
 *  same regex family; only fence/heading/html/hr block a lazy continuation). */
function prevLineBlocksLazy(prevM, contentCol) {
  if (prevM == null) return false;
  // tabs count as 4 spaces for the deep-indent check
  let flat = 0, idx = 0;
  while (idx < prevM.length && (prevM[idx] === ' ' || prevM[idx] === '\t')) { flat += prevM[idx] === '\t' ? 4 : 1; idx++; }
  if (idx < prevM.length && flat >= 4) return true;
  // reuse the raw-line test on the string form
  return listBeginBreakStr(prevM, contentCol);
}

function listBeginBreakStr(str, contentCol) {
  let sp = 0;
  while (sp < str.length && str.charCodeAt(sp) === C_SP) sp++;
  if (sp > Math.min(contentCol - 1, 3)) return false;
  const c = str.charCodeAt(sp);
  if (c === 96 || c === 126) return str.charCodeAt(sp + 1) === c && str.charCodeAt(sp + 2) === c;
  if (c === 35) {
    let k = 0;
    while (str.charCodeAt(sp + k) === 35 && k < 7) k++;
    if (k > 6) return false;
    const a = str.charCodeAt(sp + k);
    return sp + k >= str.length || a === C_SP || a === C_TAB;
  }
  if (c === 60) {
    const rest = str.slice(sp);
    if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![CDATA[')) return true;
    if (/^<![A-Za-z]/.test(rest)) return true;
    const tm = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(rest);
    if (tm) {
      const nm = tm[1].toLowerCase();
      if (nm === 'script' || nm === 'pre' || nm === 'style' || nm === 'textarea') return true;
      if (BLOCK_TAGS.has(nm)) return true;
    }
    return false;
  }
  if ((c === 42 || c === 45 || c === 95) && str.split('').length) {
    // hr on the stripped line: 3+ same char ignoring spaces/tabs
    const t = str.replace(/[ \t]/g, '');
    if (t.length >= 3 && (t === '*'.repeat(t.length) || t === '-'.repeat(t.length) || t === '_'.repeat(t.length))) return true;
  }
  return false;
}

function scanList(lex, s) {
  const le0 = lineEnd(s, 0);
  const spG = leadSpaces(s, 0, le0);
  if (spG > 3 || !matchListMarker(s, spG, le0)) return null;
  const lines = splitLines(s);
  const L0 = lines[0];
  const sp0 = leadSpaces(s, L0.start, L0.end);
  if (sp0 > 3) return null;
  const m0 = matchListMarker(s, L0.start + sp0, L0.end);
  if (!m0) return null;
  const ordered = m0.ordered;
  const items = [];
  let loose = false;
  let li = 0;
  let listEnd = 0;
  while (li < lines.length) {
    const L = lines[li];
    if (isHrLine(s, L.start, L.end) && items.length > 0) break;
    const sp = leadSpaces(s, L.start, L.end);
    if (sp > 3) break;
    const mk = matchListMarker(s, L.start + sp, L.end);
    if (!mk || mk.ordered !== ordered) break;
    if (!ordered && mk.bull !== m0.bull) break;
    if (ordered && mk.bull[mk.bull.length - 1] !== m0.bull[m0.bull.length - 1]) break;
    // content column for this item
    const markerEnd = L.start + sp + mk.len;
    let j = markerEnd;
    let w = 0;
    while (j < L.end && isSpaceTab(s.charCodeAt(j))) { w += s.charCodeAt(j) === C_TAB ? 4 - ((colOf(s, L.start, j)) % 4) : 1; j++; }
    const restBlank = j >= L.end;
    const spaces = restBlank || w > 4 ? 1 : w;
    const contentCol = colOf(s, L.start, markerEnd) + spaces;
    const content = [];
    if (restBlank) content.push('');
    else content.push(stripColsStr(s, L.start, L.end, contentCol, markerEnd));
    let prevM = content[0];
    let itemEnd = L.end;
    let cur = li + 1;
    let itemBlankInside = false;
    let pendingBlanks = 0;
    let lastText = !restBlank;
    for (; cur < lines.length; cur++) {
      const CL = lines[cur];
      if (isBlankRange(s, CL.start, CL.end)) { pendingBlanks++; continue; }
      const csp = leadSpaces(s, CL.start, CL.end);
      const ccol = indentWidth(s, CL.start, CL.end);
      const cmk = csp <= 3 ? matchListMarker(s, CL.start + csp, CL.end) : null;
      if (cmk && cmk.ordered === ordered && (ordered ? cmk.bull[cmk.bull.length - 1] === m0.bull[m0.bull.length - 1] : cmk.bull === m0.bull) && csp <= Math.min(contentCol - 1, 3)) {
        if (pendingBlanks > 0) loose = true;
        break; // next item
      }
      if (restBlank && content.length === 1 && content[0] === '' && pendingBlanks > 0) {
        break;
      }
      // marked: a block-begin line (fence/heading/html/quote/hr/any bullet) at
      // space-indent < contentCol ends the item's content collection
      if (listBeginBreak(s, CL.start, CL.end, contentCol)) break;
      if (ccol >= contentCol) {
        if (pendingBlanks > 0) { itemBlankInside = true; for (let b = 0; b < pendingBlanks; b++) content.push(''); pendingBlanks = 0; }
        content.push(stripColsStr(s, CL.start, CL.end, contentCol));
        prevM = content[content.length - 1];
        itemEnd = CL.end;
        lastText = true;
        continue;
      }
      // dedented line: hr ends the list
      if (isHrLine(s, CL.start, CL.end)) break;
      if (pendingBlanks === 0 && lastText && !prevLineBlocksLazy(prevM, contentCol) && !bqLazyStop(s, CL.start, CL.end)) {
        content.push(s.slice(CL.start, CL.end));
        prevM = expandLineTabs(s.slice(CL.start, CL.end)).slice(contentCol);
        itemEnd = CL.end;
        continue;
      }
      break;
    }
    const emptyItemEnd = restBlank && content.length === 1 && content[0] === '' && pendingBlanks > 0;
    if (!emptyItemEnd) for (let b = 0; b < pendingBlanks; b++) content.push('');
    items.push({ content: content.join('\n') });
    listEnd = itemEnd;
    li = cur;
    if (cur >= lines.length) break;
    // if the stopping line is not a sibling marker, the list is over
    const NL = lines[cur];
    if (isHrLine(s, NL.start, NL.end)) break;
    const nsp = leadSpaces(s, NL.start, NL.end);
    const nmk = nsp <= 3 ? matchListMarker(s, NL.start + nsp, NL.end) : null;
    if (!nmk) break;
  }
  if (items.length === 0) return null;
  items[items.length - 1].content = items[items.length - 1].content.replace(/\n+$/, '');
  const start = ordered ? m0.start : 1;
  const itemToks = items.map((it) => {
    let task = false, checked = false;
    let text = it.content;
    const tm = /^\[([ xX])\][ \t]+(?=\S)/.exec(text);
    if (tm) { task = true; checked = tm[1] !== ' '; text = text.slice(tm[0].length); }
    const savedTop = lex.top;
    lex.top = false;
    const toks = blockTokens(lex, text, [], false);
    lex.top = savedTop;
    // an item with a blank line between two of its own top-level blocks
    // makes the whole list loose
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].type === 'space' && /\n.*\n/.test(toks[k].raw)) loose = true;
    }
    return { toks, task, checked };
  });
  return { len: listEnd, token: { type: 'list', raw: s.slice(0, listEnd), ordered, start, loose, items: itemToks } };
}

/* ------------------------------------------------------------------ inline */

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));

/** Find the `]` closing a link label opened at `open` (depth limit 2, code spans skipped). */
function findLabelEnd(s, open) {
  let depth = 1;
  let i = open + 1;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') {
      let run = 0;
      while (i + run < n && s[i + run] === '`') run++;
      // marked's label rule: a code unit is a backtick run, non-backtick
      // content, and a closing run of any length; a run of 2+ directly
      // before the closing bracket is also a unit; anything else fails
      if (run >= 2 && s[i + run] === ']') { i += run; continue; }
      const q = s.indexOf('`', i + run);
      if (q >= 0) {
        let r2 = 0;
        while (s[q + r2] === '`') r2++;
        i = q + r2;
        continue;
      }
      return -1;
    }
    if (c === '<') {
      const gt = s.indexOf('>', i + 1);
      const lt2 = s.indexOf('<', i + 1);
      if (gt > 0 && (lt2 < 0 || gt < lt2) && s[i + 1] !== ' ') { i = gt + 1; continue; }
      i++;
      continue;
    }
    if (c === '[') { depth++; if (depth > 3) return -1; i++; continue; }
    if (c === ']') { depth--; if (depth === 0) return i; i++; continue; }
    i++;
  }
  return -1;
}

/** Find a run of exactly `run` backticks at or after `from`; -1 if none. */
function findCodeClose(s, from, run) {
  let i = from;
  const n = s.length;
  while (i < n) {
    if (s[i] === '`') {
      let r = 0;
      while (i + r < n && s[i + r] === '`') r++;
      if (r === run) return i;
      i += r;
    } else i++;
  }
  return -1;
}

/** Parse `(dest "title")` starting at the `(`; returns {href, title, end} or null. */
function parseLinkDest(s, open) {
  const n = s.length;
  let i = open + 1;
  const skipWs = () => { while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  skipWs();
  let dest;
  if (i < n && s[i] === '<') {
    let j = i + 1;
    let ok = false;
    while (j < n) {
      const c = s[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '>') { ok = true; break; }
      if (c === '<' || c === '\n') break;
      j++;
    }
    if (!ok) return null;
    dest = s.slice(i + 1, j);
    i = j + 1;
  } else {
    const start = i;
    let depth = 0;
    while (i < n) {
      const c = s[i];
      if (c === '\\') { i += 2; continue; }
      const cc = s.charCodeAt(i);
      if (cc <= 0x20) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    dest = s.slice(start, i);
  }
  // optional title, separated by whitespace
  const beforeWs = i;
  skipWs();
  let title;
  if (i < n && s[i] !== ')') {
    if (i === beforeWs) return null;
    const t = scanInlineTitle(s, i);
    if (!t) return null;
    title = t.title;
    i = t.end;
    skipWs();
  }
  if (i >= n || s[i] !== ')') return null;
  return { href: dest, title, end: i + 1 };
}

/** Inline title: "..." | '...' | (...); escapes allowed, newlines allowed. */
function scanInlineTitle(s, at) {
  const n = s.length;
  const q = s[at];
  let close;
  if (q === '"') close = '"';
  else if (q === "'") close = "'";
  else if (q === '(') close = ')';
  else return null;
  let i = at + 1;
  while (i < n) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === close) return { title: s.slice(at + 1, i), end: i + 1 };
    if (q === '(' && c === '(') return null;
    i++;
  }
  return null;
}

const RE_AUTOLINK_SCHEME = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*)>/;
const RE_AUTOLINK_EMAIL = /^<([a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
const RE_TAG_NAME = /^[a-zA-Z][a-zA-Z0-9-]*/;
const RE_TAG_ATTR = /^\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?/;

/** Inline HTML tag starting at `i` (`<`); returns end offset or -1. */
function scanInlineTag(s, i) {
  const n = s.length;
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e < 0 ? -1 : e + 3;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e < 0 ? -1 : e + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    return e < 0 ? -1 : e + 3;
  }
  if (s.startsWith('<!', i)) {
    // <![A-Z]+ whitespace ... >
    let j = i + 2;
    const st = j;
    while (j < n && s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) j++;
    if (j === st) return -1;
    if (j >= n || !isWs(s.charCodeAt(j))) return -1;
    const e = s.indexOf('>', j);
    return e < 0 ? -1 : e + 1;
  }
  let j = i + 1;
  if (s[j] === '/') j++;
  const nm = RE_TAG_NAME.exec(s.slice(j, Math.min(n, j + 64)));
  if (!nm) return -1;
  j += nm[0].length;
  if (s[i + 1] === '/') {
    while (j < n && isWs(s.charCodeAt(j))) j++;
    return s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    const rest = s.slice(j);
    const am = RE_TAG_ATTR.exec(rest);
    if (am) { j += am[0].length; continue; }
    let k = j;
    while (k < n && isWs(s.charCodeAt(k))) k++;
    if (s[k] === '/' && s[k + 1] === '>') return k + 2;
    if (s[k] === '>') return k + 1;
    return -1;
  }
}

const RE_URL_SCHEME_Y = /(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//y;
const RE_EMAIL_DOMAIN_Y = /[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/y;
const RE_URL_EMAIL_Y = /[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/y;
const RE_URL_MAILTO_Y = /(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)/y;
function isEmailLocalCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 ||
    c === 43 || c === 45 || c === 46 || c === 47 || c === 61 || c === 63 || c === 94 ||
    c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126;
}

/** Trim an extended-autolink candidate the way GFM/marked backpedal does. */
const BP_PUNCT = new Set('?!.,:;*_\'"~)'.split(''));
const BP_PLAIN_EXCL = new Set('?!.,:;*_\'"~()&'.split(''));

/** One pass of marked's _backpedal: the longest consumable prefix. */
function backpedalOnce(u) {
  let i = 0;
  const n = u.length;
  while (i < n) {
    const c = u[i];
    if (c === '(') {
      const close = u.indexOf(')', i + 1);
      if (close < 0) break;
      i = close + 1; continue;
    }
    if (c === '&') {
      if (/^[a-zA-Z0-9]+;$/.test(u.slice(i + 1))) break;
      i++; continue;
    }
    if (BP_PUNCT.has(c)) {
      let j = i;
      while (j < n && BP_PUNCT.has(u[j])) j++;
      if (j >= n) { i = j - 1; break; }
      i = j; continue;
    }
    let j = i;
    while (j < n && !BP_PLAIN_EXCL.has(u[j])) j++;
    if (j === i) break;
    i = j;
  }
  return u.slice(0, i);
}

function trimAutolink(text) {
  let t = text, prev;
  do { prev = t; t = backpedalOnce(t); } while (t !== prev);
  return t;
}

/** Extended autolink at `i`; returns {text, href, end} or null. */
function scanUrl(s, i, emailEnds) {
  const c0 = s.charCodeAt(i);
  if (c0 === 109 || c0 === 120) { // 'm' | 'x': mailto: / xmpp: (case-sensitive)
    RE_URL_MAILTO_Y.lastIndex = i;
    const m = RE_URL_MAILTO_Y.exec(s);
    if (m) {
      const prev = i > 0 ? s[i - 1] : '';
      if (prev && /[a-zA-Z0-9]/.test(prev)) return null;
      return { text: m[0], href: m[0], end: i + m[0].length };
    }
  }
  if (c0 === 104 || c0 === 72 || c0 === 102 || c0 === 70) { // h H f F
    RE_URL_SCHEME_Y.lastIndex = i;
    const m = RE_URL_SCHEME_Y.exec(s);
    if (m) {
      let j = i;
      while (j < s.length && !isWs(s.charCodeAt(j)) && s[j] !== '<') j++;
      const raw = s.slice(i, j);
      const t = trimAutolink(raw);
      if (t.length <= m[0].length) return null;
      return { text: t, href: t, end: i + t.length };
    }
  }
  if (c0 === 119 && s.startsWith('www.', i)) { // 'w'
    const prev = i > 0 ? s[i - 1] : null;
    if (prev !== null && !/[\s*_~(]/.test(prev)) return null;
    let j = i;
    while (j < s.length && !isWs(s.charCodeAt(j)) && s[j] !== '<') j++;
    const raw = s.slice(i, j);
    const t = trimAutolink(raw);
    if (t.length <= 4) return null;
    return { text: t, href: 'http://' + t, end: i + t.length };
  }
  // email: precomputed per renderInline call (map start -> end), exact because
  // for a fixed '@' the domain match is independent of the local-part start
  if (emailEnds) {
    const ee = emailEnds.get(i);
    if (ee !== undefined) return { text: s.slice(i, ee), href: 'mailto:' + s.slice(i, ee), end: ee };
  }
  return null;
}

function isWsCh(ch) { return ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'; }
function isPunctCh(ch) {
  if (ch === undefined) return false;
  if (ch === '~') return false;
  return RE_PUNCT.test(ch);
}
function isPunctChT(ch) { // tilde counts as punctuation here (marked's (?!)~ variants differ per side)
  if (ch === undefined) return false;
  return RE_PUNCT.test(ch);
}

/** Try a link/image whose `[` is at `open`. Returns {html, end} or null. */
function tryLink(s, open, isImage, lex, inLink, forAlt) {
  const labelEnd = findLabelEnd(s, open);
  if (labelEnd < 0) return null;
  const label = s.slice(open + 1, labelEnd);
  if (!isImage) {
    // link text may not itself contain a link or autolink: the inner
    // construct wins and the outer brackets stay literal
    for (let k = 0; k < label.length; k++) {
      const lc = label[k];
      if (lc === '!' && label[k + 1] === '[') {
        const im = tryLink(label, k + 1, true, lex, false, false);
        if (im) { k = im.end - 1; continue; }
      } else if (lc === '[') {
        if (tryLink(label, k, false, lex, false, false)) return null;
      } else if (lc === '\\') k++;
    }
  }
  const after = labelEnd + 1;
  let href, title, end;
  if (s[after] === '(') {
    const d = parseLinkDest(s, after);
    if (!d) {
      const key = normLabel(label.replace(/\\([\[\]])/g, '$1'));
      const link = lex.links[key];
      if (!link) return null;
      href = link.href; title = link.title; end = after;
    } else {
      href = d.href; title = d.title; end = d.end;
    }
  } else {
    let refLabel = null;
    if (s[after] === '[') {
      const refEnd = findLabelEnd(s, after);
      if (refEnd < 0) return null;
      const rl = s.slice(after + 1, refEnd);
      refLabel = rl === '' ? label : rl;
      end = refEnd + 1;
    } else {
      refLabel = label;
      end = after;
    }
    const key = normLabel(refLabel.replace(/\\([\[\]])/g, '$1'));
    const link = lex.links[key];
    if (!link) return null;
    href = link.href; title = link.title;
  }
  const clean = encodeHref(unescapePunct(href));
  if (clean === null) return null;
  const hrefAttr = esc(clean, false);
  const titleAttr = title === undefined ? '' : ' title="' + esc(unescapePunct(title), false) + '"';
  if (forAlt) {
    return { html: renderInline(label, lex, true, true), end };
  }
  if (isImage) {
    const alt = renderInline(label, lex, true, true);
    return { html: '<img src="' + hrefAttr + '" alt="' + esc(alt, false) + '"' + titleAttr + '>', end };
  }
  const inner = renderInline(label, lex, true);
  return { html: '<a href="' + hrefAttr + '"' + titleAttr + '>' + inner + '</a>', end };
}

/** Try a ~~del~~ / ~del~ at `i`. Returns {html, end} or null. */
function tryDel(s, i, lex, inLink) {
  let run = 0;
  while (s[i + run] === '~') run++;
  if (run > 2) return null;
  const after = s[i + run];
  if (after === undefined || isWsCh(after) || after === '~') return null;
  // find closing run of same length, content not ending in space/~
  let j = i + run;
  const n = s.length;
  while (j < n) {
    if (s[j] === '\\') { j += 2; continue; }
    if (s[j] === '~') {
      let r = 0;
      while (s[j + r] === '~') r++;
      if (r === run) {
        const prevCh = s[j - 1];
        const nextCh = s[j + r];
        if (!isWsCh(prevCh) && prevCh !== '~' && (nextCh === undefined || nextCh !== '~')) {
          const content = s.slice(i + run, j);
          if (content.length > 0) {
            return { html: '<del>' + renderInline(content, lex, inLink) + '</del>', end: j + r };
          }
        }
      }
      j += r;
      continue;
    }
    j++;
  }
  return null;
}

/** Render inline markdown `src` to HTML. `lex` carries the link definitions. */
const RE_PUNCTSYM = /[\p{P}\p{S}]/u;
const RE_ALNUM_U = /[\p{L}\p{N}]/u;
function cpAt(s, i) {
  const c = s.charCodeAt(i);
  return c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length ? s.slice(i, i + 2) : s[i];
}
function isPunctSymCh(ch) { return !!ch && RE_PUNCTSYM.test(ch); }
function isWsJS(ch) { return !!ch && /\s/.test(ch); }

/** End (exclusive) of a parenthesised link destination starting at `open`, or -1. */
function scanParenEnd(s, open) {
  let depth = 1, i = open + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '(') { depth++; if (depth > 2) return -1; i++; continue; }
    if (c === ')') { depth--; if (depth === 0) return i + 1; i++; continue; }
    i++;
  }
  return -1;
}

/**
 * End of a link label for masking purposes: no nested brackets (code spans
 * are skipped atomically). Returns the index of the closing `]` or -1.
 */
function maskLabelEnd(s, open) {
  let i = open + 1;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '`') {
      let run = 0;
      while (s[i + run] === '`') run++;
      const close = findCodeClose(s, i + run, run);
      if (close < 0) return -1;
      i = close + run;
      continue;
    }
    if (c === '[') return -1;
    if (c === ']') return i;
    i++;
  }
  return -1;
}

/**
 * Build a same-length masked copy of the inline source in which regions that
 * cannot carry emphasis delimiters (code spans, link constructs, tags,
 * escapes) are replaced by [aaa...] / ++ placeholders.
 */
const MASK_PUNCT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_SKIP_RE = /\[(?:[^\[\]`]|(`+)[^`]+\1(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(`+)[^`]+\3(?!`)|<(?! )[^<>]*?>/g;
const REFLINK_SEARCH_RE = /!?\[((?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?)\]\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\]|!?\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999})\](?:\[\])?(?!\()/g;

function labelKey(raw) {
  return normLabel(raw.replace(/\\([\[\]])/g, '$1'));
}

/** marked's linkInText: does this text contain a link construct? */
function maskLinkInText(e, lex) {
  if (!e.includes('[')) return false;
  MASK_SKIP_RE.lastIndex = 0;
  for (const m of e.matchAll(MASK_SKIP_RE)) {
    if (e.charAt(m.index - 1) === '!') continue;
    if (m[0].charCodeAt(0) !== 91) continue;
    const le = findLabelEnd(e, m.index);
    if (le >= 0 && e.charAt(le + 1) === '(' && tryLink(e, m.index, false, lex, false, false)) return true;
  }
  REFLINK_SEARCH_RE.lastIndex = 0;
  for (const m of e.matchAll(REFLINK_SEARCH_RE)) {
    const r = m[0];
    if (r.charAt(0) === '!') continue;
    const o = r.lastIndexOf('[');
    if (!lex.links[labelKey(r.slice(o + 1, -1))]) continue;
    if (o > 1 && maskLinkInText(r.slice(1, o - 1), lex)) continue;
    return true;
  }
  return false;
}

/** marked's emStrong mask: reflink pass, punctuation/code pass, block-skip pass. */
function buildMask(src, lex) {
  let t = src;
  if (t.includes('[')) {
    const s = (r) => {
      const o = r.lastIndexOf('[');
      if (!lex.links[labelKey(r.slice(o + 1, -1))]) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (maskLinkInText(inner, lex)) {
          return '[' + inner.replace(REFLINK_SEARCH_RE, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(REFLINK_SEARCH_RE, s);
  }
  t = t.replace(MASK_PUNCT_RE, (m, g1, g2) => g2 ? '+'.repeat(m.length) : g1 ? g1 + m.slice(g1.length, -g1.length).replace(/`/g, '+') + g1 : m);
  t = t.replace(MASK_SKIP_RE, (m) => '[' + 'a'.repeat(Math.max(0, m.length - 2)) + ']');
  return t;
}

/** Last index of a possibly-closing delimiter run per char, marked-style. */
function lastCloserIdx(mask) {
  const res = { '*': -1, '_': -1, '~': -1 };
  const n = mask.length;
  for (let s = 0; s < n; s++) {
    const r = mask[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    let i = s + 1;
    while (i < n && mask[i] === r) i++;
    const prev = s === 0 ? '\n' : mask[s - 1];
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') res[r] = s;
    s = i - 1;
  }
  return res;
}

/**
 * The special first alternative of the closing-delimiter scan: a doubled
 * delimiter of the other kind, then a single delimiter of this kind, ending
 * just before another doubled delimiter. Returns the end index or -1.
 */
function tryAlt1(t, pos, ch) {
  const pair = ch === '*' ? '_' : '*';
  const n = t.length;
  let j = pos;
  while (j < n && t[j] !== '*' && t[j] !== '_') {
    if (t[j] === pair && t[j + 1] === pair) break;
    j++;
  }
  if (j >= n || t[j] !== pair || t[j + 1] !== pair) return -1;
  let j2 = j + 2;
  while (j2 < n && t[j2] !== '*' && t[j2] !== '_') j2++;
  if (j2 >= n || t[j2] !== ch) return -1;
  let j3 = j2 + 1;
  while (j3 < n && t[j3] !== '*' && t[j3] !== '_') j3++;
  if (j3 < n && t[j3] === pair && t[j3 + 1] === pair) return j3;
  return -1;
}

/** Classify a closing-delimiter candidate run by its surrounding characters. */
function classifyRun(t, pos, ch) {
  const c0 = cpAt(t, pos);
  const ctxLen = c0.length;
  const rs = pos + ctxLen;
  let b = 0;
  while (t[rs + b] === ch) b++;
  if (b === 0) return null;
  const c2 = rs + b < t.length ? cpAt(t, rs + b) : '';
  const c0W = isWsJS(c0), c0P = isPunctSymCh(c0), c0Word = !c0W && !c0P;
  const isW = c2 !== '' && isWsJS(c2), isP = isPunctSymCh(c2), isWord = c2 !== '' && !isW && !isP;
  let g = 0;
  if (ch === '*') {
    if (c0P && c0 !== '~' && (c2 === '' || isW)) g = 1;
    else if ((c0Word || c0 === '~') && (c2 === '' || (c2 !== '~' && (isW || isP)))) g = 2;
    else if ((c0W || c0P) && c0 !== '~' && (isWord || c2 === '~')) g = 3;
    else if (c0W && isP && c2 !== '~') g = 4;
    else if (c0P && c0 !== '~' && isP && c2 !== '~') g = 5;
    else if ((c0Word || c0 === '~') && (isWord || c2 === '~')) g = 6;
  } else {
    if (c0P && (c2 === '' || isW)) g = 1;
    else if (c0Word && (c2 === '' || isW || isP)) g = 2;
    else if ((c0W || c0P) && isWord) g = 3;
    else if (c0W && isP) g = 4;
    else if (c0P && isP) g = 5;
  }
  return g === 0 ? null : { g, b, ctxLen };
}

/**
 * Marked's em/strong matching at a `*`/`_` run starting at `start` in `src`
 * (structure read from `mask`). Returns {end, kind, innerStart, innerEnd}.
 */
function markedEmStrong(src, mask, start, nCharIn, lastC) {
  const ch = src[start];
  let runLen = 0;
  while (src[start + runLen] === ch) runLen++;
  const afterCh = start + runLen < src.length ? cpAt(src, start + runLen) : '';
  let gPunct = '', gOther = '';
  if (afterCh) {
    if (afterCh !== ch && afterCh !== '~' && isPunctSymCh(afterCh)) gPunct = afterCh;
    else if (!isWsJS(afterCh) && afterCh !== ch) gOther = afterCh;
  }
  if (!gPunct && !gOther) return null;
  let l = start;
  while (l > 0 && mask[l - 1] === ch) l--;
  let p = '';
  if (l > 0) {
    p = mask[l - 1];
    if (l >= 2) {
      const cc = mask.charCodeAt(l - 1);
      if (cc >= 0xDC00 && cc <= 0xDFFF) p = mask.slice(l - 2, l);
    }
  }
  const punct2 = (x) => x !== '' && x !== '*' && x !== '_' && /[\s\p{P}\p{S}]/u.test(x);
  const h = p === '*' || p === '_' || punct2(p);
  const o = nCharIn === ch;
  let n = nCharIn;
  if (l < start) n = p;
  const u = l < start ? h : punct2(n);
  if (ch === '_' && gOther && RE_ALNUM_U.test(n)) return null;
  const d = gPunct;
  if (!(d === '' || n === '' || u)) return null;
  const k = runLen;
  const R = p !== '' && !isWsJS(p) && (d !== '' || (ch === '*' && !h));
  const y = (start - l) + k;
  const v = lastC[ch];
  const Q = start + k;
  if (v < Q) return null;
  const ee = v - Q;
  const t = mask.slice(Q);
  const tn = t.length;
  let m = k, f = 0, pos = 0;
  while (pos < tn) {
    if (pos > ee) return null;
    if (pos === 0) {
      const a1 = tryAlt1(t, 0, ch);
      if (a1 > 0) { pos = a1; continue; }
    }
    if (t[pos] !== ch) {
      let L = 0;
      while (pos + L < tn && t[pos + L] !== ch) L++;
      if (L >= 2) { pos += L - 1; continue; }
      if (pos + 1 < tn && t[pos + 1] === ch) {
        const r = classifyRun(t, pos, ch);
        if (r) {
          if (pos > ee) return null;
          const { g, b, ctxLen } = r;
          let done = null;
          if (g === 3 || g === 4) {
            m += b;
          } else {
            let skipped = false;
            if (g === 5 || g === 6 || R) {
              if (o && (g === 5 || g === 6)) return null;
              if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; skipped = true; }
            }
            if (!skipped) {
              m -= b;
              if (m <= 0) {
                const bUse = Math.min(b, b + m + f);
                const rawEnd = start + k + pos + ctxLen + bUse;
                const use = Math.min(k, bUse) % 2 === 1 ? 1 : 2;
                done = { end: rawEnd, kind: use === 1 ? 'em' : 'strong', innerStart: start + use, innerEnd: rawEnd - use };
              }
            }
          }
          if (done) return done;
          pos = pos + ctxLen + b;
          continue;
        }
      }
      pos++;
      continue;
    }
    pos++;
  }
  return null;
}

/** Classify a closing `~` candidate (run length capped at 2). */
function classifyDel(t, pos) {
  const c0 = cpAt(t, pos);
  const ctxLen = c0.length;
  const rs = pos + ctxLen;
  let run = 0;
  while (t[rs + run] === '~') run++;
  if (run === 0 || run > 2) return null;
  const b = run;
  const c2 = rs + b < t.length ? cpAt(t, rs + b) : '';
  const c0W = isWsJS(c0), c0P = isPunctSymCh(c0), c0Word = !c0W && !c0P;
  const isW = c2 !== '' && isWsJS(c2), isP = isPunctSymCh(c2), isWord = c2 !== '' && !isW && !isP;
  let g = 0;
  if (c0P && c0 !== '~' && (c2 === '' || isW)) g = 1;
  else if (c0Word && (c2 === '' || isW || isP)) g = 2;
  else if ((c0W || c0P) && c0 !== '~' && isWord) g = 3;
  else if (c0W && isP && c2 !== '~') g = 4;
  else if (c0P && c0 !== '~' && isP && c2 !== '~') g = 5;
  else if (c0Word && isWord) g = 6;
  return g === 0 ? null : { g, b, ctxLen };
}

/** Marked's del matching at a `~` run starting at `start`. */
function markedDel(src, mask, start, nCharIn, lastC) {
  let runLen = src[start + 1] === '~' ? 2 : 1;
  const afterCh = start + runLen < src.length ? cpAt(src, start + runLen) : '';
  let gPunct = '', gOther = '';
  if (afterCh) {
    if (afterCh !== '~' && isPunctSymCh(afterCh)) gPunct = afterCh;
    else if (!isWsJS(afterCh) && afterCh !== '~') gOther = afterCh;
  }
  if (!gPunct && !gOther) return null;
  const punct2 = (x) => x !== '' && x !== '*' && x !== '_' && /[\s\p{P}\p{S}]/u.test(x);
  if (!(gPunct === '' || nCharIn === '' || punct2(nCharIn))) return null;
  const o = runLen;
  const u = lastC['~'];
  const d0 = start + o;
  if (u < d0) return null;
  const ee = u - d0;
  const t = mask.slice(d0);
  const tn = t.length;
  let p = o, pos = 0;
  while (pos < tn) {
    if (pos > ee) return null;
    if (t[pos] !== '~') {
      let L = 0;
      while (pos + L < tn && t[pos + L] !== '~') L++;
      if (L >= 2) { pos += L - 1; continue; }
      if (pos + 1 < tn && t[pos + 1] === '~') {
        const r = classifyDel(t, pos);
        if (r) {
          if (pos > ee) return null;
          const { g, b, ctxLen } = r;
          if (b === o) {
            if (g === 3 || g === 4) {
              p += b;
            } else {
              p -= b;
              if (p <= 0) {
                const lUse = Math.min(b, b + p);
                const rawEnd = start + o + pos + ctxLen + lUse;
                return { end: rawEnd, innerStart: start + o, innerEnd: rawEnd - o };
              }
            }
          }
          pos = pos + ctxLen + b;
          continue;
        }
      }
      pos++;
      continue;
    }
    pos++;
  }
  return null;
}

function buildEmailEnds(src) {
  const map = new Map();
  let a = src.indexOf('@');
  while (a >= 0) {
    let rs = a;
    while (rs > 0 && isEmailLocalCode(src.charCodeAt(rs - 1))) rs--;
    if (rs < a) {
      RE_EMAIL_DOMAIN_Y.lastIndex = a + 1;
      const m = RE_EMAIL_DOMAIN_Y.exec(src);
      if (m) {
        const end = a + 1 + m[0].length;
        const after = src[end];
        if (after !== '-' && after !== '_') {
          for (let p = rs; p < a; p++) {
            const c = src.charCodeAt(p);
            if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) map.set(p, end);
          }
        }
      }
    }
    a = src.indexOf('@', a + 1);
  }
  return map;
}

function renderInline(src, lex, inLink, forAlt) {
  const emailEnds = src.includes('@') ? buildEmailEnds(src) : null;
  const nodes = [];
  let text = '';
  let nChar = '';
  const hasEm = src.includes('*') || src.includes('_');
  const mask = hasEm ? buildMask(src, lex) : src;
  const lastC = hasEm ? lastCloserIdx(mask) : { '*': -1, '_': -1 };
  let segStart = -1, segEnd = -1;
  const flushSeg = () => { if (segStart >= 0) { text += src.slice(segStart, segEnd); segStart = -1; segEnd = -1; } };
  const litAt = (p) => { if (segEnd === p) segEnd = p + 1; else { flushSeg(); segStart = p; segEnd = p + 1; } };
  const litRange = (a, b) => { if (segEnd === a) segEnd = b; else { flushSeg(); segStart = a; segEnd = b; } };
  const flush = () => { flushSeg(); if (text) { nChar = text[text.length - 1]; nodes.push({ t: 'text', s: text }); text = ''; } };
  const pushHtml = (html) => { flush(); nodes.push({ t: 'raw', s: html }); nChar = ''; };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { if (!forAlt) pushHtml('<br>'); i += 2; while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; continue; }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) {
        if (nx === '&' || nx === '<' || nx === '>' || nx === '"' || nx === "'") {
          if (forAlt) { flush(); nodes.push({ t: 'rawtext', s: nx }); }
          else pushHtml(esc(nx, false));
        }
        else litAt(i + 1);
        i += 2; continue;
      }
      litAt(i); i++; continue;
    }
    if (c === '`') {
      let run = 0;
      while (src[i + run] === '`') run++;
      const close = findCodeClose(src, i + run, run);
      if (close < 0) { litRange(i, i + run); i += run; continue; }
      let content = src.slice(i + run, close);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      if (forAlt) { flush(); nodes.push({ t: 'rawtext', s: content }); }
      else pushHtml('<code>' + esc(content, true) + '</code>');
      i = close + run;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      const r = tryLink(src, i + 1, true, lex, inLink, forAlt);
      if (r) { pushHtml(r.html); i = r.end; continue; }
      litAt(i); i++; continue;
    }
    if (c === '[') {
      if (!inLink || forAlt) {
        const r = tryLink(src, i, false, lex, inLink, forAlt);
        if (r) { pushHtml(r.html); i = r.end; continue; }
      }
      litAt(i); i++; continue;
    }
    if (c === '<') {
      const rest = src.slice(i, i + 1024);
      let m = RE_AUTOLINK_SCHEME.exec(rest);
      if (m) {
        const clean = encodeHref(m[1]);
        if (clean !== null) {
          if (forAlt) { flush(); nodes.push({ t: 'rawtext', s: decodeEntities(m[1]) }); }
          else pushHtml('<a href="' + esc(clean, false) + '">' + esc(decodeEntities(m[1]), false) + '</a>');
          i += m[0].length; continue;
        }
      }
      m = RE_AUTOLINK_EMAIL.exec(rest);
      if (m) {
        if (forAlt) { flush(); nodes.push({ t: 'rawtext', s: decodeEntities(m[1]) }); }
        else pushHtml('<a href="mailto:' + esc(m[1], false) + '">' + esc(decodeEntities(m[1]), false) + '</a>');
        i += m[0].length; continue;
      }
      const tagEnd = scanInlineTag(src, i);
      if (tagEnd > 0) {
        const tagText = src.slice(i, tagEnd);
        if (!lex.noUrl && /^<a /i.test(tagText)) lex.noUrl = true;
        else if (lex.noUrl && /^<\/a>/i.test(tagText)) lex.noUrl = false;
        if (!forAlt) pushHtml(tagText);
        i = tagEnd; continue;
      }
      litAt(i); i++; continue;
    }
    if (c === '*' || c === '_') {
      flush();
      const r = markedEmStrong(src, mask, i, nChar, lastC);
      if (r) {
        const innerHtml = renderInline(src.slice(r.innerStart, r.innerEnd), lex, inLink, forAlt);
        if (forAlt) { nodes.push({ t: 'rawtext', s: innerHtml }); nChar = ''; }
        else pushHtml(r.kind === 'em' ? '<em>' + innerHtml + '</em>' : '<strong>' + innerHtml + '</strong>');
        i = r.end;
        continue;
      }
      litAt(i); i++; continue;
    }
    if (c === '~') {
      flush();
      const r = markedDel(src, mask, i, nChar, lastC);
      if (r) {
        const innerHtml = renderInline(src.slice(r.innerStart, r.innerEnd), lex, inLink, forAlt);
        if (forAlt) { nodes.push({ t: 'rawtext', s: innerHtml }); nChar = ''; }
        else pushHtml('<del>' + innerHtml + '</del>');
        i = r.end;
        continue;
      }
      litAt(i); i++; continue;
    }
    if (c === ' ') {
      let run = 0;
      while (src[i + run] === ' ') run++;
      if (run >= 2 && src[i + run] === '\n') {
        const after = src.slice(i + run + 1);
        if (!/^\s*$/.test(after)) {
          if (!forAlt) pushHtml('<br>');
          i += run + 1;
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          continue;
        }
      }
      litRange(i, i + run); i += run; continue;
    }
    if (!inLink && !lex.noUrl && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))) {
      const cc0 = src.charCodeAt(i);
      const u = (cc0 === 104 || cc0 === 72 || cc0 === 102 || cc0 === 70 || cc0 === 119 || cc0 === 109 || cc0 === 120 || (emailEnds !== null && emailEnds.has(i)))
        ? scanUrl(src, i, emailEnds) : null;
      if (u) {
        const clean = encodeHref(u.href);
        if (clean !== null) {
          if (forAlt) { flush(); nodes.push({ t: 'rawtext', s: decodeEntities(u.text) }); }
          else pushHtml('<a href="' + esc(clean, false) + '">' + esc(decodeEntities(u.text), false) + '</a>');
          i = u.end; continue;
        }
      }
    }
    litAt(i); i++;
  }
  flush();
  processDelims(nodes);
  return renderNodes(nodes, forAlt);
}

function renderNodes(nodes, forAlt) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'rawtext') out += nd.s;
    else if (nd.t === 'text') out += forAlt ? decodeEntities(nd.s) : esc(decodeEntities(nd.s), false);
    else if (nd.t === 'raw') out += nd.s;
    else if (nd.t === 'delim') out += nd.ch.repeat(nd.len);
    else if (nd.t === 'em') out += forAlt ? renderNodes(nd.kids, forAlt) : '<em>' + renderNodes(nd.kids) + '</em>';
    else if (nd.t === 'del') out += forAlt ? renderNodes(nd.kids, forAlt) : '<del>' + renderNodes(nd.kids) + '</del>';
    else if (nd.t === 'strong') out += forAlt ? renderNodes(nd.kids, forAlt) : '<strong>' + renderNodes(nd.kids) + '</strong>';
  }
  return out;
}

/** CommonMark-style delimiter matching for * and _. */
function processDelims(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const closer = nodes[ci];
    if (closer.t !== 'delim' || !closer.canClose || closer.len === 0) { ci++; continue; }
    // find nearest opener below
    let oi = ci - 1;
    let wrapped = false;
    while (oi >= 0) {
      const opener = nodes[oi];
      if (opener.t === 'delim' && opener.ch === closer.ch && opener.canOpen && opener.len > 0) {
        if (closer.ch === '~') {
          if (opener.len !== closer.len) { oi--; continue; }
          const use = closer.len;
          opener.len = 0;
          closer.len = 0;
          const kids = nodes.splice(oi + 1, ci - oi - 1);
          nodes.splice(oi + 1, 0, { t: 'del', kids });
          ci = oi + 2;
          wrapped = true;
          break;
        }
        const odd = (closer.canOpen || opener.canClose) &&
          (opener.len + closer.len) % 3 === 0 && !(opener.len % 3 === 0 && closer.len % 3 === 0);
        if (odd) { oi--; continue; }
        const use = opener.len >= 2 && closer.len >= 2 ? 2 : 1;
        opener.len -= use;
        closer.len -= use;
        const kids = nodes.splice(oi + 1, ci - oi - 1);
        const node = { t: use === 2 ? 'strong' : 'em', kids };
        nodes.splice(oi + 1, 0, node);
        ci = oi + 2; // closer shifted here; retry it if it still has length
        wrapped = true;
        break;
      }
      oi--;
    }
    if (!wrapped) ci++;
  }
}

/* ---------------------------------------------------------------- renderer */

function renderTableCell(content, align, tag, lex) {
  const attr = align ? ' align="' + align + '"' : '';
  return '<' + tag + attr + '>' + renderInline(content, lex, false) + '</' + tag + '>\n';
}

function renderBlocks(tokens, lex) {
  let out = '';
  for (const tok of tokens) {
    switch (tok.type) {
      case 'space':
      case 'def':
        break;
      case 'code': {
        const lang = tok.lang ? tok.lang.split(' ')[0] : '';
        const cls = lang ? ' class="language-' + esc(lang, false) + '"' : '';
        const ct = tok.text.endsWith('\n') ? tok.text.slice(0, -1) : tok.text;
        out += '<pre><code' + cls + '>' + esc(ct, true) + (tok.text ? '\n' : '') + '</code></pre>\n';
        break;
      }
      case 'heading':
        out += '<h' + tok.depth + '>' + renderInline(tok.text, lex, false) + '</h' + tok.depth + '>\n';
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += tok.text;
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(tok.tokens, lex) + '</blockquote>\n';
        break;
      case 'list':
        out += renderList(tok, lex);
        break;
      case 'table': {
        out += '<table>\n<thead>\n<tr>\n';
        for (let k = 0; k < tok.header.length; k++) out += renderTableCell(tok.header[k], tok.aligns[k], 'th', lex);
        out += '</tr>\n</thead>\n';
        if (tok.rows.length > 0) {
          out += '<tbody>';
          for (const rowLine of tok.rows) {
            const cells = splitRow(rowLine);
            out += '<tr>\n';
            for (let k = 0; k < tok.aligns.length; k++) out += renderTableCell(cells[k] ?? '', tok.aligns[k], 'td', lex);
            out += '</tr>\n';
          }
          out += '</tbody>';
        }
        out += '</table>\n';
        break;
      }
      case 'paragraph':
        out += '<p>' + renderInline(tok.text, lex, false) + '</p>\n';
        break;
      case 'text':
        out += renderInline(tok.text, lex, false);
        break;
      default:
        break;
    }
  }
  return out;
}

function renderList(tok, lex) {
  let out = tok.ordered
    ? (tok.start !== 1 ? '<ol start="' + tok.start + '">\n' : '<ol>\n')
    : '<ul>\n';
  for (const item of tok.items) {
    out += '<li>';
    if (tok.loose) {
      let body = '';
      for (const t of item.toks) {
        if (t.type === 'text') body += '<p>' + renderInline(t.text, lex, false) + '</p>\n';
        else body += renderBlocks([t], lex);
      }
      if (item.task) body = injectCheckbox(body, item.checked);
      out += body + '</li>\n';
    } else {
      let body = '';
      for (const t of item.toks) {
        if (t.type === 'paragraph' || t.type === 'text') body += renderInline(t.text, lex, false);
        else if (t.type === 'space' || t.type === 'def') continue;
        else body += renderBlocks([t], lex);
      }
      if (item.task) body = injectCheckbox(body, item.checked);
      out += body + '</li>\n';
    }
  }
  out += tok.ordered ? '</ol>\n' : '</ul>\n';
  return out;
}

/** Prepend a task-list checkbox to rendered item content (inside <p> when present). */
function injectCheckbox(body, checked) {
  const box = checked
    ? '<input checked="" disabled="" type="checkbox"> '
    : '<input disabled="" type="checkbox"> ';
  if (body.startsWith('<p>')) return '<p>' + box + body.slice(3);
  return box + body;
}

/** Parse a Markdown document to HTML, byte-identical to marked 18.1.3 defaults. */
export function parse(markdown) {
  let src = String(markdown);
  // marked normalizes: CRLF/CR -> LF, tabs handled by tokenizers, NBSP -> space
  src = src.replace(/\r\n?/g, '\n');
  // trim trailing blank lines per marked's preprocessing (keeps behaviour at edges)
  const lex = newLexer();
  const tokens = blockTokens(lex, src, [], false);
  return renderBlocks(tokens, lex);
}
