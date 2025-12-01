// api/buscar_acao_smm_tiktok.js
import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";
import { getValorAcao } from "./handler.js";

const handler = async (req, res) => {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const { token, tipo, nome_usuario } = req.query;

  console.log("➡️ Requisição recebida:");
  console.log("token:", token ? `***${String(token).slice(-6)}` : null);
  console.log("tipo:", tipo);
  console.log("nome_usuario:", nome_usuario);

  if (!tipo || !token) {
    return res.status(400).json({ error: "tipo e token são obrigatórios" });
  }

  try {
    await connectDB();
    console.log("✅ Conexão com o banco estabelecida");

    const usuario = await User.findOne({ token });
    if (!usuario) {
      console.log("❌ Token inválido");
      return res.status(401).json({ error: "Token inválido" });
    }

    // Se foi passado nome_usuario, validar que pertence ao usuário (token)
    // Caso não seja passado, tentamos inferir quando o usuário tem apenas 1 conta vinculada.
    let contaSolicitante = null;
    if (nome_usuario) {
      const nomeLower = String(nome_usuario).trim().toLowerCase();
      const achou = Array.isArray(usuario.contas) && usuario.contas.some(c =>
        String(c.nome_usuario ?? c.nomeConta ?? "").toLowerCase() === nomeLower
      );
      if (!achou) {
        console.log("❌ Conta solicitante não pertence ao token:", nome_usuario);
        return res.status(401).json({ error: "Conta não vinculada ao token" });
      }
      contaSolicitante = String(nome_usuario).trim();
    } else {
      // inferir se o usuário tem exatamente 1 conta vinculada
      if (Array.isArray(usuario.contas) && usuario.contas.length === 1) {
        contaSolicitante = String(usuario.contas[0].nome_usuario ?? usuario.contas[0].nomeConta ?? '').trim();
        console.log(`ℹ Inferido nome_usuario = ${contaSolicitante} (1 conta encontrada)`);
      } else {
        // se não podemos inferir com segurança, pedir que o cliente passe o nome
        return res.status(400).json({ error: "nome_usuario é obrigatório quando o usuário tem múltiplas contas" });
      }
    }

    // Mapeamento dos tipos
    const tipoMap = { seguir: "seguir", curtir: "curtir" };
    const tipoBanco = tipoMap[tipo] || tipo;

    // Query base para pedidos TikTok — removemos "reservada": não usamos mais reservas
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente"] }, // pedidos ativos
      rede: { $regex: /^tiktok$/i }
    };

    if (tipo === "seguir_curtir") {
      query.tipo = { $in: ["seguir", "curtir"] };
    } else if (tipoBanco) {
      query.tipo = tipoBanco;
    }

    const pedidos = await Pedido.find(query).sort({ dataCriacao: -1 }).lean();
    console.log(`📦 ${pedidos.length} pedidos encontrados (TikTok)`);

    for (const pedido of pedidos) {
      // NORMALIZAR o id do pedido para string — evita problemas de tipo (Number vs ObjectId vs String)
      const idPedidoStr = String(pedido._id);
      console.log("🔍 Verificando pedido:", {
        id_pedido: idPedidoStr,
        tipo: pedido.tipo,
        status: pedido.status,
        quantidade: pedido.quantidade,
        valor: pedido.valor,
        link: pedido.link,
        rede: pedido.rede
      });

      // 1) Total validadas (somente 'valida')
      const validadas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { $or: [{ status: "valida" }, { acao_validada: "valida" }] }
        ]
      });
      if (validadas >= (Number(pedido.quantidade) || 0)) {
        console.log(`⛔ Pedido ${idPedidoStr} fechado — já tem ${validadas} validações.`);
        continue;
      }

      // 2) Total feitas (pendente + valida) — não consideramos mais "reservada"
      const feitas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { $or: [
              { status: { $in: ["pendente", "valida"] } },
              { acao_validada: { $in: ["pendente", "valida"] } }
            ]
          }
        ]
      });
      console.log(`📊 Ação ${idPedidoStr}: feitas=${feitas}, limite=${pedido.quantidade}`);
      if (feitas >= (Number(pedido.quantidade) || 0)) {
        console.log(`⏩ Pedido ${idPedidoStr} atingiu o limite total.`);
        continue;
      }

      // 3) Verificar se a conta solicitante pulou/ja fez essa ação (quando fornecida)
      const nome = contaSolicitante;

      // pulada? (qualquer registro 'pulada' para esse pedido + conta)
      const pulada = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { nome_usuario: nome },
          { $or: [{ status: "pulada" }, { acao_validada: "pulada" }] }
        ]
      });
      if (pulada) {
        console.log(`🚫 Conta ${nome} pulou o pedido ${idPedidoStr}`);
        continue;
      }

      // já fez / pendente? — se existir qualquer doc para essa conta+pedido com status pendente/valida, pulamos
      const jaFez = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { nome_usuario: nome },
          { $or: [
              { status: { $in: ["pendente", "valida"] } },
              { acao_validada: { $in: ["pendente", "valida"] } }
            ]
          }
        ]
      });
      if (jaFez) {
        console.log(`🚫 Conta ${nome} já fez/reservou o pedido ${idPedidoStr}`);
        continue;
      }

      // 4) Extrair nome do usuário alvo do pedido
      let nomeUsuario = "";
      if (typeof pedido.link === "string") {
        if (pedido.link.includes("@")) {
          nomeUsuario = pedido.link.split("@")[1].split(/[/?#]/)[0];
        } else {
          const m = pedido.link.match(/tiktok\.com\/@?([^\/\?#&]+)/i);
          if (m && m[1]) nomeUsuario = m[1].replace(/\/$/, "");
        }
      }

const valorParaEnviar = Number(getValorAcao(pedido, "TikTok"));

      return res.json({
        status: "ENCONTRADA",
        nome_usuario: nomeUsuario,
        valor: valorParaEnviar,
        url: pedido.link,
        tipo_acao: pedido.tipo,
        id_pedido: pedido._id,
        // sinaliza para o frontend que ele deve chamar a rota de confirmação ao completar a ação
        save_on_confirm: true
      });

    } // end for

    console.log("📭 Nenhuma ação disponível");
    return res.json({ status: "NAO_ENCONTRADA" });

  } catch (error) {
    console.error("🔥 Erro ao buscar ação:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
};

export default handler;
