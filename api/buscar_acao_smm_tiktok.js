// api/buscar_acao_smm_tiktok.js (corrigido v2)
import connectDB from './db.js';
import mongoose from 'mongoose';
import { User, ActionHistory, Pedido } from "./schema.js";

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

    // Query base para pedidos TikTok
    const query = {
      quantidade: { $gt: 0 },
      status: { $in: ["pendente", "reservada"] }, // pedidos ainda aceitáveis
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

      // 2) Total feitas (pendente + reservada + valida)
      const feitas = await ActionHistory.countDocuments({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { $or: [
              { status: { $in: ["pendente", "reservada", "valida"] } },
              { acao_validada: { $in: ["pendente", "reservada", "valida"] } }
            ]
          }
        ]
      });
      console.log(`📊 Ação ${idPedidoStr}: feitas=${feitas}, limite=${pedido.quantidade}`);
      if (feitas >= (Number(pedido.quantidade) || 0)) {
        console.log(`⏩ Pedido ${idPedidoStr} atingiu o limite total.`);
        continue;
      }

      // 3) Verificar se a conta solicitante pulou/ja fez/reservou essa ação (quando fornecida)
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

      // já fez / pendente / reservada? — se existir qualquer doc para essa conta+pedido com status pendente/reservada/valida, pulamos
      const jaFez = await ActionHistory.findOne({
        $and: [
          { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
          { nome_usuario: nome },
          { $or: [
              { status: { $in: ["pendente", "reservada", "valida"] } },
              { acao_validada: { $in: ["pendente", "reservada", "valida"] } }
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

      // determina valor padrão por tipo (seguir -> 0.006, curtir -> 0.001)
      const tipoPedido = (pedido.tipo || "").toString().toLowerCase();
      let valorParaEnviar = 0;
      if (typeof pedido.valor === "number" && pedido.valor > 0) {
        valorParaEnviar = Number(pedido.valor);
      } else {
        if (tipoPedido === "seguir") {
          valorParaEnviar = 0.006;
        } else if (tipoPedido === "curtir") {
          valorParaEnviar = 0.001;
        } else if (tipoPedido === "seguir_curtir") {
          valorParaEnviar = 0.006;
        } else {
          valorParaEnviar = 0.006;
        }
      }
      valorParaEnviar = Number(valorParaEnviar.toFixed(3));

      // 5) Criar reserva atômica para a conta solicitante — com filtro que normaliza id como string
      try {
        const filterExistente = {
          $and: [
            { $or: [{ id_pedido: idPedidoStr }, { id_action: idPedidoStr }] },
            { nome_usuario: nome },
            { $or: [
              { status: { $in: ["reservada", "pendente", "valida"] } },
              { acao_validada: { $in: ["reservada", "pendente", "valida"] } }
            ] }
          ]
        };

        const setOnInsert = {
          user: usuario._id,
          token: usuario.token,
          nome_usuario: nome,
          id_pedido: idPedidoStr,
          id_action: idPedidoStr,
          url: pedido.link,
          tipo_acao: pedido.tipo,
          quantidade_pontos: pedido.valor ?? null,
          valor: valorParaEnviar,
          tipo: pedido.tipo,
          rede_social: pedido.rede,
          status: "reservada",
          acao_validada: "reservada",
          data: new Date()
        };

        // Operação atômica: se já existe um doc com a combinação (pedido X conta) e status relevante, retornará esse doc
        const existente = await ActionHistory.findOneAndUpdate(
          filterExistente,
          { $setOnInsert: setOnInsert },
          { upsert: true, new: false, setDefaultsOnInsert: true }
        );

        if (existente) {
          console.log(`⚠ Conta ${nome} já tem registro ativo para pedido ${idPedidoStr} — pulando.`);
          continue;
        }

        console.log(`🔒 Reserva criada (atômica) para conta ${nome} no pedido ${idPedidoStr}`);

        return res.json({
          status: "ENCONTRADA",
          nome_usuario: nomeUsuario,
          valor: valorParaEnviar,
          url: pedido.link,
          tipo_acao: pedido.tipo,
          id_pedido: pedido._id
        });

      } catch (err) {
        // Defesa em profundidade: se der erro de duplicidade no banco (E11000), interpretar como já existente
        if (err && err.code === 11000) {
          console.log(`⚠ Duplicate key ao criar reserva para ${nome} no pedido ${idPedidoStr} — pulando.`);
          continue;
        }
        console.warn("Falha ao criar reserva atômica (ignorar e tentar próximo pedido):", err);
        continue;
      }

    } // end for

    console.log("📭 Nenhuma ação disponível");
    return res.json({ status: "NAO_ENCONTRADA" });

  } catch (error) {
    console.error("🔥 Erro ao buscar ação:", error);
    return res.status(500).json({ error: "Erro interno" });
  }
};

export default handler;

/*
  NOTAS IMPORTANTES (aplique no schema):

  1) Normalize sempre id_action / id_pedido como STRING ao salvar no ActionHistory — evita problemas de tipo
     (Number vs ObjectId vs String). No trecho acima eu salvo id_pedido/id_action como string.

  2) Adicione índices parciais no seu schema ActionHistory para reforçar unicidade (defesa em profundidade):

     ActionHistorySchema.index(
       { id_action: 1, nome_usuario: 1 },
       { unique: true, partialFilterExpression: {
           $or: [
             { status: { $in: ["reservada","pendente","valida"] } },
             { acao_validada: { $in: ["reservada","pendente","valida"] } }
           ]
         }
       }
     );

     ActionHistorySchema.index(
       { id_pedido: 1, nome_usuario: 1 },
       { unique: true, partialFilterExpression: {
           $or: [
             { status: { $in: ["reservada","pendente","valida"] } },
             { acao_validada: { $in: ["reservada","pendente","valida"] } }
           ]
         }
       }
     );

  3) Recomendação de fluxo: exigir `nome_usuario` no cliente quando o usuário tiver mais de 1 conta vinculada.

  Essas três mudanças (normalizar ids como string, usar filtro atômico + upsert, adicionar índices únicos parciais)
  devem garantir que UMA conta não consiga reservar a mesma ação mais de uma vez, mesmo quando `pedido.quantidade` > 1.
*/
