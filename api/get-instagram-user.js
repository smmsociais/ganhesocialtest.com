// /api/get-instagram-user.js
import axios from "axios";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido." });
  }

  const { username } = req.query;
  if (!username) {
    return res.status(400).json({ error: "Parâmetro 'username' é obrigatório." });
  }

  const RAPIDAPI_KEY = process.env.rapidapi_key; // confirme o nome da env
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
        "x-rapidapi-host": "instagram-social-api.p.rapidapi.com",
      },
      timeout: 15_000
    });

    const resp = response.data;

    // Normalize payload: algumas respostas têm { data: { ... } }, outras { user: {...} }
    const payload = resp?.data ?? resp?.user ?? resp;

    // Se payload é um envelope com 'data' ainda vazio -> 404
    if (!payload || Object.keys(payload).length === 0) {
      console.warn("Instagram API retornou payload vazio para:", username, "resp:", resp);
      return res.status(404).json({ error: "Usuário do Instagram não encontrado." });
    }

    // Extrair campos úteis (cobrir várias possíveis estruturas)
    const usernameRet = payload.username ?? payload.user?.username ?? null;
    const full_name = payload.full_name ?? payload.user?.full_name ?? null;
    const biography = payload.biography ?? payload.user?.biography ?? payload.biography_with_entities?.raw_text ?? null;
    const is_private = payload.is_private ?? payload.user?.is_private ?? false;
    const is_verified = payload.is_verified ?? payload.user?.is_verified ?? false;
    const follower_count = payload.follower_count ?? payload.user?.follower_count ?? null;
    const following_count = payload.following_count ?? payload.user?.following_count ?? null;
    const media_count = payload.media_count ?? payload.user?.media_count ?? null;

    // Prioridade para imagens:
    // 1) hd_profile_pic_url_info.url
    // 2) profile_pic_url_hd / profile_pic_url
    // 3) hd_profile_pic_versions[0].url ou profile_pic / profile_pic_url
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

    const user = {
      username: usernameRet,
      full_name,
      biography,
      profile_pic,                      // principal (string URL) — usado pelo frontend
      hd_profile_pic_url_info: payload.hd_profile_pic_url_info ?? payload.user?.hd_profile_pic_url_info ?? null,
      profile_pic_url_hd: payload.profile_pic_url_hd ?? payload.user?.profile_pic_url_hd ?? null,
      is_private,
      is_verified,
      follower_count,
      following_count,
      media_count,
      raw: undefined // opcionalmente removível — não exponha em produção
    };

    // opcional: incluir payload bruto somente quando ?debug=1 (útil para dev)
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
