// /api/get-user.js
import axios from "axios";

export default async function handler(req, res) {
    if (req.method !== "GET") {
        return res.status(405).json({ error: "Método não permitido." });
    }

    const { unique_id } = req.query;

    if (!unique_id) {
        return res.status(400).json({ error: "Parâmetro 'unique_id' é obrigatório." });
    }

    const url = "https://scraptik.p.rapidapi.com/get-user";

    try {
        const response = await axios.get(url, {
            params: { username: unique_id },
            headers: {
                "x-rapidapi-key": process.env.rapidapi_key,
                "x-rapidapi-host": "scraptik.p.rapidapi.com",
            },
        });

        const data = response.data;

        // Scraptik estrutura válida: data.user
        if (!data || !data.user) {
            return res.status(404).json({ error: "Nenhuma informação encontrada para esse usuário." });
        }

        res.json(data);

    } catch (error) {
        console.error("Erro ao buscar dados no Scraptik:", error?.response?.data || error);

        // Tratamento de erros específicos Scraptik
        if (error?.response?.status === 404) {
            return res.status(404).json({ error: "Usuário não encontrado no Scraptik." });
        }

        res.status(500).json({ error: "Erro ao buscar dados do TikTok via Scraptik." });
    }
}
