// api/buscar_acao_smm_tiktok.js

import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";

const handler = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const { id_conta, token, tipo } = req.query;

  console.log("➡️ Requisição recebida:");
  console.log("id_conta:", id_conta);
  console.log("token:", token);
  console.log("tipo:", tipo);

  if (!id_conta || !token) {
    return res.status(400).json({ error: "id_conta e token são obrigatórios" });
  }

  try {
    await connectDB();
    console.log("✅ Conexão com o banco estabelecida");

    const usuario = await User.findOne({ token });
    if (!usuario) {
      console.log("❌ Token inválido");
      return res.status(401).json({ error: "Token inválido" });
    }

    // Mapeamento dos tipos
    const tipoMap = { seguir: "seguir", curtir: "curtir" };
    const tipoBanco = tipoMap[tipo] || tipo;

    // ---------------------------------------------------------
    // 🔍 BUSCAR APENAS PEDIDOS DO TIKTOK
    // ---------------------------------------------------------
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] },
      rede: "instagram"
    };

    if (tipo === "seguir_curtir") {
      query.tipo = { $in: ["seguir", "curtir"] };
    } else if (tipoBanco) {
      query.tipo = tipoBanco;
    }

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 });

    console.log(`📦 ${pedidos.length} pedidos encontrados (TikTok)`);

    for (const pedido of pedidos) {
      const id_pedido = pedido._id;

      console.log("🔍 Verificando pedido:", {
        id_pedido,
        tipo: pedido.tipo,
        status: pedido.status,
        quantidade: pedido.quantidade,
        valor: pedido.valor,
        link: pedido.link,
        rede: pedido.rede
      });

      //
      // 🔒 1. Fechar pedido se já atingiu o limite
      //
      const validadas = await ActionHistory.countDocuments({
        id_pedido,
        acao_validada: "valida"
      });

      if (validadas >= pedido.quantidade) {
        console.log(`⛔ Pedido ${id_pedido} fechado — já tem ${validadas} validações.`);
        continue;
      }

      //
      // 2. Ação pulada
      //
      const pulada = await ActionHistory.findOne({
        id_pedido,
        id_conta,
        acao_validada: "pulada"
      });

      if (pulada) {
        console.log(`🚫 Ação ${id_pedido} foi pulada por ${id_conta}`);
        continue;
      }

      //
      // 3. Conta já fez o pedido
      //
      const jaFez = await ActionHistory.findOne({
        id_pedido,
        id_conta,
        acao_validada: { $in: ["pendente", "valida"] }
      });

      if (jaFez) {
        console.log(`🚫 Conta ${id_conta} já fez o pedido ${id_pedido}`);
        continue;
      }

      //
      // 4. Total de ações já realizadas
      //
      const feitas = await ActionHistory.countDocuments({
        id_pedido,
        acao_validada: { $in: ["pendente", "valida"] }
      });

      console.log(`📊 Ação ${id_pedido}: feitas=${feitas}, limite=${pedido.quantidade}`);

      if (feitas >= pedido.quantidade) {
        console.log(`⏩ Pedido ${id_pedido} atingiu o limite total.`);
        continue;
      }

      //
      // 6. Pedido disponível
      //
      const nomeUsuario = pedido.link.includes("@")
        ? pedido.link.split("@")[1].split(/[/?#]/)[0]
        : "";

      console.log(`✅ Ação encontrada: ${nomeUsuario} (pedido ${id_pedido})`);

      return res.json({
        status: "ENCONTRADA",
        nome_usuario: nomeUsuario,
        quantidade_pontos: pedido.valor,
        url_dir: pedido.link,
        tipo_acao: pedido.tipo,
        id_pedido: pedido._id
      });
    }

    console.log("📭 Nenhuma ação disponível");
    return res.json({ status: "NAO_ENCONTRADA" });

  } catch (error) {
    console.error("🔥 Erro ao buscar ação:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
};

export default handler;
