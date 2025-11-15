import axios from "axios";

export default async function handler(req, res) {
    if (req.method !== "POST") {
        return res.status(405).json({ error: "Método não permitido. Use POST." });
    }

    try {
        const { id_conta, id_pedido } = req.body;

        if (!id_conta || !id_pedido) {
            return res.status(400).json({ error: "ID da conta e ID do pedido são obrigatórios." });
        }

        const confirmUrl = "https://api.ganharnoinsta.com/confirm_action.php";

        const payload = {
            token: "afc012ec-a318-433d-b3c0-5bf07cd29430",
            sha1: "e5990261605cd152f26c7919192d4cd6f6e22227",
            id_conta: id_conta, // <-- Corrigido: estava usando "userId" que não existe aqui
            id_pedido: id_pedido,
            is_tiktok: "1"
        };

        console.log("Enviando requisição para confirm_action com os seguintes dados:", payload);

        const confirmResponse = await axios.post(confirmUrl, payload, {
            headers: { "Content-Type": "application/json" }
        });

        console.log("Resposta da API confirm_action:", confirmResponse.data);

        if (confirmResponse.data.status !== "success") {
            return res.status(400).json({ error: "Erro ao confirmar ação.", detalhes: confirmResponse.data });
        }

        return res.status(200).json({
            status: "success", // <-- Corrigido para que o frontend aceite
            message: "CONFIRMOU_SUCESSO", // <-- Corrigido para que o frontend aceite
            valor: confirmResponse.data.valor // <-- Repassa o valor exato da API
        });

    } catch (error) {
        console.error("Erro na requisição confirm_action:", error.response?.data || error.message);
        return res.status(500).json({ error: "Erro na requisição confirm_action.", detalhes: error.response?.data });
    }
}