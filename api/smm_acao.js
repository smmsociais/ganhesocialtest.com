import connectDB from './db.js';
import { Pedido } from "./schema.js";
import mongoose from 'mongoose';

const handler = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  try {
    // ------------------------------
    // 🔐 VALIDAÇÃO DE TOKEN
    // ------------------------------
    const { authorization } = req.headers;
    const token = authorization?.split(" ")[1];

    if (!token || token !== process.env.SMM_API_KEY) {
      return res.status(401).json({ error: "Não autorizado" });
    }

    await connectDB();

    // ------------------------------
    // 📦 CAMPOS DO BODY
    // ------------------------------
    const {
      tipo_acao,
      nome_usuario,
      quantidade_pontos,
      url_dir,
      id_pedido,
      quantidade,
      valor,
      rede // 🔥 agora permitido (opcional)
    } = req.body;

    // ------------------------------
    // 🔍 VALIDAÇÃO
    // ------------------------------
    if (
      !tipo_acao ||
      !nome_usuario ||
      quantidade_pontos === undefined ||
      !url_dir ||
      !id_pedido ||
      quantidade === undefined ||
      valor === undefined
    ) {
      return res.status(400).json({ error: "Dados incompletos" });
    }

    const pontos = Number(quantidade_pontos);
    const qtd = Number(quantidade);
    const val = Number(valor);

    if (isNaN(pontos) || pontos <= 0) {
      return res.status(400).json({ error: "Quantidade de pontos inválida" });
    }
    if (isNaN(qtd) || qtd <= 0) {
      return res.status(400).json({ error: "Quantidade inválida" });
    }
    if (isNaN(val) || val <= 0) {
      return res.status(400).json({ error: "Valor inválido" });
    }

    // ------------------------------
    // 📌 IDENTIFICAR AUTOMÁTICAMENTE A REDE
    // ------------------------------
    let redeFinal = "tiktok"; // padrão (compatibilidade)

    // 1️⃣ — Se o body enviar rede explicitamente
    if (rede && ["tiktok", "instagram"].includes(rede.toLowerCase())) {
      redeFinal = rede.toLowerCase();
    }

    // 2️⃣ — Detectar a partir do tipo_acao
    else if (tipo_acao.toLowerCase().includes("insta")) {
      redeFinal = "instagram";
    }

    // 3️⃣ — Detectar pelo link
    else if (url_dir.includes("instagram.com")) {
      redeFinal = "instagram";
    }

    // 4️⃣ — Detectar pelo link do TikTok
    else if (url_dir.includes("tiktok.com")) {
      redeFinal = "tiktok";
    }

    // ------------------------------
    // 🔢 GARANTIR ID DE 9 DÍGITOS
    // ------------------------------
    function gerarIdPedido() {
      return Math.floor(100000000 + Math.random() * 900000000);
    }

    let pedidoId = /^\d{9}$/.test(id_pedido)
      ? Number(id_pedido)
      : gerarIdPedido();

    // ------------------------------
    // 🛑 EVITAR DUPLICAÇÃO
    // ------------------------------
    let pedidoExistente = await Pedido.findOne({ _id: pedidoId });

    if (!pedidoExistente) {
      // ------------------------------
      // 🆕 Criar novo pedido
      // ------------------------------
      const novoPedido = new Pedido({
        _id: pedidoId,
        rede: redeFinal,
        tipo: tipo_acao.toLowerCase().trim(),
        nome: `Ação ${tipo_acao} - ${nome_usuario}`,
        valor: val,
        quantidade: qtd,
        link: url_dir,
        status: "pendente",
        dataCriacao: new Date()
      });

      await novoPedido.save();

      console.log(`🆕 Pedido criado (${redeFinal}):`, pedidoId);
    } else {
      console.log("ℹ Pedido já existia, retornando ID:", pedidoId);
    }

    // ------------------------------
    // 📤 RESPOSTA
    // ------------------------------
    return res.status(201).json({
      message: "Ação registrada com sucesso",
      id_acao_smm: pedidoId.toString()
    });

  } catch (error) {
    console.error("❌ Erro ao adicionar ação:", error);
    return res.status(500).json({ error: "Erro interno ao adicionar ação" });
  }
};

export default handler;
