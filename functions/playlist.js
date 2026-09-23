// ========================================
// /playlist — 防盗链 + 拼装播放列表
//
// 白名单来源：环境变量 ALLOWED_DOMAINS（逗号分隔）
//   例：ALLOWED_DOMAINS = abc.pages.dev,music.example.com
//   不配置 = 任何带 Referer/Origin 的请求都会被 403 拒绝
// ========================================

// 生产环境建议设为 false，调试时可临时设为 true
const ALLOW_EMPTY_REQUEST = false;

// ========================================
// 白名单
// ========================================
function getAllowedDomains(env) {
  const raw = (env && env.ALLOWED_DOMAINS) || '';
  return raw
    .split(',')
    .map(d => d.trim().toLowerCase())
    .filter(Boolean);
}

function extractDomain(urlString) {
  if (!urlString) return null;
  try {
    return new URL(urlString).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
}

function isDomainAllowed(domain, env) {
  if (!domain) return false;
  const lower = domain.toLowerCase();
  const allowed = getAllowedDomains(env);
  return allowed.some(a => lower === a || lower.endsWith('.' + a));
}

function checkAntiLeech(request, env) {
  const referer = request.headers.get('Referer');
  const origin = request.headers.get('Origin');
  const refererDomain = extractDomain(referer);
  const originDomain = extractDomain(origin);

  if (origin && isDomainAllowed(originDomain, env)) {
    return { allowed: true, domain: originDomain };
  }
  if (referer && isDomainAllowed(refererDomain, env)) {
    return { allowed: true, domain: refererDomain };
  }
  if (origin || referer) {
    return {
      allowed: false,
      reason: `域名未授权 (Origin: ${originDomain || '无'}, Referer: ${refererDomain || '无'})`
    };
  }
  if (ALLOW_EMPTY_REQUEST) {
    return { allowed: true, domain: null };
  }
  return { allowed: false, reason: '禁止直接访问' };
}

// ========================================
// 工具
// ========================================
function safeFilename(name, artist) {
  const clean = (str) =>
    String(str == null ? '' : str)
      .replace(/[\s\u00A0\u3000]/g, ' ')
      .replace(/[\\/*?:"<>|]/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  return `${clean(name)} - ${clean(artist)}`;
}

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }
  });
}

// ========================================
// 主处理函数（仅 /playlist）
// ========================================
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // CORS 预检
  if (request.method === 'OPTIONS') {
    const origin = request.headers.get('Origin');
    const originDomain = extractDomain(origin);
    if (origin && isDomainAllowed(originDomain, env)) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin'
        }
      });
    }
    return new Response('CORS 未授权', { status: 403 });
  }

  // 防盗链
  const leechCheck = checkAntiLeech(request, env);
  if (!leechCheck.allowed) {
    return jsonResponse({ error: leechCheck.reason }, 403);
  }

  const allowOrigin = leechCheck.domain
    ? `https://${leechCheck.domain}`
    : '*';

  // 读 music.json 并拼装播放列表
  try {
    const assetReq = new URL('/music.json', url.origin);
    const assetResp = await env.ASSETS.fetch(assetReq);

    if (!assetResp.ok) {
      return jsonResponse(
        { error: 'music.json 文件不存在，请检查 public/music.json' },
        404,
        { 'Access-Control-Allow-Origin': allowOrigin, 'Vary': 'Origin, Referer' }
      );
    }

    const songs = await assetResp.json();
    const baseUrl = url.origin;

    const playlist = songs.map(song => {
      const filename = safeFilename(song.name, song.artist);
      return {
        name: song.name,
        artist: song.artist,
        id: song.id,
        source: song.source || '',
        url: `${baseUrl}/url/${encodeURIComponent(filename)}.mp3`,
        pic: `${baseUrl}/pic/${encodeURIComponent(filename)}.jpg`,
        lyric: `${baseUrl}/lrc/${encodeURIComponent(filename)}.lrc`
      };
    });

    return jsonResponse(playlist, 200, {
      'Access-Control-Allow-Origin': allowOrigin,
      'Cache-Control': 'public, max-age=300',
      'Vary': 'Origin, Referer'
    });
  } catch (e) {
    return jsonResponse({ error: '服务器内部错误' }, 500, {
      'Access-Control-Allow-Origin': allowOrigin
    });
  }
}
