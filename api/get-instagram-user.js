// /api/get-instagram-user.js
import axios from "axios";

/**
 * Rota com 2 modos:
 * 1) ?username=...  -> busca dados do Instagram e devolve { user: { ..., profile_pic_proxy } }
 * 2) ?image_url=... -> proxy da imagem (streamed) para evitar bloqueio CORS
 */

const IMAGE_CACHE_SECONDS = 300; // 5 minutos

export default async function handler(req, res) {
  // modo proxy de imagem: ?image_url=<url-enc>
  const { image_url: imageUrl } = req.query;
  if (imageUrl) {
    // Proxy de imagem
    try {
      const decoded = decodeURIComponent(imageUrl);
      // segurança mínima: só aceitar http(s)
      if (!/^https?:\/\//i.test(decoded)) {
        return res.status(400).send("Invalid image URL");
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
        }
      });

      const contentType = resp.headers["content-type"] || "image/jpeg";
      // Ajustar cache adequado
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", `public, max-age=${IMAGE_CACHE_SECONDS}`);
      return res.status(200).send(Buffer.from(resp.data, "binary"));
    } catch (err) {
      console.error("Erro no proxy de imagem:", err?.response?.status || err.message);
      // repassa status quando possível
      const status = err?.response?.status || 500;
      return res.status(status === 404 ? 404 : 500).send("Failed to proxy image");
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
