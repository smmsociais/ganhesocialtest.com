import axios from "axios";

export default async function handler(req, res) {
        if (req.method !== "GET") {
            return res.status(405).json({ error: "Método não permitido." });
        }
    
        const { userId } = req.query;
    
        if (!userId) {
            return res.status(400).json({ error: "Parâmetro 'userId' é obrigatório." });
        }
    
        const userFollowingUrl = `https://tiktok-scraper7.p.rapidapi.com/user/following?user_id=${userId}&count=200&time=0`;
    
        try {
            const response = await axios.get(userFollowingUrl, {
                headers: {
                    "x-rapidapi-key":  process.env.rapidapi_key,
                    "x-rapidapi-host": "tiktok-scraper7.p.rapidapi.com"
                }
            });
    
            const data = response.data;
    
            if (!data || Object.keys(data).length === 0) {
                return res.status(404).json({ error: "Nenhuma informação de seguidores encontrada." });
            }
    
            res.json(data);
        } catch (error) {
            console.error("Erro ao buscar seguidores:", error);
            res.status(500).json({ error: "Erro ao buscar seguidores." });
        }
    }    
