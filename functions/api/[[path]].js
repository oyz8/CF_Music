/**
 * Cloudflare Pages Functions · /api/*
 *
 * 环境变量：
 *   GITHUB_TOKEN        GitHub PAT
 *   REPO_NAME           owner/repo
 *   PASSWORD            访问密码
 *   BRANCH              可选，默认 main
 *   CF_DEPLOY_HOOK_URL  CF Pages 部署挂钩 URL
 */

// ============================================================
// 常量
// ============================================================
const GD_API     = 'https://music-api.gdstudio.xyz/api.php';
const GH_BASE    = 'https://api.github.com';
const MUSIC_JSON = 'public/music.json';
const AUDIO_DIR  = 'public/url';
const PIC_DIR    = 'public/pic';
const LRC_DIR    = 'public/lrc';

const UA_GD = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// GitHub Contents API 单文件实际上传上限（原始文件字节）
const MAX_AUDIO_SIZE_BYTES = 50 * 1024 * 1024;

// Worker /api/gd 出口节流：每 IP 每 5 分钟 60 次
const GD_PROXY_MAX    = 60;
const GD_PROXY_WINDOW = 5 * 60 * 1000;

// GitHub 冲突重试策略
const GH_MAX_RETRIES = 5;

// Token 有效期（7 天）
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ============================================================
// 通用工具
// ============================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Auth-Token',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function safeFilename(s) {
  if (s === null || s === undefined) return 'Unknown';
  s = String(s).replace(/\u00a0/g, ' ').replace(/\u3000/g, ' ');
  s = s.replace(/[\\/*?:"<>|]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > 200) s = s.slice(0, 200).replace(/\s\S*$/, '');
  return s || 'Unknown';
}

function buildPrefix(name, artist) {
  return safeFilename(name) + ' - ' + safeFilename(artist);
}

function arrayBufferToBase64(buf) {
  const bytes = buf instanceof Uint8Array
    ? buf
    : (ArrayBuffer.isView(buf)
        ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : new Uint8Array(buf));
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToUtf8(b64) {
  const binary = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function safeSeg(s) {
  return String(s || '').replace(/[\\/]/g, '').replace(/\.\./g, '').trim();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// 指数退避 + 抖动
function backoffMs(attempt) {
  return Math.min(150 * Math.pow(2, attempt), 3000) + Math.floor(Math.random() * 100);
}

function isConflictError(e) {
  const msg = String((e && e.message) || e || '');
  return /GitHub (PUT|DELETE) .*: 409/.test(msg) ||
         /并发冲突/.test(msg) ||
         /is at .* but expected/.test(msg);
}

// ============================================================
// 签名 Token（HMAC-SHA256，无状态）
// ============================================================
function base64UrlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function hmacSign(message, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  const bytes = new Uint8Array(sig);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return base64UrlEncode(binary);
}

async function generateToken(env) {
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = base64UrlEncode(JSON.stringify({ exp }));
  const sig = await hmacSign(payload, env.PASSWORD);
  return payload + '.' + sig;
}

async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = await hmacSign(payload, env.PASSWORD);
  // 恒定时间比较
  if (sig.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const obj = JSON.parse(base64UrlDecode(payload));
    return typeof obj.exp === 'number' && obj.exp > Date.now();
  } catch { return false; }
}

// 认证：优先 token，兼容旧的原始密码
async function checkAuth(request, env) {
  if (!env.PASSWORD) return true;
  const provided = request.headers.get('X-Auth-Token') || '';
  if (!provided) return false;
  // 新格式 token 含 "."，走签名验证
  if (provided.indexOf('.') > 0) {
    return await verifyToken(provided, env);
  }
  // 兼容：原始密码
  return provided === env.PASSWORD;
}

// ============================================================
// Worker 出口 IP 节流（单实例内存；防滥用）
// ============================================================
const gdThrottle = new Map();

function gdThrottleCheck(ip, limit = GD_PROXY_MAX, windowMs = GD_PROXY_WINDOW) {
  const now = Date.now();
  let e = gdThrottle.get(ip);
  if (!e || e.resetAt < now) {
    e = { count: 0, resetAt: now + windowMs };
    gdThrottle.set(ip, e);
  }
  if (e.count >= limit) return false;
  e.count++;
  if (gdThrottle.size > 1000) {
    for (const [k, v] of gdThrottle) if (v.resetAt < now) gdThrottle.delete(k);
  }
  return true;
}

// ============================================================
// GitHub API
// ============================================================
async function ghRequest(env, path, options = {}) {
  if (!env.GITHUB_TOKEN || !env.REPO_NAME) {
    throw new Error('缺少 GitHub 配置 (GITHUB_TOKEN / REPO_NAME)');
  }
  let url = GH_BASE + '/repos/' + env.REPO_NAME + '/contents/' + encodeURI(path);
  if (env.BRANCH && (!options.method || options.method === 'GET')) {
    url += '?ref=' + encodeURIComponent(env.BRANCH);
  }
  const headers = {
    'Authorization': 'Bearer ' + env.GITHUB_TOKEN,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'cf-music-pages',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers || {}),
  };
  return fetch(url, { ...options, headers });
}

async function ghGetFile(env, path) {
  const resp = await ghRequest(env, path);
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('GitHub GET ' + path + ': ' + resp.status + (t ? ' ' + t.slice(0, 120) : ''));
  }
  return await resp.json();
}

async function ghPutRaw(env, path, contentBytes, message, sha) {
  const body = {
    message,
    content: arrayBufferToBase64(contentBytes),
  };
  if (sha) body.sha = sha;
  if (env.BRANCH) body.branch = env.BRANCH;
  return ghRequest(env, path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// 加 409 冲突重试：读 sha → PUT，冲突则重读 sha 再试
async function ghUpsert(env, path, contentBytes, message, maxRetries = GH_MAX_RETRIES) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const existing = await ghGetFile(env, path);
      const resp = await ghPutRaw(env, path, contentBytes, message, existing && existing.sha);
      if (resp.ok) return await resp.json();

      const t = await resp.text().catch(() => '');
      if (resp.status === 409 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw new Error('GitHub PUT ' + path + ': ' + resp.status + ' ' + t.slice(0, 200));
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('GitHub PUT ' + path + ': 并发冲突，重试 ' + maxRetries + ' 次仍失败');
}

// 删除也加 409 重试
async function ghDelete(env, path, message, maxRetries = GH_MAX_RETRIES) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const existing = await ghGetFile(env, path);
      if (!existing) return null;
      const body = { message, sha: existing.sha };
      if (env.BRANCH) body.branch = env.BRANCH;
      const resp = await ghRequest(env, path, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (resp.ok) return await resp.json();

      const t = await resp.text().catch(() => '');
      if (resp.status === 409 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw new Error('GitHub DELETE ' + path + ': ' + resp.status + ' ' + t.slice(0, 200));
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('GitHub DELETE ' + path + ': 并发冲突，重试 ' + maxRetries + ' 次仍失败');
}

async function ghReadJson(env, path) {
  const f = await ghGetFile(env, path);
  if (!f || !f.content) return [];
  const parsed = JSON.parse(base64ToUtf8(f.content));
  return Array.isArray(parsed) ? parsed : [];
}

async function ghMutateJson(env, path, message, mutator, maxRetries = GH_MAX_RETRIES) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const f = await ghGetFile(env, path);
      let list = [];
      if (f && f.content) {
        const parsed = JSON.parse(base64ToUtf8(f.content));
        list = Array.isArray(parsed) ? parsed : [];
      }
      const out = mutator(list);
      if (out && out.skip) return { list, result: out };

      const bytes = new TextEncoder().encode(JSON.stringify(list, null, 2));
      const resp = await ghPutRaw(env, path, bytes, message, f && f.sha);
      if (resp.ok) return { list, result: out };

      const t = await resp.text().catch(() => '');
      if (resp.status === 409 && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw new Error('GitHub PUT ' + path + ': ' + resp.status + ' ' + t.slice(0, 200));
    } catch (e) {
      lastErr = e;
      if (isConflictError(e) && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, backoffMs(attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('GitHub PUT ' + path + ': 并发冲突，重试 ' + maxRetries + ' 次仍失败');
}

// ============================================================
// GD API 代理
// ============================================================
async function gdProxy(params) {
  const url = new URL(GD_API);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let resp;
  try {
    resp = await fetchWithTimeout(url.toString(), {
      headers: { 'User-Agent': UA_GD, 'Referer': 'https://music.gdstudio.xyz/' },
    }, 20000);
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      error: '上游不可达：' + (e && e.message ? e.message : String(e)),
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-GD-Source': 'worker-proxy',
      },
    });
  }

  let text = '';
  try {
    text = await resp.text();
  } catch (e) {
    text = '';
  }

  const status = resp.status || 502;
  if (!text) {
    return new Response(JSON.stringify({
      ok: false,
      error: '上游返回空响应 (HTTP ' + status + ')',
    }), {
      status: status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-GD-Source': 'worker-proxy',
      },
    });
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('<')) {
    return new Response(JSON.stringify({
      ok: false,
      error: '上游服务异常 (HTTP ' + status + ')',
      upstreamPreview: trimmed.slice(0, 160),
    }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'X-GD-Source': 'worker-proxy',
      },
    });
  }

  return new Response(text, {
    status: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'X-GD-Source': 'worker-proxy',
    },
  });
}

// ============================================================
// 业务：上传
// ============================================================
async function uploadSong(env, body) {
  const source   = body.source || 'netease';
  const trackId  = String(body.track_id || '').trim();
  const name     = body.name || 'Unknown';
  const artist   = body.artist || 'Unknown';
  const audioUrl = body.audio_url || '';
  const picUrl   = body.pic_url || '';
  const lrcText  = body.lyric || '';

  if (!trackId) return { ok: false, error: '缺少 track_id' };
  if (!audioUrl) return { ok: false, error: '缺少 audio_url（前端获取失败）' };

  const prefix    = buildPrefix(name, artist);
  const audioName = prefix + '.mp3';
  const audioPath = AUDIO_DIR + '/' + audioName;
  const picPath   = PIC_DIR   + '/' + prefix + '.jpg';
  const lrcPath   = LRC_DIR   + '/' + prefix + '.lrc';

  let audioResp;
  try {
    audioResp = await fetchWithTimeout(audioUrl, {
      headers: { 'User-Agent': UA_GD, 'Referer': 'https://music.gdstudio.xyz/' },
    }, 30000);
  } catch (e) {
    return { ok: false, error: '下载音频超时或失败: ' + (e.message || e) };
  }
  if (!audioResp.ok) return { ok: false, error: '下载音频失败: HTTP ' + audioResp.status };
  const audioBuf = await audioResp.arrayBuffer();
  if (audioBuf.byteLength === 0) return { ok: false, error: '音频内容为空' };

  if (audioBuf.byteLength > MAX_AUDIO_SIZE_BYTES) {
    const mb = (audioBuf.byteLength / 1024 / 1024).toFixed(1);
    return {
      ok: false,
      error: `音频文件 ${mb} MB，超过上传上限 ${MAX_AUDIO_SIZE_BYTES / 1024 / 1024} MB（请换音源或降低音质）`,
    };
  }

  let picBuf = null;
  if (picUrl) {
    try {
      const pr = await fetchWithTimeout(picUrl, { headers: { 'User-Agent': UA_GD } }, 15000);
      if (pr.ok) picBuf = await pr.arrayBuffer();
    } catch {}
  }

  try {
    const oldList = await ghReadJson(env, MUSIC_JSON);
    const old = oldList.find(s => String(s.id) === trackId && s.source === source);
    if (old && old.url_id && old.url_id !== audioName) {
      await ghDelete(env, AUDIO_DIR + '/' + safeSeg(old.url_id),
        'replace old audio: ' + name + ' - ' + artist).catch(() => {});
    }
  } catch {}

  await ghUpsert(env, audioPath, new Uint8Array(audioBuf), 'add audio: ' + name + ' - ' + artist);
  if (picBuf)  await ghUpsert(env, picPath, new Uint8Array(picBuf), 'add pic: ' + name + ' - ' + artist);
  if (lrcText) await ghUpsert(env, lrcPath, new TextEncoder().encode(lrcText), 'add lyric: ' + name + ' - ' + artist);

  const entry = {
    id: trackId, name, artist,
    pic_id:   picBuf  ? prefix + '.jpg' : '',
    url_id:   audioName,
    lyric_id: lrcText ? prefix + '.lrc' : '',
    source,
  };

  const mut = await ghMutateJson(env, MUSIC_JSON,
    'add to playlist: ' + name + ' - ' + artist,
    function(list) {
      const idx = list.findIndex(s => String(s.id) === trackId && s.source === source);
      if (idx >= 0) { list[idx] = entry; return { existed: true }; }
      list.push(entry); return { existed: false };
    });

  return {
    ok: true,
    message: mut.result.existed
      ? ('已存在，文件已更新：' + name + ' - ' + artist)
      : ('上传成功：' + name + ' - ' + artist),
    entry,
  };
}

async function deleteSong(env, body) {
  const trackId = String(body.track_id || '').trim();
  const source  = body.source || '';

  const list  = await ghReadJson(env, MUSIC_JSON);
  const found = list.find(s => String(s.id) === trackId && s.source === source);
  if (!found) return { ok: false, error: '歌单中未找到该歌曲' };

  const name   = found.name   || 'Unknown';
  const artist = found.artist || 'Unknown';

  const paths = [];
  if (found.url_id)   paths.push(AUDIO_DIR + '/' + safeSeg(found.url_id));
  if (found.pic_id)   paths.push(PIC_DIR   + '/' + safeSeg(found.pic_id));
  if (found.lyric_id) paths.push(LRC_DIR   + '/' + safeSeg(found.lyric_id));
  const errors = [];
  for (const p of paths) {
    try { await ghDelete(env, p, 'delete: ' + name + ' - ' + artist); }
    catch (e) { errors.push(p + ': ' + e.message); }
  }

  const mut = await ghMutateJson(env, MUSIC_JSON,
    'remove from playlist: ' + name + ' - ' + artist,
    function(list) {
      const idx = list.findIndex(s => String(s.id) === trackId && s.source === source);
      if (idx < 0) return { skip: true, existed: false };
      list.splice(idx, 1);
      return { existed: true };
    });

  return {
    ok: true,
    message: mut.result.existed
      ? ('已删除：' + name + ' - ' + artist)
      : ('索引中已无该条目：' + name + ' - ' + artist),
    errors: errors.length ? errors : undefined,
  };
}

// ============================================================
// API 路由
// ============================================================
async function handleApi(request, env, subpath) {
  const method = request.method;
  if (method === 'OPTIONS') return corsPreflight();

  // 登录：返回签名 token（不再回传密码）
  if (subpath === 'login' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }

    if (!env.PASSWORD) {
      const token = await generateToken(env);
      return jsonResponse({ ok: true, token });
    }
    if (body.password === env.PASSWORD) {
      const token = await generateToken(env);
      return jsonResponse({ ok: true, token });
    }
    return jsonResponse({ error: '密码错误' }, 401);
  }

  if (!(await checkAuth(request, env))) return jsonResponse({ error: 'unauthorized' }, 401);

  // 调试端点
  if (subpath === 'debug' && method === 'GET') {
    let contentsPreview = '';
    let rawCount = 0;
    let rawError = '';
    try {
      const list = await ghReadJson(env, MUSIC_JSON);
      rawCount = list.length;
      contentsPreview = list.slice(0, 3).map(s => s.name + ' - ' + s.artist).join(' | ');
    } catch (e) {
      rawError = e.message;
    }
    return jsonResponse({
      repo: env.REPO_NAME,
      branch: env.BRANCH || 'main',
      musicJsonPath: MUSIC_JSON,
      msBase: 'same-origin',
      hasToken: !!env.GITHUB_TOKEN,
      tokenPrefix: (env.GITHUB_TOKEN || '').slice(0, 8) + '...',
      musicJsonCount: rawCount,
      firstThree: contentsPreview,
      maxAudioSizeBytes: MAX_AUDIO_SIZE_BYTES,
      gdProxyLimit: GD_PROXY_MAX,
      gdProxyWindowSec: GD_PROXY_WINDOW / 1000,
      hasDeployHook: !!env.CF_DEPLOY_HOOK_URL,
      tokenTTLMs: TOKEN_TTL_MS,
      error: rawError || null,
      serverTime: new Date().toISOString(),
    });
  }

  // 调试端点：探 GD API
  if (subpath === 'debug-gd' && method === 'GET') {
    const t0 = Date.now();
    let status = 0;
    let bodyPreview = '';
    let errMsg = '';
    let elapsed = 0;
    try {
      const resp = await fetchWithTimeout(
        GD_API + '?types=search&source=netease&name=test&count=1',
        { headers: { 'User-Agent': UA_GD, 'Referer': 'https://music.gdstudio.xyz/' } },
        20000
      );
      status = resp.status;
      elapsed = Date.now() - t0;
      const txt = await resp.text().catch(() => '');
      bodyPreview = txt.slice(0, 400);
    } catch (e) {
      errMsg = (e && e.message) ? e.message : String(e);
      elapsed = Date.now() - t0;
    }
    return jsonResponse({
      upstream: GD_API,
      status: status,
      elapsedMs: elapsed,
      bodyPreview: bodyPreview,
      error: errMsg || null,
      serverTime: new Date().toISOString(),
    });
  }

  // GD 代理
  if (subpath === 'gd' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!gdThrottleCheck(ip)) {
      return jsonResponse({ ok: false, error: 'Worker 代理配额已用尽，请稍后重试' }, 429);
    }
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
    try {
      return await gdProxy(body.params || {});
    } catch (e) {
      return jsonResponse({ ok: false, error: '代理内部错误：' + (e.message || String(e)) }, 500);
    }
  }

  // 歌单：索引从 GitHub 读，播放资源指向同源 Pages CDN
  if (subpath === 'library' && method === 'GET') {
    const origin = new URL(request.url).origin;
    const list = await ghReadJson(env, MUSIC_JSON);
    const enhanced = list.map(function(s) {
      return {
        id: s.id, name: s.name, artist: s.artist, source: s.source,
        pic_id:   s.pic_id   || '',
        url_id:   s.url_id   || '',
        lyric_id: s.lyric_id || '',
        url:   s.url_id   ? origin + '/url/' + encodeURIComponent(s.url_id)   : '',
        pic:   s.pic_id   ? origin + '/pic/' + encodeURIComponent(s.pic_id)   : '',
        lyric: s.lyric_id ? origin + '/lrc/' + encodeURIComponent(s.lyric_id) : '',
      };
    });
    return jsonResponse({ ok: true, list: enhanced });
  }

  if (subpath === 'upload' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
    const result = await uploadSong(env, body);
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  if (subpath === 'delete' && method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return jsonResponse({ error: 'invalid json' }, 400); }
    const result = await deleteSong(env, body);
    return jsonResponse(result, result.ok ? 200 : 500);
  }

  // CF Pages 部署挂钩代理
  if (subpath === 'deploy' && method === 'POST') {
    const hookUrl = env.CF_DEPLOY_HOOK_URL;
    if (!hookUrl) {
      return jsonResponse({ ok: false, error: '未配置 CF_DEPLOY_HOOK_URL 环境变量' }, 500);
    }
    try {
      const resp = await fetchWithTimeout(hookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, 15000);
      if (!resp.ok) {
        const t = await resp.text().catch(() => '');
        return jsonResponse({
          ok: false,
          error: '部署挂钩请求失败: HTTP ' + resp.status + (t ? ' ' + t.slice(0, 120) : ''),
        }, 502);
      }
      return jsonResponse({ ok: true, message: '部署已触发' });
    } catch (e) {
      return jsonResponse({
        ok: false,
        error: '部署挂钩请求异常: ' + (e.message || String(e)),
      }, 502);
    }
  }

  return jsonResponse({ error: 'not found' }, 404);
}

// ============================================================
// Pages Function 入口
// ============================================================
export async function onRequest(context) {
  const { request, env } = context;
  const subpath = new URL(request.url).pathname.slice('/api/'.length);
  try {
    return await handleApi(request, env, subpath);
  } catch (e) {
    const msg = e.message || String(e);

    // GitHub 并发冲突 → 409 + 明确文案
    if (isConflictError(e)) {
      return jsonResponse({
        ok: false,
        error: '文件写入冲突（另一个上传操作正在进行中），请等 3-5 秒后重试',
      }, 409);
    }

    // 其他 GitHub 错误也归类
    if (/GitHub (PUT|DELETE|GET) /.test(msg)) {
      return jsonResponse({ ok: false, error: 'GitHub 操作失败：' + msg }, 502);
    }

    return jsonResponse({ ok: false, error: msg }, 500);
  }
}
