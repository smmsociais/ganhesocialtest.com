// /api/user-following.js
import axios from "axios";

const RAPID_HOST = "cybrix-bytedance1.p.rapidapi.com";
const BASE = `https://${RAPID_HOST}`;

// paths candidatos (ordem tentativa)
const CANDIDATE_PATHS = [
  "/scraping/user/followings",
  "/scraping/user/following",
  "/scraping/user/followers",
  "/scraping/user/follows",
  "/scraping/user/following/list",
  "/scraping/user/followList",
  "/user/followings",
  "/user/followers"
];

function normalizeEntry(e) {
  // tenta extrair campos comuns, adapte conforme o formato real da resposta
  return {
    id: e?.id || e?.user_id || e?.uid || e?.userId || null,
    uniqueId: e?.uniqueId || e?.uniqueId || e?.unique_id || e?.unique || null,
    nickname: e?.nickname || e?.nick || e?.name || "",
    avatar: e?.avatar || e?.avatar_medium || e?.avatar_thumb || null
  };
}

async function doPostJson(url, key, body) {
  try {
    const r = await axios.post(url, body, {
      headers: {
        "x-rapidapi-key": key,
        "x-rapidapi-host": RAPID_HOST,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      timeout: 10000
    });
    return { ok: true, status: r.status, data: r.data };
  } catch (err) {
    return {
      ok: false,
      status: err.response?.status,
      data: err.response?.data || err.message
    };
  }
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido. Use GET ?userId=..." });

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Parâmetro 'userId' é obrigatório." });

  const key = process.env.RAPIDAPI_KEY || process.env.rapidapi_key;
  if (!key) {
    console.error("RAPIDAPI_KEY não está definida no ambiente.");
    return res.status(500).json({ error: "RAPIDAPI_KEY não configurada." });
  }

  const attempts = [];

  // tenta POST JSON nos paths candidatos
  for (const p of CANDIDATE_PATHS) {
    const url = BASE + p;
    const attempt = await doPostJson(url, key, { username: String(userId) });
    attempts.push({ path: p, result: attempt });

    if (attempt.ok && attempt.status === 200 && attempt.data) {
      // encontrou resposta válida — tenta normalizar
      const payload = attempt.data;

      // O formato do provider pode estar em payload.data.list / payload.data.followings / payload.data.following
      let list =
        payload?.data?.list ||
        payload?.data?.followings ||
        payload?.data?.following ||
        payload?.data?.followers ||
        payload?.data ||
        payload?.followings ||
        payload?.following ||
        null;

      // Se list for um objeto contendo subcampo, tente extrair arrays
      if (!Array.isArray(list) && typeof list === "object") {
        // procura o primeiro array dentro de payload.data
        const v = Object.values(payload.data || {}).find((val) => Array.isArray(val));
        if (Array.isArray(v)) list = v;
      }

      if (!Array.isArray(list)) {
        // às vezes o provider retorna um objeto com "users" ou similar
        if (Array.isArray(payload?.data?.users)) list = payload.data.users;
      }

      if (!Array.isArray(list)) {
        // se não conseguimos extrair um array, devolve todo o provider_raw para inspeção
        return res.status(200).json({
          success: true,
          provider_status: attempt.status,
          provider_raw: payload,
          note: "Resposta recebida, mas não foi possível extrair lista de followings automaticamente. Veja provider_raw."
        });
      }

      // normaliza e retorna
      const normalized = list.map(normalizeEntry);
      return res.status(200).json({
        success: true,
        provider_status: attempt.status,
        path: p,
        total: normalized.length,
        followings: normalized
      });
    }
  }

  // se chegou aqui, nada funcionou — retorna todas as tentativas para debug
  return res.status(502).json({
    error: "Não foi possível consultar followings em nenhum endpoint candidato.",
    attempts
  });
}
