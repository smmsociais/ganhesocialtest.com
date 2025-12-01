// /api/get-instagram-user.js
import axios from "axios";

/**
 * 2 modos:
 *  - ?username=...  -> busca dados do Instagram e retorna { user: {..., profile_pic_proxy } }
 *  - ?image_url=... -> proxy (stream) para evitar bloqueios CORS do CDN do Instagram
 *
 * Melhorias adicionadas nesta versão:
 *  - inclui `owner` no profile_pic_proxy (para usar Referer correto)
 *  - proxy aprimorado: tenta variações de host/headers e múltiplas tentativas
 *  - fallback: ao receber 403 do CDN, reconsulta a API RapidAPI para obter nova URL e tenta novamente
 *  - logs detalhados para debugging
 */

const IMAGE_CACHE_SECONDS = 300; // 5 minutos
const ALLOWED_IMAGE_HOSTS = [
  "instagram.com",
  "cdninstagram.com",
  "scontent.cdninstagram.com",
  "scontent-sjc6-1.cdninstagram.com",
  "facebook.com",
  "fbcdn.net"
];

// parâmetros que frequentemente aparecem como query params do CDN do Instagram
const INSTAGRAM_QUERY_PARTS = new Set([
  "efg", "_nc_ht", "_nc_cat", "_nc_oc", "_nc_ohc", "_nc_gid",
  "edm", "ccb", "ig_cache_key", "oh", "oe", "_nc_sid", "igshid"
]);

function isProbablyInstagramHost(url) {
  try {
    const u = new URL(url);
    return ALLOWED_IMAGE_HOSTS.some(h => u.hostname.includes(h) || u.hostname.endsWith(h));
  } catch {
    return false;
  }
}

function safeDecode(input) {
  if (!input || typeof input !== "string") return input;
  const trimmed = input.trim().replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(trimmed);
  } catch (e) {
    return trimmed;
  }
}

function tryReconstructImageUrl(originalUrl, parsedQueryObj, initialCandidate) {
  let candidate = initialCandidate ?? "";
  if (/^https?:\/\//i.test(candidate)) return candidate;

  const parts = [];
  if (candidate) parts.push(candidate);

  for (const [key, val] of Object.entries(parsedQueryObj)) {
    if (key === "image_url") continue;
    if (INSTAGRAM_QUERY_PARTS.has(key) && typeof val === "string") {
      parts.push(`${key}=${val}`);
    }
  }

  if (parts.length > 0) {
    const joined = parts.join("&");
    if (/^https?:\/\//i.test(parts[0])) {
      return joined;
    }
  }

  try {
    if (originalUrl && originalUrl.includes("image_url=")) {
      const after = originalUrl.split("image_url=")[1];
      if (after) {
        const maybe = decodeURIComponent(after);
        const possible = maybe.split("&").map(s => s.trim()).filter(Boolean).join("&");
        if (/^https?:\/\//i.test(possible)) return possible;
      }
    }
  } catch (e) {
    // ignore
  }

  return initialCandidate;
}

async function fetchProfileFromRapidAPI(username) {
  const RAPIDAPI_KEY = process.env.rapidapi_key;
  if (!RAPIDAPI_KEY) {
    console.warn('[get-instagram-user] RapidAPI key not configured');
    return null;
  }
  const url = "https://instagram-social-api.p.rapidapi.com/v1/info";
  try {
    const response = await axios.get(url, {
      params: { username_or_id_or_url: username },
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": "instagram-social-api.p.rapidapi.com"
      },
      timeout: 15000
    });
    const resp = response.data;
    const payload = resp?.data ?? resp?.user ?? resp;
    return payload || null;
  } catch (e) {
    console.warn('[get-instagram-user] RapidAPI refresh failed for', username, e?.response?.status ?? e?.message ?? e);
    return null;
  }
}

export default async function handler(req, res) {
  // --- modo proxy de imagem ---
  let rawImageUrl = req.query?.image_url ?? req.body?.image_url;
  const parsedQueryObj = req.query ?? {};

  if (rawImageUrl) {
    let decoded = safeDecode(rawImageUrl);

    if (!/^https?:\/\//i.test(decoded)) {
      const reconstructed = tryReconstructImageUrl(req.originalUrl, parsedQueryObj, decoded);
      decoded = reconstructed ?? decoded;
    }

    if (!/^https?:\/\//i.test(decoded)) {
      console.warn('[get-instagram-user] Invalid image_url param after attempts:', decoded, 'req.query keys:', Object.keys(req.query || {}));
      return res.status(400).send('Invalid image URL (must be an absolute http(s) URL). Try encoding the URL or send it in the request body.');
    }

    if (!isProbablyInstagramHost(decoded)) {
      console.warn('[get-instagram-user] Image host not allowed:', (() => { try { return new URL(decoded).hostname } catch { return decoded } })());
      return res.status(400).send('Image host not allowed');
    }

    // BEGIN: improved proxy logic
    const owner = req.query?.owner ?? null; // used to set Referer

    function hostVariants(u) {
      try {
        const urlObj = new URL(u);
        const host = urlObj.hostname;
        const variants = new Set([host]);
        if (host.startsWith('scontent')) {
          variants.add('scontent.cdninstagram.com');
        }
        variants.add(host.replace(/-[a-z0-9]+/gi, ''));
        return Array.from(variants);
      } catch { return []; }
    }

    function makeUrlWithHost(u, newHost) {
      try {
        const nu = new URL(u);
        nu.hostname = newHost;
        return nu.toString();
      } catch { return u; }
    }

    const candidateUrls = [];
    candidateUrls.push(decoded);
    for (const h of hostVariants(decoded)) {
      const v = makeUrlWithHost(decoded, h);
      if (!candidateUrls.includes(v)) candidateUrls.push(v);
    }

    try {
      const uobj = new URL(decoded);
      const qp = uobj.searchParams;
      if (qp.has('stp')) {
        const copy = new URL(decoded);
        copy.searchParams.delete('stp');
        const s = copy.toString();
        if (!candidateUrls.includes(s)) candidateUrls.push(s);
      }
    } catch (e) { /* ignore */ }

    const headerSets = [
      {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Referer": owner ? `https://www.instagram.com/${owner}/` : "https://www.instagram.com/",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Referer": owner ? `https://www.instagram.com/${owner}/` : "https://www.instagram.com/",
        "Accept": "image/*,*/*;q=0.8"
      }
    ];

    let lastErr = null;

    // Try each candidate URL with each header set
    for (const cUrl of candidateUrls) {
      for (const hs of headerSets) {
        try {
          const resp = await axios.get(cUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: hs,
            validateStatus: s => s >= 200 && s < 400,
            maxRedirects: 5
          });

          const contentType = resp.headers['content-type'] || 'image/jpeg';
          const body = Buffer.from(resp.data, 'binary');

          res.setHeader('Content-Type', contentType);
          res.setHeader('Content-Length', String(body.length));
          res.setHeader('Cache-Control', `public, max-age=${IMAGE_CACHE_SECONDS}`);
          res.setHeader('Access-Control-Allow-Origin', '*');
          res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
          res.setHeader('Vary', 'Origin');
          res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
          res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

          console.info('[get-instagram-user] proxy success', { url: cUrl, owner });
          return res.status(200).send(body);
        } catch (e) {
          lastErr = e;
          const code = e?.response?.status;
          console.warn('[get-instagram-user] proxy attempt failed', { url: cUrl, status: code, owner, msg: e?.message });
          // continue to next combo
        }
      }
    }

    // If we got here, all attempts failed. If 403/401, try refreshing the profile via RapidAPI (if owner provided)
    const upstreamStatus = lastErr?.response?.status;
    console.warn('[get-instagram-user] all proxy attempts failed', { upstreamStatus, owner });

    if ((upstreamStatus === 403 || upstreamStatus === 401) && owner) {
      console.info('[get-instagram-user] attempting RapidAPI refresh for owner', owner);
      const refreshed = await fetchProfileFromRapidAPI(owner);
      if (refreshed) {
        // try to extract a new profile pic URL from refreshed payload
        const candidates = [
          refreshed.hd_profile_pic_url_info?.url,
          refreshed.profile_pic_url_hd,
          refreshed.profile_pic_url,
          refreshed.profile_pic,
          Array.isArray(refreshed.hd_profile_pic_versions) ? refreshed.hd_profile_pic_versions[0]?.url : null,
          Array.isArray(refreshed.profile_pic_versions) ? refreshed.profile_pic_versions[0]?.url : null,
          refreshed.user?.profile_pic_url_hd,
          refreshed.user?.profile_pic_url,
          refreshed.user?.profile_pic
        ].filter(Boolean);

        for (const newPic of candidates) {
          try {
            const newDecoded = newPic;
            if (!isProbablyInstagramHost(newDecoded)) continue;

            for (const hs of headerSets) {
              try {
                const resp = await axios.get(newDecoded, {
                  responseType: 'arraybuffer',
                  timeout: 15000,
                  headers: hs,
                  validateStatus: s => s >= 200 && s < 400,
                  maxRedirects: 5
                });
                const contentType = resp.headers['content-type'] || 'image/jpeg';
                const body = Buffer.from(resp.data, 'binary');

                res.setHeader('Content-Type', contentType);
                res.setHeader('Content-Length', String(body.length));
                res.setHeader('Cache-Control', `public, max-age=${IMAGE_CACHE_SECONDS}`);
                res.setHeader('Access-Control-Allow-Origin', '*');
                res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
                res.setHeader('Vary', 'Origin');
                res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
                res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none');
                res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

                console.info('[get-instagram-user] proxy success after refresh', { url: newDecoded, owner });
                return res.status(200).send(body);
              } catch (e2) {
                console.warn('[get-instagram-user] attempt with refreshed url failed', { url: newDecoded, status: e2?.response?.status, msg: e2?.message });
                continue;
              }
            }
          } catch (inner) {
            // continue
          }
        }
      }
    }

    // nothing worked
    if (upstreamStatus === 403 || upstreamStatus === 401) {
      return res.status(502).send('Failed to proxy image (forbidden by origin)');
    }
    if (upstreamStatus === 404) {
      return res.status(404).send('Image not found');
    }
    return res.status(500).send('Failed to proxy image');
    // END: improved proxy logic
  }

  // --- modo normal: buscar usuário do instagram via RapidAPI ---
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: "Parâmetro 'username' é obrigatório." });
  }

  const RAPIDAPI_KEY = process.env.rapidapi_key;
  if (!RAPIDAPI_KEY) {
    console.error('Env rapidapi_key não encontrada');
    return res.status(500).json({ error: 'Configuração da API não encontrada (missing rapidapi_key).' });
  }

  const url = 'https://instagram-social-api.p.rapidapi.com/v1/info';

  try {
    const response = await axios.get(url, {
      params: { username_or_id_or_url: username },
      headers: {
        'x-rapidapi-key': RAPIDAPI_KEY,
        'x-rapidapi-host': 'instagram-social-api.p.rapidapi.com'
      },
      timeout: 15000
    });

    const resp = response.data;
    const payload = resp?.data ?? resp?.user ?? resp;

    if (!payload || Object.keys(payload).length === 0) {
      console.warn('Instagram API retornou payload vazio para:', username, 'resp:', resp);
      return res.status(404).json({ error: 'Usuário do Instagram não encontrado.' });
    }

    const usernameRet = payload.username ?? payload.user?.username ?? null;
    const full_name = payload.full_name ?? payload.user?.full_name ?? null;
    const biography = payload.biography ?? payload.user?.biography ?? payload.biography_with_entities?.raw_text ?? null;
    const is_private = payload.is_private ?? payload.user?.is_private ?? false;
    const is_verified = payload.is_verified ?? payload.user?.is_verified ?? false;
    const follower_count = payload.follower_count ?? payload.user?.follower_count ?? null;
    const following_count = payload.following_count ?? payload.user?.following_count ?? null;
    const media_count = payload.media_count ?? payload.user?.media_count ?? null;

    const profilePicCandidates = [
      payload.hd_profile_pic_url_info?.url,
      payload.profile_pic_url_hd,
      payload.profile_pic_url,
      payload.profile_pic,
      Array.isArray(payload.hd_profile_pic_versions) ? payload.hd_profile_pic_versions[0]?.url : null,
      Array.isArray(payload.profile_pic_versions) ? payload.profile_pic_versions[0]?.url : null,
      payload.user?.hd_profile_pic_url_info?.url,
      payload.user?.profile_pic_url_hd,
      payload.user?.profile_pic_url,
      payload.user?.profile_pic
    ];

    const profile_pic = profilePicCandidates.find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || null;

    // include owner in proxy URL so proxy can use owner as Referer
    const profile_pic_proxy = profile_pic
      ? `/api/get-instagram-user?image_url=${encodeURIComponent(profile_pic)}&owner=${encodeURIComponent(usernameRet ?? username)}`
      : null;

    const user = {
      username: usernameRet,
      full_name,
      biography,
      profile_pic,
      profile_pic_proxy,
      is_private,
      is_verified,
      follower_count,
      following_count,
      media_count
    };

    if (req.query?.debug === '1') user.raw = payload;

    return res.status(200).json({ user });
  } catch (error) {
    const status = error?.response?.status;
    console.error('Erro Instagram API:', status, error?.response?.data ?? error.message);

    if (status === 404) return res.status(404).json({ error: 'Usuário não encontrado no Instagram.' });
    if (status === 401 || status === 403) return res.status(502).json({ error: 'Problema de autenticação com a API externa.' });
    if (status === 429) return res.status(429).json({ error: 'Limite da API Instagram atingido. Tente novamente em 1 minuto.' });

    return res.status(500).json({ error: 'Erro ao buscar dados do Instagram via API.' });
  }
}
