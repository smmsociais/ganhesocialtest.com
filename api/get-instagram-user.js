// /api/get-instagram-user.js
// Proxy de imagem + endpoint de consulta ao Instagram (RapidAPI)

import axios from "axios";

/**
 * 2 modos:
 *  - ?username=...  -> busca dados do Instagram e retorna { user: {..., profile_pic_proxy } }
 *  - ?image_url=... -> proxy (stream) para evitar bloqueios CORS do CDN do Instagram
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
  } catch (e) {
    return false;
  }
}

export default async function handler(req, res) {
  // modo proxy de imagem
  const { image_url: imageUrl } = req.query;
  if (imageUrl) {
    try {
      const decoded = decodeURIComponent(imageUrl);

      // segurança mínima: só aceitar http(s)
      if (!/^https?:\/\//i.test(decoded)) {
        return res.status(400).send("Invalid image URL");
      }

      // opcional: restringir a hosts plausíveis do Instagram para reduzir abuso
      if (!isProbablyInstagramHost(decoded)) {
        // não é estritamente necessário, mas melhora segurança
        console.warn("Image proxy blocked (host not in allowlist):", decoded);
        return res.status(400).send("Image host not allowed");
      }

      // Requisição ao CDN do Instagram (arraybuffer)
      const resp = await axios.get(decoded, {
        responseType: "arraybuffer",
        timeout: 15000,
        headers: {
          // fingir navegador / referer para reduzir bloqueios
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
          Referer: "https://www.instagram.com/"
        },
        validateStatus: status => status >= 200 && status < 400
      });

      const contentType = resp.headers["content-type"] || "image/jpeg";
      const body = Buffer.from(resp.data, "binary");

      // NÃO repassar headers problemáticos do CDN (Cross-Origin-Resource-Policy, COEP, COOP, CSP, etc.)
      // Em vez disso, definimos explicitamente os headers que queremos enviar ao cliente.
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(body.length));
      res.setHeader("Cache-Control", `public, max-age=${IMAGE_CACHE_SECONDS}`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      res.setHeader("Vary", "Origin");
      // permissivo — se preferir mais seguro, mude Access-Control-Allow-Origin para seu domínio

      // opcional: informar ao browser que essa imagem pode ser usada cross-origin
      // (alguns navegadores respeitam Cross-Origin-Resource-Policy — colocar cross-origin ajuda)
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

      return res.status(200).send(body);
    } catch (err) {
      // log detalhado para debugging (sem vazar conteúdo sensível)
      console.error("Erro no proxy de imagem:", err?.response?.status || err.message || err);
      const status = err?.response?.status || 500;
      // se o CDN retornou 403/401, repassamos 502 (bad gateway) para indicar problema externo
      if (status === 403 || status === 401) return res.status(502).send("Failed to proxy image (forbidden)");
      if (status === 404) return res.status(404).send("Image not found");
      return res.status(500).send("Failed to proxy image");
    }
  }

  // modo normal: buscar usuário do instagram via RapidAPI
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
      profile_pic,        // URL original (útil para debug)
      profile_pic_proxy,  // URL que o frontend deve usar para exibir (proxy)
      is_private,
      is_verified,
      follower_count,
      following_count,
      media_count
    };

    // debug raw payload se ?debug=1
    if (req.query?.debug === "1") {
      user.raw = payload;
    }

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
