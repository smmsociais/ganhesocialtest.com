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

    const url = "https://instagram-social-api.p.rapidapi.com/v1/info";

    try {
        const response = await axios.get(url, {
            params: { username_or_id_or_url: username },
            headers: {
                "x-rapidapi-key": process.env.rapidapi_key,
                "x-rapidapi-host": "instagram-social-api.p.rapidapi.com",
            },
        });

        const data = response.data;

        if (!data || !data.user) {
            return res.status(404).json({ error: "Usuário do Instagram não encontrado." });
        }

        const user = data.user;

        // Retorno simplificado (somente campos essenciais)
        return res.json({
            username: user.username,
            full_name: user.full_name,
            biography: user.biography,
            profile_pic: user.hd_profile_pic_url_info?.url,
            is_private: user.is_private,
            is_verified: user.is_verified,
            followers: user.follower_count,
            following: user.following_count,
            posts: user.media_count
        });

    } catch (error) {
        console.error("Erro ao buscar dados no Instagram API:", error?.response?.data || error);

        if (error?.response?.status === 404) {
            return res.status(404).json({ error: "Usuário não encontrado no Instagram." });
        }

        if (error?.response?.status === 429) {
            return res.status(429).json({ error: "Limite da API Instagram atingido. Tente novamente em 1 minuto." });
        }

        return res.status(500).json({ error: "Erro ao buscar dados do Instagram via API." });
    }
}
