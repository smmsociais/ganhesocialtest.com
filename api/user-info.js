import axios from "axios";

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Método não permitido." });
    }

    const { unique_id } = req.query;

    if (!unique_id) {
        return res.status(400).json({ error: "Parâmetro 'unique_id' é obrigatório." });
    }

    const url = `https://tiktok-scraper7.p.rapidapi.com/user/info?unique_id=${unique_id}`;

    try {
        const response = await axios.get(url, {
            headers: {
                "x-rapidapi-key": process.env.rapidapi_key,
                "x-rapidapi-host": "tiktok-scraper7.p.rapidapi.com",
            },
        });

        const data = response.data;

        if (!data || Object.keys(data).length === 0) {
            return res.status(404).json({ error: "Nenhuma informação encontrada para esse usuário." });
        }

        res.json(data);
    } catch (error) {
        console.error("Erro ao buscar dados do TikTok:", error);
        res.status(500).json({ error: "Erro ao buscar dados do TikTok." });
    }
}
