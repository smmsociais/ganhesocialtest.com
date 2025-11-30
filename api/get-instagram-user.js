// /api/get-instagram-user.js
import axios from "axios";

/**
 * 2 modos:
 *  - ?username=...  -> busca dados do Instagram e retorna { user: {..., profile_pic_proxy } }
 *  - ?image_url=... -> proxy (stream) para evitar bloqueios CORS do CDN do Instagram
 *
 * Melhorias:
 *  - parsing tolerante do query param (tratamento de decodeURIComponent com fallback)
 *  - aceita image_url em query ou body (útil para POST)
 *  - tenta reconstruir URLs não-encoded juntando parâmetros típicos do CDN do Instagram
 *  - allowlist de hosts para reduzir abuso
 *  - não repassa headers do CDN e define explicitamente headers de resposta
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

/**
 * Reconstrói uma possível image_url quando a query foi dividida por '&'.
 * - se image_url inicial não começa com http, tenta anexar keys conhecidas (insta) encontradas em req.query
 * - fallback: tenta extrair do req.originalUrl tudo que vier após 'image_url='
 */
function tryReconstructImageUrl(originalUrl, parsedQueryObj, initialCandidate) {
  let candidate = initialCandidate ?? "";
  // Se já é um URL válido, devolve
  if (/^https?:\/\//i.test(candidate)) return candidate;

  // Tentar juntar parâmetros conhecidos do Instagram (ex.: oh, oe, _nc_ht, ig_cache_key, etc.)
  // Começamos com o que veio no parsedQueryObj.image_url (mesmo que truncado)
  const parts = [];
  if (candidate) parts.push(candidate);

  for (const [key, val] of Object.entries(parsedQueryObj)) {
    if (key === "image_url") continue;
    if (INSTAGRAM_QUERY_PARTS.has(key) && typeof val === "string") {
      // add as key=value
      parts.push(`${key}=${val}`);
    }
  }

  if (parts.length > 0) {
    // se a primeira parte não contém '?', criar '?'
    // mas aqui candidate pode já incluir '?' se o cliente enviou parcialmente; então juntamos com '&'
    const joined = parts.join("&");
    // se a primeira parte já começa com 'http' apenas retorne joined (já deve conter a base)
    if (/^https?:\/\//i.test(parts[0])) {
      return joined;
    }
  }

  // Fallback mais agressivo: extrair raw substring após 'image_url=' no originalUrl
  try {
    if (originalUrl && originalUrl.includes("image_url=")) {
      const after = originalUrl.split("image_url=")[1];
      if (after) {
        // originalUrl pode conter outros parâmetros depois; assumimos que o cliente enviou a URL inteira sem encode,
        // então tentamos recuperar até o final da string (pois os & que pertencem à imagem também estão ali).
        // Para evitar incluir parâmetros legítimos que venham depois, tentamos URL-decode e checar se começa com http.
        const maybe = decodeURIComponent(after);
        // Se tiver outros params depois separados por ' & ' que não pertencem, muitas vezes 'maybe' ainda começará com http.
        const possible = maybe.split("&").map(s => s.trim()).filter(Boolean).join("&");
        if (/^https?:\/\//i.test(possible)) return possible;
        // se decodeURIComponent falhar ou não começar com http, retornar the initialCandidate
      }
    }
  } catch (e) {
    // ignore
  }

  // Se nada funcionou, devolve initialCandidate (pode ser truncado)
  return initialCandidate;
}

export default async function handler(req, res) {
  // --- modo proxy de imagem ---
  // Aceita image_url via query ou via body (POST)
  let rawImageUrl = req.query?.image_url ?? req.body?.image_url;

  // Tentar também casos em que Express quebrou a query; parsedQueryObj é req.query
  const parsedQueryObj = req.query ?? {};

  if (rawImageUrl) {
    // try decode safely
    let decoded = safeDecode(rawImageUrl);

    // If decoded doesn't start with http, attempt reconstruction by joining instagram param fragments
    if (!/^https?:\/\//i.test(decoded)) {
      const reconstructed = tryReconstructImageUrl(req.originalUrl, parsedQueryObj, decoded);
      decoded = reconstructed ?? decoded;
    }

    // segurança mínima: só aceitar http(s)
    if (!/^https?:\/\//i.test(decoded)) {
      console.warn("[get-instagram-user] Invalid image_url param after attempts:", decoded, "req.query keys:", Object.keys(req.query || {}));
      return res.status(400).send("Invalid image URL (must be an absolute http(s) URL). Try encoding the URL or send it in the request body.");
    }

    // opcional: restringir a hosts plausíveis do Instagram para reduzir abuso
    if (!isProbablyInstagramHost(decoded)) {
      console.warn("[get-instagram-user] Image host not allowed:", (() => { try { return new URL(decoded).hostname } catch { return decoded } })());
      return res.status(400).send("Image host not allowed");
    }

    try {
      const resp = await axios.get(decoded, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
          // fingir navegador / referer para reduzir bloqueios
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
          Referer: "https://www.instagram.com/"
        },
        validateStatus: s => s >= 200 && s < 400,
        maxRedirects: 5
      });

      const contentType = resp.headers["content-type"] || "image/jpeg";
      const body = Buffer.from(resp.data, "binary");

      // NÃO propagar headers perigosos do upstream — definimos apenas os necessários
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(body.length));
      res.setHeader("Cache-Control", `public, max-age=${IMAGE_CACHE_SECONDS}`);
      // CORS para permitir uso cross-origin — ajuste para seu domínio se preferir
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Vary", "Origin");
      // reduzir chance de bloqueio por CRP
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      // valores permissivos compatíveis com a maioria dos usos de imagem
      res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");

      return res.status(200).send(body);
    } catch (err) {
      const upstreamStatus = err?.response?.status;
      console.error("[get-instagram-user] Erro no proxy de imagem:", upstreamStatus ?? "", err?.message ?? err);
      if (upstreamStatus === 403 || upstreamStatus === 401) {
        return res.status(502).send("Failed to proxy image (forbidden by origin)");
      }
      if (upstreamStatus === 404) {
        return res.status(404).send("Image not found");
      }
      return res.status(500).send("Failed to proxy image");
    }
  }

  // --- modo normal: buscar usuário do instagram via RapidAPI ---
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: "Parâmetro 'username' é obrigatório." });
  }

  const RAPIDAPI_KEY = process.env.rapidapi_key;
  if (!RAPIDAPI_KEY) {
    console.error("Env rapidapi_key não encontrada");
    return res.status(500).json({ error: "Configuração da API não encontrada (missing rapidapi_key)." });
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

    if (!payload || Object.keys(payload).length === 0) {
      console.warn("Instagram API retornou payload vazio para:", username, "resp:", resp);
      return res.status(404).json({ error: "Usuário do Instagram não encontrado." });
    }

    // Extrair campos principais
    const usernameRet = payload.username ?? payload.user?.username ?? null;
    const full_name = payload.full_name ?? payload.user?.full_name ?? null;
    const biography = payload.biography ?? payload.user?.biography ?? payload.biography_with_entities?.raw_text ?? null;
    const is_private = payload.is_private ?? payload.user?.is_private ?? false;
    const is_verified = payload.is_verified ?? payload.user?.is_verified ?? false;
    const follower_count = payload.follower_count ?? payload.user?.follower_count ?? null;
    const following_count = payload.following_count ?? payload.user?.following_count ?? null;
    const media_count = payload.media_count ?? payload.user?.media_count ?? null;

    // Encontrar melhor URL da imagem (vários locais possíveis)
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

    const profile_pic = profilePicCandidates.find(u => typeof u === "string" && /^https?:\/\//i.test(u)) || null;

    // gerar URL proxificada (mesma rota): /api/get-instagram-user?image_url=<enc>
    const profile_pic_proxy = profile_pic
      ? `/api/get-instagram-user?image_url=${encodeURIComponent(profile_pic)}`
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

    if (req.query?.debug === "1") user.raw = payload;

    return res.status(200).json({ user });
  } catch (error) {
    const status = error?.response?.status;
    console.error("Erro Instagram API:", status, error?.response?.data ?? error.message);

    if (status === 404) return res.status(404).json({ error: "Usuário não encontrado no Instagram." });
    if (status === 401 || status === 403) return res.status(502).json({ error: "Problema de autenticação com a API externa." });
    if (status === 429) return res.status(429).json({ error: "Limite da API Instagram atingido. Tente novamente em 1 minuto." });

    return res.status(500).json({ error: "Erro ao buscar dados do Instagram via API." });
  }
}
