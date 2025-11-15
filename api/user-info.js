// /api/user-info.js
import axios from "axios";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido. Use GET com ?unique_id=..." });
  }

  const { unique_id } = req.query;
  if (!unique_id) return res.status(400).json({ error: "Parâmetro 'unique_id' é obrigatório." });

  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY || process.env.rapidapi_key;
  if (!RAPIDAPI_KEY) {
    console.error("RAPIDAPI_KEY não definido no ambiente.");
    return res.status(500).json({ error: "Chave de API não configurada no servidor (RAPIDAPI_KEY)." });
  }

  const url = "https://cybrix-bytedance1.p.rapidapi.com/scraping/user/info";
  const headers = {
    "x-rapidapi-key": RAPIDAPI_KEY,
    "x-rapidapi-host": "cybrix-bytedance1.p.rapidapi.com",
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  try {
    // provider expects POST + JSON { username }
    const providerResp = await axios.post(url, { username: unique_id }, { headers, timeout: 10000 });

    const providerData = providerResp.data;

    // Normaliza para um objeto mais simples se possível (ajuste conforme sua necessidade)
    const normalized = {
      success: providerData?.code === 0 || providerData?.message === "success" || providerResp.status === 200,
      provider_status: providerResp.status,
      provider_raw: providerData,
      // tentamos mapear campos comuns que seu frontend provavelmente usa:
      user: {
        uniqueId: providerData?.data?.user?.uniqueId || providerData?.data?.user?.uniqueId || providerData?.data?.user?.uniqueId,
        user_id: providerData?.data?.user?.user_id || providerData?.data?.user?.user_id || providerData?.data?.user?.user_id,
        nickname: providerData?.data?.user?.nickname || providerData?.data?.user?.nickname || "",
        avatar: providerData?.data?.user?.avatar_medium || providerData?.data?.user?.avatar_thumb || providerData?.data?.user?.avatar_larger || null,
        is_private: Boolean(providerData?.data?.user?.is_private_account)
      },
      stats: providerData?.data?.stats || providerData?.data?.stats || null
    };

    return res.status(200).json(normalized);
  } catch (err) {
    console.error("Erro ao buscar dados do TikTok (user-info):", err.message);

    if (err.response) {
      // devolve o que o provedor retornou para facilitar debug
      return res.status(502).json({
        error: "Erro da API externa ao buscar dados do TikTok.",
        provider_status: err.response.status,
        provider_data: err.response.data
      });
    }

    return res.status(500).json({ error: "Erro ao buscar dados do TikTok.", details: err.message });
  }
}
