// 문서에서 텍스트를 뽑는다. AI API가 직접 읽지 못하는 형식(HWP, HWPX, DOCX, 텍스트)을 담당.
// PDF·이미지·음성은 AI에 파일 그대로 보낸다(ai.js).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const CFB = require('cfb');
const { unzipSync, strFromU8 } = require('fflate');

const MAX_CHARS = 200_000; // AI에 보낼 최대 글자 수

// ---------------- HWP 5.x (한글 97 이후 바이너리) ----------------
// 구조: OLE 복합 파일. FileHeader / BodyText/SectionN (보통 raw deflate 압축) 레코드의 PARA_TEXT(태그 67)에 본문.
const HWPTAG_PARA_TEXT = 67;
// 제어 문자: 1글자짜리(그대로 또는 줄바꿈), 나머지는 8글자(16바이트) 차지하는 인라인/확장 제어
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);

function paraText(buf) {
  let out = '';
  for (let i = 0; i + 1 < buf.length; ) {
    const c = buf.readUInt16LE(i);
    if (c < 32) {
      if (CHAR_CTRL.has(c)) {
        if (c === 10 || c === 13) out += '\n';
        else if (c === 30 || c === 31) out += ' ';
        else if (c === 24) out += '-';
        i += 2;
      } else {
        if (c === 9) out += '\t';
        i += 16; // 인라인·확장 제어는 8 WCHAR
      }
    } else {
      out += String.fromCharCode(c);
      i += 2;
    }
  }
  return out;
}

function recordsText(buf) {
  const parts = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const h = buf.readUInt32LE(p);
    p += 4;
    const tag = h & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) { if (p + 4 > buf.length) break; size = buf.readUInt32LE(p); p += 4; }
    if (p + size > buf.length) break;
    if (tag === HWPTAG_PARA_TEXT) parts.push(paraText(buf.subarray(p, p + size)));
    p += size;
  }
  return parts.join('\n');
}

function extractHwp(buf) {
  const doc = CFB.read(buf, { type: 'buffer' });
  const get = (re) => doc.FullPaths.map((fp, i) => ({ fp, e: doc.FileIndex[i] })).filter((x) => re.test(x.fp) && x.e.content);
  const header = get(/\/FileHeader$/)[0];
  if (!header) throw new Error('HWP 파일 형식이 아닙니다');
  const hb = Buffer.from(header.e.content);
  if (!hb.toString('latin1', 0, 17).startsWith('HWP Document File')) throw new Error('HWP 5.0 이상 파일만 읽을 수 있습니다');
  const flags = hb.readUInt32LE(36);
  const compressed = !!(flags & 1), encrypted = !!(flags & 2), distribution = !!(flags & 4);
  if (encrypted) throw new Error('암호가 걸린 HWP 파일은 읽을 수 없습니다');

  let text = '';
  if (!distribution) {
    const sections = get(/\/BodyText\/Section\d+$/)
      .sort((a, b) => Number(a.fp.match(/(\d+)$/)[1]) - Number(b.fp.match(/(\d+)$/)[1]));
    for (const s of sections) {
      let data = Buffer.from(s.e.content);
      if (compressed) {
        try { data = zlib.inflateRawSync(data); } catch { data = zlib.inflateSync(data); }
      }
      text += recordsText(data) + '\n';
    }
  }
  // 배포용 문서(본문 암호화)이거나 본문을 못 읽으면 미리보기 텍스트라도 사용
  if (!text.trim()) {
    const prv = get(/\/PrvText$/)[0];
    if (prv) text = Buffer.from(prv.e.content).toString('utf16le');
    if (distribution) text = '[배포용 문서라 앞부분 미리보기만 읽었습니다]\n' + text;
  }
  return text;
}

// ---------------- ZIP 기반 (HWPX, DOCX) ----------------
const decodeXml = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&amp;/g, '&');

function xmlText(xml, textTag, paraTag) {
  // 문단 끝마다 줄바꿈, 텍스트 태그 안의 글자만 모은다
  const out = [];
  const paraRe = new RegExp(`<${paraTag}[\\s>][\\s\\S]*?</${paraTag}>`, 'g');
  const textRe = new RegExp(`<${textTag}(?:\\s[^>]*)?>([\\s\\S]*?)</${textTag}>`, 'g');
  for (const para of xml.match(paraRe) || []) {
    let line = '';
    for (const m of para.matchAll(textRe)) line += decodeXml(m[1].replace(/<[^>]+>/g, ''));
    out.push(line);
  }
  return out.join('\n');
}

function extractHwpx(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const secs = Object.keys(files)
    .filter((n) => /^Contents\/section\d+\.xml$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/i)[1]) - Number(b.match(/(\d+)\.xml$/i)[1]));
  if (!secs.length) throw new Error('HWPX 본문을 찾지 못했습니다');
  // 표 안의 문단도 hp:p 이므로, 안쪽부터 잡히도록 hp:p 단위 대신 hp:t 사이 문단 경계를 사용
  return secs.map((n) => hwpxSection(strFromU8(files[n]))).join('\n');
}
function hwpxSection(xml) {
  // 문단(<hp:p>)이 표 속에 중첩되므로 정규식 중첩 대신: 문단 시작/끝 태그를 줄바꿈으로 바꾼 뒤 텍스트만 남긴다
  const withBreaks = xml
    .replace(/<hp:t(?:\s[^>]*)?\/>/g, '')
    .replace(/<\/hp:p>/g, '\n')
    .replace(/<hp:tab[^>]*\/>/g, '\t')
    .replace(/<hp:lineBreak[^>]*\/>/g, '\n');
  let out = '';
  const re = /<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>|\n|\t/g;
  for (const m of withBreaks.matchAll(re)) out += m[1] !== undefined ? decodeXml(m[1].replace(/<[^>]+>/g, '')) : m[0];
  return out;
}

function extractDocx(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const doc = files['word/document.xml'];
  if (!doc) throw new Error('DOCX 본문을 찾지 못했습니다');
  const xml = strFromU8(doc).replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:br\/>/g, '<w:t>\n</w:t>');
  return xmlText(xml, 'w:t', 'w:p');
}

function decodeText(buf) {
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8.replace(/^\uFEFF/, '');
  try { return new TextDecoder('euc-kr').decode(buf); } catch { return utf8; }
}

const TEXT_EXT = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.html', '.htm', '.ics', '.log']);

function tidy(t) {
  return t.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 텍스트 추출이 가능한 형식이면 { text, truncated } , 아니면 null */
function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!['.hwp', '.hwpx', '.docx'].includes(ext) && !TEXT_EXT.has(ext)) return null; // PDF·사진·음성은 AI로 직접
  const buf = fs.readFileSync(filePath);
  let text;
  if (ext === '.hwp') {
    // 드물게 HWPX를 .hwp로 저장한 경우(ZIP 시그니처 PK)
    text = buf[0] === 0x50 && buf[1] === 0x4b ? extractHwpx(buf) : extractHwp(buf);
  } else if (ext === '.hwpx') text = extractHwpx(buf);
  else if (ext === '.docx') text = extractDocx(buf);
  else if (TEXT_EXT.has(ext)) text = decodeText(buf);
  else return null;
  text = tidy(text);
  const truncated = text.length > MAX_CHARS;
  return { text: truncated ? text.slice(0, MAX_CHARS) : text, truncated };
}

module.exports = { extractText, extractHwp, extractHwpx, extractDocx, TEXT_EXT };
