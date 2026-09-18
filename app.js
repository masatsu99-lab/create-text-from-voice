/* 英日リアルタイム字幕 スマホ版（PWA）
 *
 * PC版（teams_subtitles.py + engines/）の処理をブラウザ向けに移植したもの。
 *   マイク → AudioWorklet(16kHz PCM) → Gemini Live API(WebSocket, 文字起こしのみ)
 *   確定した英文 → generateContent(テキスト翻訳) → 字幕表示
 *   確定字幕と録音は IndexedDB に逐次保存し、終了時に zip（transcript.txt / transcript.jsonl /
 *   meeting_audio.wav）として共有・ダウンロードする。形式はPC版と同じで、議事録作成に使える。
 */
'use strict';

// ------------------------------------------------------------------ 定数
const LIVE_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const GEN_URL = 'https://generativelanguage.googleapis.com/v1beta/models/';
const SAMPLE_RATE = 16000;
const RECONNECT_BEFORE_SECONDS = 540;   // Live API のセッション上限（10分）前に張り替える
const MAX_RECONNECT_ATTEMPTS = 5;
const TRANSLATE_TIMEOUT_MS = 15000;
const MAX_BATCH = 6;
const CONTEXT_TURNS = 2;
const RPM_RETRY_WAIT_MS = 8000;
const QUOTA_COOLDOWN_MS = 300000;
const MAX_VOCABULARY = 100;
const MAX_GLOSSARY_LINES = 200;
const AUDIO_FLUSH_SECONDS = 5;          // 録音をIndexedDBへ書く間隔
const FAILURE_TEXT = '（翻訳できませんでした）';
const QUOTA_TEXT = '（無料枠の上限に達しました）';

const DEFAULTS = {
  apiKey: '',
  meetingLanguage: 'auto',
  glossary: '',
  transcribeModel: 'gemini-3.5-transcribe-live',
  translateModels: 'gemini-3.5-flash-lite, gemini-3.1-flash-lite, gemini-3.6-flash, gemini-3.5-flash',
  vadSilence: 800,
  vadPrefix: 300,
  recordAudio: true,
  keepAwake: true,
  fontSize: 18,
  displayMode: 'both',
};

const INSTRUCTION = `あなたは日本の生命保険会社の海外事業部で働く英日の会議通訳です。
会議中にリアルタイム表示する字幕として、英文を自然な日本語へ訳してください。

規則:
- 訳文だけを出力する。前置き、注釈、原文の再掲、引用符、箇条書き記号は付けない。
- 与えられた英文の範囲だけを訳す。要約も補足も推測もしない。
- 用語集にある語は必ず用語集の訳語を使う。
- 人名・社名は原則そのまま（カタカナ化しない）。
- 英文が途中で切れている場合も、切れたまま訳す。
- 意味をなさない断片は無理に訳さず、英文をそのまま出力する。`;

// ------------------------------------------------------------------ 共通ユーティリティ
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowMs = () => performance.now();

function normalizeLanguage(code) {
  const v = String(code || '').trim().toLowerCase().replace('_', '-');
  if (v.startsWith('en')) return 'en';
  if (v.startsWith('ja') || v.startsWith('jp')) return 'ja';
  return '';
}

function inferLanguageFromText(text) {
  let japanese = 0, latin = 0;
  for (const c of text) {
    const cp = c.codePointAt(0);
    if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x9fff)) japanese++;
    else if (cp < 128 && /[a-zA-Z]/.test(c)) latin++;
  }
  if (japanese >= Math.max(2, Math.floor(latin / 3))) return 'ja';
  if (latin >= 4) return 'en';
  return '';
}

function languageCodesFor(meetingLanguage) {
  const l = normalizeLanguage(meetingLanguage);
  if (l === 'en') return ['en-US'];
  if (l === 'ja') return ['ja-JP'];
  return ['en-US', 'ja-JP'];
}

function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

function stampNow() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backoffSeconds(attempt) {
  return Math.min(30, 1.5 * 2 ** Math.max(0, attempt)) + Math.random() * 0.5;
}

function base64FromBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// ------------------------------------------------------------------ 用語集（glossary.py の移植）
function parseGlossary(text) {
  const result = [];
  const seen = new Set();
  for (const raw of String(text || '').split(/\r?\n/)) {
    const clean = raw.trim();
    if (!clean || clean.startsWith('#')) continue;
    const items = clean.includes('=') ? [clean] : clean.split(',');
    for (const item of items) {
      const idx = item.indexOf('=');
      const term = (idx >= 0 ? item.slice(0, idx) : item).trim();
      const japanese = idx >= 0 ? item.slice(idx + 1).trim() : '';
      const key = term.toLowerCase();
      if (!term || seen.has(key)) continue;
      seen.add(key);
      result.push([term, japanese]);
    }
  }
  return result;
}

function customVocabulary(entries) { return entries.map(([t]) => t).slice(0, MAX_VOCABULARY); }

function glossaryText(entries) {
  const paired = entries.filter(([, j]) => j);
  const unpaired = entries.filter(([, j]) => !j).map(([t]) => t);
  const lines = paired.slice(0, MAX_GLOSSARY_LINES).map(([t, j]) => `- ${t} → ${j}`);
  const remaining = MAX_GLOSSARY_LINES - lines.length;
  if (remaining > 0 && unpaired.length) {
    lines.push(`- 次の固有名詞・専門用語は原綴りを尊重し、勝手に言い換えない: ${unpaired.slice(0, remaining).join('、')}`);
  }
  return lines.join('\n');
}

// ------------------------------------------------------------------ 設定
const settings = { ...DEFAULTS };
function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('subtitleSettings') || '{}');
    Object.assign(settings, saved);
  } catch (_) { /* 壊れていれば既定値 */ }
}
function saveSettings() {
  try { localStorage.setItem('subtitleSettings', JSON.stringify(settings)); } catch (_) { /* 容量不足など */ }
}

// ------------------------------------------------------------------ ログ
const logLines = [];
function log(message, level = 'info') {
  const line = `[${new Date().toLocaleTimeString('ja-JP', { hour12: false })}] ${message}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  if ($('dlgLog').open) renderLog();
  if (level !== 'info') showSystem(message, level);
  (level === 'error' ? console.error : console.log)(line);
}
function renderLog() { const el = $('log'); el.textContent = logLines.join('\n'); el.scrollTop = el.scrollHeight; }

// ------------------------------------------------------------------ IndexedDB（逐次保存）
const DB_NAME = 'subtitles';
let db = null;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('utterances', { keyPath: ['session', 'seq'] });
      d.createObjectStore('audio', { keyPath: ['session', 'index'] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idb(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function idbGetAllRange(store, session) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const range = IDBKeyRange.bound([session, -Infinity], [session, Infinity]);
    const req = tx.objectStore(store).getAll(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function deleteSession(id) {
  exportCache.delete(id);
  await idb('sessions', 'readwrite', (s) => s.delete(id));
  for (const store of ['utterances', 'audio']) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(IDBKeyRange.bound([id, -Infinity], [id, Infinity]));
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
  }
}

// ------------------------------------------------------------------ 翻訳（text_translator.py の移植）
class TextTranslator {
  constructor(apiKey, models, glossary, emit) {
    this.apiKey = apiKey;
    this.models = models;
    this.glossary = glossary;
    this.emit = emit;
    this.queue = [];
    this.running = false;
    this.stopped = false;
    this.modelIndex = 0;
    this.rpmRetried = false;
    this.quotaExhausted = false;
    this.quotaAt = 0;
    this.requests = 0;
    this.history = [];
    this.configVariants = [
      { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: 'minimal' } },
      { maxOutputTokens: 1024 },
      null,
    ];
    this.variantIndex = 0;
    this.lastError = '';
  }
  get model() { return this.models[Math.min(this.modelIndex, this.models.length - 1)]; }
  get backlog() { return this.queue.length; }
  get status() {
    if (this.quotaExhausted) return '無料枠上限（太平洋時間0時にリセット）';
    return `翻訳 ${this.model} / API ${this.requests}回`;
  }

  submit(seq, text, timestamp) {
    if (!text.trim() || this.stopped) return;
    this.queue.push({ seq, text: text.trim(), timestamp });
    if (!this.running) this.run();
  }

  stop() { this.stopped = true; }

  async drain(timeoutMs = 3000) {
    const until = nowMs() + timeoutMs;
    while (this.running && nowMs() < until) await sleep(100);
    for (const job of this.queue.splice(0)) this.emitResult(job, this.quotaExhausted ? QUOTA_TEXT : FAILURE_TEXT);
  }

  emitResult(job, text) {
    this.emit({ kind: 'translation', text, seq: job.seq, timestamp: job.timestamp });
  }

  async run() {
    this.running = true;
    try {
      while (this.queue.length && !this.stopped) {
        const batch = this.queue.splice(0, MAX_BATCH);
        let results;
        if (batch.length === 1) results = [await this.translateWithRetry(batch[0].text, true)];
        else results = await this.translateBatch(batch);
        batch.forEach((job, i) => {
          const japanese = results[i] || FAILURE_TEXT;
          if (japanese && !japanese.startsWith('（')) {
            this.history.push([job.text, japanese]);
            if (this.history.length > CONTEXT_TURNS) this.history.shift();
          }
          this.emitResult(job, japanese);
        });
      }
    } catch (e) {
      log(`翻訳ワーカーが停止しました: ${e}`, 'error');
      for (const job of this.queue.splice(0)) this.emitResult(job, FAILURE_TEXT);
    } finally {
      this.running = false;
    }
  }

  buildPrompt(text, useContext) {
    const parts = [INSTRUCTION];
    if (this.glossary) parts.push('【用語集】\n' + this.glossary);
    if (useContext && this.history.length) {
      parts.push('【直前の文脈（訳出済み・参考。ここは訳さない）】\n' + this.history.map(([e, j]) => `EN: ${e}\nJA: ${j}`).join('\n'));
    }
    parts.push('【訳す英文】\n' + text);
    parts.push('【日本語訳】');
    return parts.join('\n\n');
  }

  async translateBatch(batch) {
    const numbered = batch.map((j, i) => `${i + 1}. ${j.text}`).join('\n');
    const prompt = `${INSTRUCTION}\n\n` + (this.glossary ? `【用語集】\n${this.glossary}\n\n` : '')
      + `【訳す英文】\n${numbered}\n\n【出力形式】\n英文と同じ順序・同じ${batch.length}行で、各行を「番号. 訳文」の形式にする。`
      + '行を増やしたり減らしたりしない。番号と訳文以外は書かない。\n\n【日本語訳】';
    let parsed = null;
    try {
      parsed = parseNumbered(await this.create(prompt), batch.length);
    } catch (e) {
      if (isQuotaError(e)) log(`一括翻訳が無料枠超過 model=${this.model}`);
      else log(`一括翻訳に失敗 ${String(e).slice(0, 160)} → 1件ずつ再試行`);
    }
    if (!parsed) {
      const out = [];
      for (const job of batch) out.push(await this.translateWithRetry(job.text, false));
      return out;
    }
    return parsed;
  }

  advanceModel() {
    if (this.modelIndex >= this.models.length - 1) return false;
    const previous = this.model;
    this.modelIndex++;
    this.variantIndex = 0;
    this.rpmRetried = false;
    log(`${previous} が無料枠の上限に達したため ${this.model} へ切り替えます。`, 'warn');
    return true;
  }

  async translateWithRetry(text, useContext) {
    if (this.quotaExhausted) {
      if (nowMs() - this.quotaAt < QUOTA_COOLDOWN_MS) return QUOTA_TEXT;
      this.quotaExhausted = false;
    }
    let attempt = 0;
    while (!this.stopped) {
      try {
        return cleanTranslation(await this.create(this.buildPrompt(text, useContext)));
      } catch (e) {
        const detail = String(e).slice(0, 200);
        this.lastError = detail;
        if (isQuotaError(e)) {
          log(`無料枠超過 model=${this.model} ${detail}`);
          if (!this.rpmRetried) {
            this.rpmRetried = true;
            log(`RPM上限の可能性。${RPM_RETRY_WAIT_MS / 1000}秒待って再試行します。`);
            await sleep(RPM_RETRY_WAIT_MS);
            continue;
          }
          if (this.advanceModel()) continue;
          this.quotaExhausted = true;
          this.quotaAt = nowMs();
          log('全モデルで無料枠の上限に達しました。日次枠は米国太平洋時間0時（日本時間の夕方）にリセットされます。', 'warn');
          return QUOTA_TEXT;
        }
        attempt++;
        log(`翻訳失敗（${attempt}回目） model=${this.model} ${detail} | 対象: ${text.slice(0, 80)}`);
        if (attempt >= 3 || !isRetryableError(e)) {
          log(`翻訳に失敗しました（${detail}）`, 'warn');
          return `（翻訳失敗: ${e.name || 'Error'}）`;
        }
        await sleep(Math.min(4000, backoffSeconds(attempt - 1) * 1000));
      }
    }
    return FAILURE_TEXT;
  }

  // generateContent REST。generationConfig の書式は環境差があるため、通る形が見つかるまで段階的に緩める。
  async create(prompt) {
    let last = null;
    while (this.variantIndex < this.configVariants.length) {
      const variant = this.configVariants[this.variantIndex];
      const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
      if (variant) body.generationConfig = variant;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
      try {
        this.requests++;
        const res = await fetch(`${GEN_URL}${encodeURIComponent(this.model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
          err.status = res.status;
          throw err;
        }
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return parts.map((p) => p.text || '').join('');
      } catch (e) {
        last = e;
        const terminal = this.variantIndex >= this.configVariants.length - 1;
        if (isQuotaError(e) || isRetryableError(e) || terminal || e.status !== 400) throw e;
        log(`generationConfig を緩めます（${String(e).slice(0, 160)}）`);
        this.variantIndex++;
      } finally {
        clearTimeout(timer);
      }
    }
    throw last || new Error('翻訳要求を送信できませんでした。');
  }
}

function isQuotaError(e) {
  if (e && e.status === 429) return true;
  const t = String(e).toLowerCase();
  return t.includes('429') && (t.includes('quota') || t.includes('rate limit') || t.includes('resource_exhausted'));
}
function isRetryableError(e) {
  const code = e && e.status;
  const t = String(e).toLowerCase();
  return [408, 429, 500, 502, 503, 504].includes(code) || e?.name === 'AbortError'
    || ['timeout', 'timed out', 'rate limit', 'connection closed', 'temporar', 'failed to fetch'].some((x) => t.includes(x));
}
function parseNumbered(text, expected) {
  const found = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.trim().match(/^\s*(\d+)\s*[.)．：:、]\s*(.+)$/);
    if (!m) continue;
    const i = parseInt(m[1], 10);
    if (i >= 1 && i <= expected && !(i in found)) found[i] = cleanTranslation(m[2]);
  }
  const out = [];
  for (let i = 1; i <= expected; i++) { if (!found[i]) return null; out.push(found[i]); }
  return out;
}
function cleanTranslation(text) {
  let v = String(text || '').trim();
  for (const label of ['【日本語訳】', '日本語訳:', '日本語訳：', 'JA:', '訳:', '訳：']) {
    if (v.startsWith(label)) v = v.slice(label.length).trim();
  }
  if (v.length >= 2 && '「"\'“'.includes(v[0]) && '」"\'”'.includes(v[v.length - 1])) v = v.slice(1, -1).trim();
  return v.split('\n').join(' ').trim();
}

// ------------------------------------------------------------------ Live API 文字起こし（gemini_live.py の移植）
class GeminiLiveTranscriber {
  constructor(opts) {
    this.opts = opts;        // {apiKey, model, languageCodes, vocabulary, vadSilence, vadPrefix, emit}
    this.ws = null;
    this.stopped = false;
    this.connectedAt = 0;
    this.retryAttempt = 0;
    this.pending = [];       // 接続待ちの音声（最大約20秒）
    this.setupDone = false;
    this.lastAudioAt = 0;
  }

  async start() {
    this.stopped = false;
    this.loop();
  }

  stop() {
    this.stopped = true;
    if (this.ws) { try { this.ws.close(); } catch (_) { /* noop */ } }
  }

  pushAudio(buffer) {
    this.lastAudioAt = nowMs();
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN && this.setupDone) {
      if (ws.bufferedAmount > 512 * 1024) { log('ネットワーク送信が遅いため音声の一部を省略しました。', 'warn'); return; }
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: base64FromBuffer(buffer), mimeType: `audio/pcm;rate=${SAMPLE_RATE}` } } }));
    } else {
      this.pending.push(buffer);
      if (this.pending.length > 100) this.pending.shift();
    }
  }

  async loop() {
    while (!this.stopped) {
      try {
        await this.connectOnce();
        if (this.stopped) return;
        this.opts.emit({ kind: 'status', text: '接続時間上限前にGeminiへ再接続します…' });
      } catch (e) {
        if (this.stopped) return;
        if (this.retryAttempt >= MAX_RECONNECT_ATTEMPTS) {
          this.opts.emit({ kind: 'fatal', text: `Gemini Live APIへ規定回数再接続できませんでした（${e.message || e}）` });
          return;
        }
        const delay = backoffSeconds(this.retryAttempt);
        this.retryAttempt++;
        this.opts.emit({ kind: 'recoverable_error', text: `API通信エラー（${e.message || e}）。${delay.toFixed(1)}秒後に再接続します（${this.retryAttempt}/${MAX_RECONNECT_ATTEMPTS}）` });
        await sleep(delay * 1000);
      }
    }
  }

  connectOnce() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${LIVE_WS}?key=${encodeURIComponent(this.opts.apiKey)}`);
      this.ws = ws;
      this.setupDone = false;
      let settled = false;
      let closeReason = '';
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearInterval(ticker);
        if (this.ws === ws) this.ws = null;
        err ? reject(err) : resolve();
      };
      const ticker = setInterval(() => {
        if (this.stopped) { ws.close(); finish(); return; }
        if (this.connectedAt && (nowMs() - this.connectedAt) / 1000 >= RECONNECT_BEFORE_SECONDS) { ws.close(); finish(); }
      }, 1000);
      const setupTimer = setTimeout(() => { if (!this.setupDone) { ws.close(); finish(new Error('setup timeout')); } }, 20000);

      ws.onopen = () => {
        const setup = {
          model: `models/${this.opts.model}`,
          generationConfig: { responseModalities: ['TEXT'] },
          inputAudioTranscription: {
            languageCodes: this.opts.languageCodes,
            customVocabulary: this.opts.vocabulary,
            mode: 'SMART',
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
              prefixPaddingMs: this.opts.vadPrefix,
              silenceDurationMs: this.opts.vadSilence,
            },
          },
        };
        if (!this.opts.vocabulary.length) delete setup.inputAudioTranscription.customVocabulary;
        ws.send(JSON.stringify({ setup }));
      };
      ws.onmessage = async (ev) => {
        let text = ev.data;
        if (text instanceof Blob) text = await text.text();
        let msg;
        try { msg = JSON.parse(text); } catch (_) { return; }
        if (msg.setupComplete !== undefined) {
          clearTimeout(setupTimer);
          this.setupDone = true;
          this.connectedAt = nowMs();
          this.retryAttempt = 0;
          this.opts.emit({ kind: 'status', text: 'Gemini文字起こし接続済み' });
          for (const buf of this.pending.splice(0)) this.pushAudio(buf);
          return;
        }
        if (msg.error) { log(`Live API error: ${JSON.stringify(msg.error).slice(0, 300)}`, 'error'); return; }
        for (const event of parseLiveMessage(msg)) {
          event.delay = this.lastAudioAt ? Math.max(0, (nowMs() - this.lastAudioAt) / 1000) : 0;
          this.opts.emit(event);
        }
      };
      ws.onerror = () => { /* 詳細はoncloseへ */ };
      ws.onclose = (ev) => {
        clearTimeout(setupTimer);
        closeReason = `code=${ev.code} ${ev.reason || ''}`.trim();
        if (this.stopped) { finish(); return; }
        if (!this.setupDone) { finish(new Error(`接続を確立できません（${closeReason}）`)); return; }
        if (this.connectedAt && (nowMs() - this.connectedAt) / 1000 >= RECONNECT_BEFORE_SECONDS - 5) { finish(); return; }
        finish(new Error(`Live API connection closed（${closeReason}）`));
      };
    });
  }
}

function parseLiveMessage(msg) {
  const server = msg.serverContent;
  if (!server) return [];
  let transcription = server.inputTranscription;
  let isFinal = true;
  if (!transcription) { transcription = server.interimInputTranscription; isFinal = false; }
  if (!transcription) return [];
  const text = String(transcription.text || '').trim();
  if (!text) return [];
  const finished = transcription.finished ?? transcription.final ?? transcription.isFinal;
  const turnComplete = Boolean(server.turnComplete);
  return [{
    kind: 'transcript',
    text,
    language: normalizeLanguage(transcription.languageCode || ''),
    final: finished === undefined ? isFinal : (Boolean(finished) || turnComplete),
    timestamp: nowMs(),
  }];
}

// ------------------------------------------------------------------ zip（無圧縮）と WAV
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(chunks) {
  let crc = 0xffffffff;
  for (const chunk of chunks) for (let i = 0; i < chunk.length; i++) crc = CRC_TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
// files: [{name, chunks: Uint8Array[]}] → Blob（ZIP, 格納のみ。WAVは圧縮しても縮まないため）
function buildZip(files, folder) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const file of files) {
    const nameBytes = enc.encode(`${folder}/${file.name}`);
    const size = file.chunks.reduce((s, c) => s + c.length, 0);
    const crc = crc32(file.chunks);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, time, true); local.setUint16(12, date, true);
    local.setUint32(14, crc, true); local.setUint32(18, size, true); local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true); local.setUint16(28, 0, true);
    parts.push(local.buffer, nameBytes, ...file.chunks);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, time, true); cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, size, true); cd.setUint32(24, size, true);
    cd.setUint16(28, nameBytes.length, true); cd.setUint16(30, 0, true); cd.setUint16(32, 0, true);
    cd.setUint16(34, 0, true); cd.setUint16(36, 0, true); cd.setUint32(38, 0, true); cd.setUint32(42, offset, true);
    central.push(cd.buffer, nameBytes);
    offset += 30 + nameBytes.length + size;
  }
  const cdSize = central.reduce((s, c) => s + (c.byteLength ?? c.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
function wavHeader(pcmBytes) {
  const h = new DataView(new ArrayBuffer(44));
  const s = (o, str) => { for (let i = 0; i < str.length; i++) h.setUint8(o + i, str.charCodeAt(i)); };
  s(0, 'RIFF'); h.setUint32(4, 36 + pcmBytes, true); s(8, 'WAVE'); s(12, 'fmt ');
  h.setUint32(16, 16, true); h.setUint16(20, 1, true); h.setUint16(22, 1, true);
  h.setUint32(24, SAMPLE_RATE, true); h.setUint32(28, SAMPLE_RATE * 2, true); h.setUint16(32, 2, true); h.setUint16(34, 16, true);
  s(36, 'data'); h.setUint32(40, pcmBytes, true);
  return new Uint8Array(h.buffer);
}

// session_storage.py と同じレコード形式
function utteranceRecord(u) {
  return {
    seq: u.seq, elapsed: Math.round(u.elapsed * 100) / 100, time: formatElapsed(u.elapsed),
    language: u.language, en: u.en || '', ja: u.ja || '', text: u.en || u.ja || '', source: 'gemini_live_mobile',
  };
}
function transcriptText(records) {
  const lines = [];
  for (const r of records) {
    if (r.en) lines.push(`[${r.time}] EN  ${r.en}`);
    if (r.ja) lines.push(r.en ? `${' '.repeat(10)}  JA  ${r.ja}` : `[${r.time}] JA  ${r.ja}`);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}
async function exportSession(id) {
  const enc = new TextEncoder();
  const utterances = (await idbGetAllRange('utterances', id)).map(utteranceRecord);
  const files = [
    { name: 'transcript.txt', chunks: [enc.encode(transcriptText(utterances))] },
    { name: 'transcript.jsonl', chunks: [enc.encode(utterances.map((r) => JSON.stringify(r)).join('\n') + (utterances.length ? '\n' : ''))] },
  ];
  const audio = await idbGetAllRange('audio', id);
  if (audio.length) {
    const chunks = audio.map((a) => new Uint8Array(a.data));
    const total = chunks.reduce((s, c) => s + c.length, 0);
    files.push({ name: 'meeting_audio.wav', chunks: [wavHeader(total), ...chunks] });
  }
  return new File([buildZip(files, id)], `${id}.zip`, { type: 'application/zip' });
}
// navigator.share は「ユーザーのタップ直後」にしか呼べない（数秒で権限が切れ NotAllowedError になる）。
// そのため zip は先に作っておき、共有ボタンのタップ時には作成済みの File を渡すだけにする。
const exportCache = new Map(); // sessionId → File
async function prepareExport(id) {
  if (!exportCache.has(id)) exportCache.set(id, await exportSession(id));
  return exportCache.get(id);
}
function shareFile(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file], title: file.name })
      .catch((e) => { if (e.name !== 'AbortError') { log(`共有に失敗: ${e}。ダウンロードに切り替えます。`, 'warn'); downloadFile(file); } });
  }
  log('この環境ではファイル共有が使えないためダウンロードします。');
  downloadFile(file);
  return Promise.resolve();
}
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// 停止直後に字幕欄へ出す「共有／ダウンロード」ボタン行
function showExportButtons(id, file) {
  const row = document.createElement('div');
  row.className = 'sys';
  row.style.display = 'flex'; row.style.gap = '8px'; row.style.alignItems = 'center'; row.style.flexWrap = 'wrap';
  const label = document.createElement('span');
  label.textContent = `${id}.zip（${(file.size / 1048576).toFixed(1)} MB）`;
  const share = document.createElement('button'); share.className = 'small primary'; share.style.flex = '0 1 auto';
  share.textContent = 'ドライブへ共有'; share.onclick = () => shareFile(file);
  const dl = document.createElement('button'); dl.className = 'small'; dl.textContent = 'ダウンロード'; dl.onclick = () => downloadFile(file);
  row.append(label, share, dl);
  $('captions').insertBefore(row, $('interim'));
  scrollToBottom();
}

// ------------------------------------------------------------------ セッション（画面・録音・保存の統括）
const state = {
  running: false, sessionId: '', startedAt: 0, seq: 0, mixed: true, language: '', translate: true,
  transcriber: null, translator: null, audioCtx: null, stream: null, node: null,
  audioChunks: [], audioChunkBytes: 0, audioIndex: 0, lastFlush: 0, wakeLock: null, timer: null,
  rows: new Map(), // seq → {el, utterance}
};

function setStatus(text, cls = '') {
  $('status').textContent = text;
  $('dot').className = `dot ${cls}`;
}
function showSystem(text, level) {
  const el = document.createElement('div');
  el.className = `sys ${level === 'error' ? 'err' : ''}`;
  el.textContent = text;
  $('captions').insertBefore(el, $('interim'));
  scrollToBottom();
}
function scrollToBottom() { const m = $('captions'); m.scrollTop = m.scrollHeight; }

function elapsedSeconds(timestamp) { return Math.max(0, ((timestamp ?? nowMs()) - state.startedAt) / 1000); }

function appendUtterance(u) {
  const el = document.createElement('div');
  el.className = `utt ${u.language === 'ja' ? 'src-ja' : ''}`;
  const t = document.createElement('div'); t.className = 't'; t.textContent = formatElapsed(u.elapsed);
  el.appendChild(t);
  if (u.language === 'ja') {
    const ja = document.createElement('div'); ja.className = 'ja'; ja.textContent = u.ja; el.appendChild(ja);
  } else {
    const en = document.createElement('div'); en.className = 'en'; en.textContent = u.en; el.appendChild(en);
    const ja = document.createElement('div'); ja.className = u.ja ? 'ja' : 'ja pending'; ja.textContent = u.ja || '（翻訳中…）'; el.appendChild(ja);
  }
  $('captions').insertBefore(el, $('interim'));
  state.rows.set(u.seq, { el, utterance: u });
  while (state.rows.size > 300) { // 画面上は直近300件だけ保持（保存は全件）
    const [firstSeq, row] = state.rows.entries().next().value;
    row.el.remove(); state.rows.delete(firstSeq);
  }
  scrollToBottom();
}

async function persistUtterance(u) {
  try { await idb('utterances', 'readwrite', (s) => s.put({ session: state.sessionId, ...u })); }
  catch (e) { log(`字幕の保存に失敗: ${e}`, 'warn'); }
}

function onEvent(ev) {
  switch (ev.kind) {
    case 'status': setStatus(ev.text, 'on'); break;
    case 'recoverable_error': log(ev.text, 'warn'); setStatus(ev.text, 'warn'); break;
    case 'fatal': log(ev.text, 'error'); setStatus(ev.text, 'err'); stopSession(); break;
    case 'transcript': onTranscript(ev); break;
    case 'translation': onTranslation(ev); break;
    default: break;
  }
}

function onTranscript(ev) {
  const language = ev.language || inferLanguageFromText(ev.text) || (state.mixed ? 'en' : state.language || 'en');
  if (!ev.final) { $('interim').textContent = ev.text; scrollToBottom(); return; }
  $('interim').textContent = '';
  const seq = ++state.seq;
  const u = { seq, elapsed: elapsedSeconds(ev.timestamp), language, en: language === 'ja' ? '' : ev.text, ja: language === 'ja' ? ev.text : '' };
  appendUtterance(u);
  if (state.translator && language !== 'ja') state.translator.submit(seq, ev.text, ev.timestamp);
  else persistUtterance(u);
  updateHeader();
}

function onTranslation(ev) {
  const row = state.rows.get(ev.seq);
  if (row) {
    row.utterance.ja = ev.text;
    const ja = row.el.querySelector('.ja');
    if (ja) { ja.textContent = ev.text; ja.className = 'ja'; }
    persistUtterance(row.utterance);
  } else {
    // 画面から消えた古い行: 保存だけ更新する
    idbGetAllRange('utterances', state.sessionId).then((all) => {
      const u = all.find((x) => x.seq === ev.seq);
      if (u) { u.ja = ev.text; persistUtterance(u); }
    }).catch(() => {});
  }
  updateHeader();
}

function updateHeader() {
  if (!state.running) return;
  const t = state.translator;
  const backlog = t && t.backlog ? ` / 翻訳待ち${t.backlog}` : '';
  setStatus(`${t ? t.status : '文字起こしのみ'}${backlog}`, 'on');
}

async function requestWakeLock() {
  if (!settings.keepAwake || !('wakeLock' in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { log(`画面点灯維持を取得できません: ${e.message}`); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && state.running) requestWakeLock(); });

async function flushAudio(force) {
  if (!settings.recordAudio || !state.audioChunks.length) return;
  if (!force && state.audioChunkBytes < SAMPLE_RATE * 2 * AUDIO_FLUSH_SECONDS) return;
  const merged = new Uint8Array(state.audioChunkBytes);
  let o = 0;
  for (const c of state.audioChunks) { merged.set(new Uint8Array(c), o); o += c.byteLength; }
  state.audioChunks = []; state.audioChunkBytes = 0;
  const index = state.audioIndex++;
  try { await idb('audio', 'readwrite', (s) => s.put({ session: state.sessionId, index, data: merged.buffer })); }
  catch (e) { log(`録音の保存に失敗（容量不足の可能性）: ${e}`, 'warn'); }
}

async function startSession() {
  if (state.running) return;
  if (!settings.apiKey) { openSettings(); log('APIキーを設定してください。', 'warn'); return; }
  $('btnStart').disabled = true;
  try {
    // 1. マイク
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    let ctx;
    try { ctx = new AudioContext({ sampleRate: SAMPLE_RATE }); } catch (_) { ctx = new AudioContext(); }
    state.audioCtx = ctx;
    await ctx.audioWorklet.addModule('pcm-worklet.js');
    const source = ctx.createMediaStreamSource(state.stream);
    const node = new AudioWorkletNode(ctx, 'pcm-capture');
    source.connect(node);
    state.node = node;
    if (ctx.state !== 'running') await ctx.resume();
    log(`マイク開始 sampleRate=${ctx.sampleRate}`);

    // 2. セッション情報
    state.sessionId = stampNow();
    state.startedAt = nowMs();
    state.seq = 0; state.rows.clear(); state.audioChunks = []; state.audioChunkBytes = 0; state.audioIndex = 0;
    $('captions').querySelectorAll('.utt, .sys').forEach((e) => e.remove());
    await idb('sessions', 'readwrite', (s) => s.put({ id: state.sessionId, startedAt: Date.now(), language: settings.meetingLanguage }));

    // 3. 言語・用語集
    const configured = String(settings.meetingLanguage || 'auto').toLowerCase();
    state.mixed = ['auto', 'mixed', ''].includes(configured);
    state.language = state.mixed ? '' : normalizeLanguage(configured);
    state.translate = state.mixed || state.language !== 'ja';
    const entries = parseGlossary(settings.glossary);
    const dropped = Math.max(0, entries.length - MAX_VOCABULARY);
    if (dropped) log(`専門用語がAPI上限を超えています。後ろの${dropped}語は使われません。`, 'warn');
    const models = settings.translateModels.split(',').map((s) => s.trim()).filter(Boolean);

    // 4. 翻訳・文字起こし
    state.translator = state.translate ? new TextTranslator(settings.apiKey, models.length ? models : [DEFAULTS.translateModels.split(',')[0].trim()], glossaryText(entries), onEvent) : null;
    state.transcriber = new GeminiLiveTranscriber({
      apiKey: settings.apiKey, model: settings.transcribeModel.trim(), languageCodes: languageCodesFor(settings.meetingLanguage),
      vocabulary: customVocabulary(entries), vadSilence: Number(settings.vadSilence) || 800, vadPrefix: Number(settings.vadPrefix) || 300, emit: onEvent,
    });
    node.port.onmessage = (ev) => {
      if (!state.running) return;
      const { pcm, peak } = ev.data;
      $('level').firstElementChild.style.width = `${Math.min(100, Math.round(peak * 140))}%`;
      state.transcriber.pushAudio(pcm);
      if (settings.recordAudio) { state.audioChunks.push(pcm); state.audioChunkBytes += pcm.byteLength; flushAudio(false); }
    };
    state.running = true;
    state.transcriber.start();
    await requestWakeLock();
    setStatus('Geminiへ接続中…', 'warn');
    $('btnStart').textContent = '停止';
    $('btnStart').classList.add('stop');
    state.timer = setInterval(() => { $('timer').textContent = formatElapsed(elapsedSeconds()); }, 1000);
  } catch (e) {
    log(`開始できません: ${e.message || e}`, 'error');
    await teardownAudio();
  } finally {
    $('btnStart').disabled = false;
  }
}

async function teardownAudio() {
  if (state.node) { try { state.node.port.onmessage = null; state.node.disconnect(); } catch (_) { /* noop */ } state.node = null; }
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  if (state.audioCtx) { try { await state.audioCtx.close(); } catch (_) { /* noop */ } state.audioCtx = null; }
  if (state.wakeLock) { try { await state.wakeLock.release(); } catch (_) { /* noop */ } state.wakeLock = null; }
}

async function stopSession() {
  if (!state.running) return;
  state.running = false;
  clearInterval(state.timer);
  $('btnStart').disabled = true;
  setStatus('停止処理中…', 'warn');
  state.transcriber?.stop();
  await teardownAudio();
  await flushAudio(true);
  if (state.translator) { setStatus('翻訳待ちを処理中…', 'warn'); await state.translator.drain(4000); state.translator.stop(); }
  $('interim').textContent = '';
  $('btnStart').textContent = '字幕開始';
  $('btnStart').classList.remove('stop');
  $('btnStart').disabled = false;
  setStatus(`停止（${state.seq}発話を保存）`);
  const id = state.sessionId;
  state.transcriber = null; state.translator = null;
  if (state.seq > 0) {
    showSystem('字幕を端末に保存しました。下のボタンでGoogleドライブの「会議」フォルダへ送れます（「保存済み」からも後で可能）。', 'info');
    try { showExportButtons(id, await prepareExport(id)); } catch (e) { log(`書き出しに失敗: ${e}`, 'warn'); }
  }
}

// ------------------------------------------------------------------ 画面操作
function applyDisplay() {
  document.documentElement.style.setProperty('--font', `${settings.fontSize}px`);
  document.body.className = `mode-${settings.displayMode}`;
  $('btnMode').textContent = { both: '英日', ja: '日本語', en: '英語' }[settings.displayMode] || '英日';
}
function openSettings() {
  $('apiKey').value = settings.apiKey;
  $('meetingLanguage').value = settings.meetingLanguage;
  $('glossary').value = settings.glossary;
  $('transcribeModel').value = settings.transcribeModel;
  $('translateModels').value = settings.translateModels;
  $('vadSilence').value = settings.vadSilence;
  $('recordAudio').checked = settings.recordAudio;
  $('keepAwake').checked = settings.keepAwake;
  $('dlgSettings').showModal();
}
async function renderSessions() {
  const list = $('sessionList');
  list.innerHTML = '';
  let sessions = await idb('sessions', 'readonly', (s) => s.getAll());
  sessions = (sessions || []).sort((a, b) => b.startedAt - a.startedAt);
  if (!sessions.length) { list.textContent = '保存済みのセッションはありません。'; return; }
  for (const s of sessions) {
    const count = (await idbGetAllRange('utterances', s.id)).length;
    const audio = await idbGetAllRange('audio', s.id);
    const bytes = audio.reduce((n, a) => n + a.data.byteLength, 0);
    const row = document.createElement('div');
    row.className = 'session';
    const info = document.createElement('div');
    info.innerHTML = `<div>${s.id}${s.id === state.sessionId && state.running ? '（進行中）' : ''}</div><div class="meta">${count}発話 / 録音 ${(bytes / 1048576).toFixed(1)} MB</div>`;
    const btns = document.createElement('div');
    const mk = (label, fn) => { const b = document.createElement('button'); b.className = 'small'; b.textContent = label; b.onclick = fn; btns.appendChild(b); };
    if (exportCache.has(s.id)) {
      mk('共有', () => shareFile(exportCache.get(s.id)));
      mk('DL', () => downloadFile(exportCache.get(s.id)));
    } else {
      // zip作成に時間がかかると共有権限が切れるため、先に「準備」で作ってから共有ボタンを出す
      mk('準備', async (ev) => { ev.target.disabled = true; ev.target.textContent = '作成中…'; await prepareExport(s.id); renderSessions(); });
    }
    if (!(s.id === state.sessionId && state.running)) mk('削除', async () => { if (confirm(`${s.id} を端末から削除しますか？`)) { await deleteSession(s.id); renderSessions(); } });
    row.append(info, btns);
    list.appendChild(row);
  }
}

function bindUi() {
  $('btnStart').onclick = () => (state.running ? stopSession() : startSession());
  $('btnMode').onclick = () => { settings.displayMode = { both: 'ja', ja: 'en', en: 'both' }[settings.displayMode] || 'both'; saveSettings(); applyDisplay(); };
  $('btnFontUp').onclick = () => { settings.fontSize = Math.min(40, settings.fontSize + 2); saveSettings(); applyDisplay(); };
  $('btnFontDown').onclick = () => { settings.fontSize = Math.max(12, settings.fontSize - 2); saveSettings(); applyDisplay(); };
  $('btnSettings').onclick = openSettings;
  $('btnSettingsCancel').onclick = () => $('dlgSettings').close();
  $('btnSettingsSave').onclick = () => {
    settings.apiKey = $('apiKey').value.trim();
    settings.meetingLanguage = $('meetingLanguage').value;
    settings.glossary = $('glossary').value;
    settings.transcribeModel = $('transcribeModel').value.trim() || DEFAULTS.transcribeModel;
    settings.translateModels = $('translateModels').value.trim() || DEFAULTS.translateModels;
    settings.vadSilence = Number($('vadSilence').value) || DEFAULTS.vadSilence;
    settings.recordAudio = $('recordAudio').checked;
    settings.keepAwake = $('keepAwake').checked;
    saveSettings();
    $('dlgSettings').close();
    log('設定を保存しました。次回の「字幕開始」から反映されます。');
  };
  $('btnGlossaryFile').onclick = () => $('glossaryFile').click();
  $('glossaryFile').onchange = async (ev) => {
    const f = ev.target.files[0];
    if (f) { $('glossary').value = (await f.text()).replace(/^﻿/, ''); ev.target.value = ''; }
  };
  $('btnSessions').onclick = async () => { await renderSessions(); $('dlgSessions').showModal(); };
  $('btnSessionsClose').onclick = () => $('dlgSessions').close();
  $('btnLog').onclick = () => { renderLog(); $('dlgLog').showModal(); };
  $('btnLogClose').onclick = () => $('dlgLog').close();
  $('btnLogCopy').onclick = () => navigator.clipboard?.writeText(logLines.join('\n')).catch(() => {});
  window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
}

async function main() {
  loadSettings();
  applyDisplay();
  bindUi();
  try { db = await openDb(); } catch (e) { log(`端末内保存を初期化できません: ${e}`, 'error'); }
  if ('serviceWorker' in navigator) { navigator.serviceWorker.register('sw.js').catch((e) => log(`Service Worker登録失敗: ${e}`)); }
  if (!settings.apiKey) showSystem('初回は「設定」でGemini APIキーを保存してください。', 'info');
  log('起動しました。');
}
main();
