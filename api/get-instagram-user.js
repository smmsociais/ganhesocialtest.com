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
  // remover possíveis <> que alguns clientes adicionam
  const trimmed = input.trim().replace(/^<|>$/g, "");
  try {
    // tentar decodificar. se falhar, retorna original 'trimmed'
    return decodeURIComponent(trimmed);
  } catch (e) {
    return trimmed;
  }
}

export default async function handler(req, res) {
  // --- modo proxy de imagem ---
  const rawImageUrl = req.query?.image_url ?? req.body?.image_url;
  if (rawImageUrl) {
    const decoded = safeDecode(rawImageUrl);

    // segurança mínima: só aceitar http(s)
    if (!/^https?:\/\//i.test(decoded)) {
      console.warn("[get-instagram-user] Invalid image_url param:", decoded);
      return res.status(400).send("Invalid image URL (must be an absolute http(s) URL)");
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
        // aceita 2xx e 3xx (seguimos redirects automaticamente)
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
