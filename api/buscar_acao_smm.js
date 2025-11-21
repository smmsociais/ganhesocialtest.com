//api/buscar_acao_smm.js

import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";

const handler = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const { id_conta, token, tipo } = req.query;

  if (!id_conta || !token) {
    return res.status(400).json({ error: "id_conta e token são obrigatórios" });
  }

  try {
    await connectDB();

    const usuario = await User.findOne({ token });
    if (!usuario) {
      return res.status(401).json({ error: "Token inválido" });
    }

    const tipoMap = { seguir: "seguir", curtir: "curtir" };
    const tipoBanco = tipoMap[tipo] || tipo;

    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] }
    };

    if (tipo === "seguir_curtir") {
      query.tipo = { $in: ["seguir", "curtir"] };
    } else if (tipoBanco) {
      query.tipo = tipoBanco;
    }

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 });

    for (const pedido of pedidos) {

      const id_pedido = pedido._id;

      // ❌ Conta já fez ou está com pendente → não pode fazer de novo
      const jaFez = await ActionHistory.findOne({
        id_pedido,
        id_conta,
        acao_validada: { $in: ['pendente', 'validada'] }
      });

      if (jaFez) {
        continue;
      }

      // ❌ Conta pulou → não deve receber
      const pulada = await ActionHistory.findOne({
        id_pedido,
        id_conta,
        acao_validada: 'pulada',
      });

      if (pulada) {
        continue;
      }

      // ✅ Conta atual nunca fez — verificar se ainda há vagas para o pedido
      const feitas = await ActionHistory.countDocuments({
        id_pedido,
        acao_validada: { $in: ['pendente', 'validada'] }
      });

      if (feitas >= pedido.quantidade) {
        continue;
      }

      // 🟢 ATENÇÃO: Se outra conta tem "pendente", NÃO bloqueia
      // pois o countDocuments já considera pendentes e ainda há vagas.

      const nomeUsuario = pedido.link.includes("@")
        ? pedido.link.split("@")[1].split(/[/?#]/)[0]
        : "";

      return res.json({
        status: "ENCONTRADA",
        nome_usuario: nomeUsuario,
        quantidade_pontos: pedido.valor,
        url_dir: pedido.link,
        tipo_acao: pedido.tipo,
        id_pedido: pedido._id
      });
    }

    return res.json({ status: "NAO_ENCONTRADA" });

  } catch (error) {
    console.error("🔥 Erro ao buscar ação:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
};

export default handler;
