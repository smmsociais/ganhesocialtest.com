// api/buscar_acao_smm_instagram.js (versão com debug + case-insensitive)
import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";

const handler = async (req, res) => {
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido" });

  const { id_conta, token, tipo, rede: redeQuery, debug } = req.query;

  console.log("➡️ Requisição recebida:", { id_conta, token: !!token, tipo, redeQuery });

  if (!id_conta || !token) return res.status(400).json({ error: "id_conta e token são obrigatórios" });

  try {
    await connectDB();
    console.log("✅ Conexão com o banco estabelecida");

    const usuario = await User.findOne({ token });
    if (!usuario) {
      console.log("❌ Token inválido");
      return res.status(401).json({ error: "Token inválido" });
    }

    // normalizar tipo (se fornecido)
    const tipoNormalized = typeof tipo === 'string' ? String(tipo).trim().toLowerCase() : null;
    const tipoMap = { seguir: "seguir", curtir: "curtir" };
    const tipoBanco = tipoMap[tipoNormalized] || tipoNormalized;

    // rede: permitir override ?rede=instagram, ou usar 'instagram' por padrão
    const redeNormalized = typeof redeQuery === 'string' && redeQuery.trim().length
      ? redeQuery.trim()
      : 'instagram';

    // construir query com case-insensitive para rede
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] },
      rede: { $regex: new RegExp(`^${redeNormalized}$`, 'i') } // aceita "Instagram", "instagram", etc.
    };

    if (tipoNormalized === "seguir_curtir") {
      query.tipo = { $in: ["seguir", "curtir"] };
    } else if (tipoBanco) {
      query.tipo = tipoBanco;
    }

    // DEBUG: contar quantos pedidos correspondem ao filtro base (antes das validações de history)
    const totalMatching = await Pedido.countDocuments(query);
    console.log(`🔎 Pedidos que batem com query inicial: ${totalMatching}`);

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();

    console.log(`📦 ${pedidos.length} pedidos encontrados (após find)`);

    if (debug === "1") {
      // devolve info de debug para ajudar em desenvolvimento
      return res.status(200).json({
        debug: true,
        totalMatching,
        sampleQuery: query,
        pedidosSample: pedidos.slice(0, 5)
      });
    }

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

      // garantir que quantidade é número
      const quantidadePedido = Number(pedido.quantidade || 0);
      if (isNaN(quantidadePedido) || quantidadePedido <= 0) {
        console.log(`⚠ Ignorando pedido ${id_pedido} por quantidade inválida:`, pedido.quantidade);
        continue;
      }

      // 1. Fechar pedido se já atingiu o limite
      const validadas = await ActionHistory.countDocuments({ id_pedido, acao_validada: "valida" });
      if (validadas >= quantidadePedido) {
        console.log(`⛔ Pedido ${id_pedido} fechado — já tem ${validadas} validações.`);
        continue;
      }

      // 2. Conta pulou esse pedido
      const pulada = await ActionHistory.findOne({ id_pedido, id_conta, acao_validada: "pulada" });
      if (pulada) {
        console.log(`🚫 Ação ${id_pedido} foi pulada por ${id_conta}`);
        continue;
      }

      // 3. Conta já fez (pendente ou validada)
      const jaFez = await ActionHistory.findOne({
        id_pedido,
        id_conta,
        acao_validada: { $in: ["pendente", "valida"] }
      });
      if (jaFez) {
        console.log(`🚫 Conta ${id_conta} já fez o pedido ${id_pedido}`);
        continue;
      }

      // 4. Quantas ações já foram feitas (inclui pendentes)
      const feitas = await ActionHistory.countDocuments({
        id_pedido,
        acao_validada: { $in: ["pendente", "valida"] }
      });
      console.log(`📊 Ação ${id_pedido}: feitas=${feitas}, limite=${quantidadePedido}`);
      if (feitas >= quantidadePedido) {
        console.log(`⏩ Pedido ${id_pedido} atingiu o limite total.`);
        continue;
      }

      // Pedido disponível -> extrair nome do link (tolerante)
      let nomeUsuario = "";
      if (typeof pedido.link === 'string') {
        if (pedido.link.includes("@")) {
          nomeUsuario = pedido.link.split("@")[1].split(/[/?#]/)[0];
        } else {
          // tentar extrair do caminho da URL
          try {
            const m = pedido.link.match(/instagram\.com\/([^\/?#&]+)/i);
            if (m && m[1]) nomeUsuario = m[1].replace(/\/$/, '');
          } catch(e){ /* ignore */ }
        }
      }

      console.log(`✅ Ação encontrada: ${nomeUsuario || '<sem-usuario>'} (pedido ${id_pedido})`);

      return res.json({
        status: "ENCONTRADA",
        nome_usuario: nomeUsuario,
        quantidade_pontos: pedido.valor,
        url_dir: pedido.link,
        tipo_acao: pedido.tipo,
        id_pedido: id_pedido
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
