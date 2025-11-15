if (url.startsWith("/api/ranking_diario") && method === "POST") {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const { token: bodyToken } = req.body || {};
  const query = req.query || {};

  try {
    await connectDB();

    // tempo / dia
    const agora = Date.now();

    // CACHE curto para permitir updates por minuto
    const CACHE_MS = 1 * 60 * 1000; // 1 minuto
    const hoje = new Date().toLocaleDateString("pt-BR");

    // autenticação (prefere header Authorization Bearer)
    const authHeader = req.headers.authorization;
    const tokenFromHeader =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : authHeader;
    const effectiveToken = tokenFromHeader || bodyToken;
    if (!effectiveToken) return res.status(401).json({ error: "Token inválido." });

    const user = await User.findOne({ token: effectiveToken });
    if (!user) return res.status(404).json({ error: "Usuário não encontrado ou token inválido." });

    // --- 1) carregar dailyFixedRanking do DB (normalizando strings -> objetos) ---
    if (!dailyFixedRanking || diaTop3 !== hoje) {
      try {
        const saved = await DailyRanking.findOne({ data: hoje }).lean();
        if (saved && Array.isArray(saved.ranking) && saved.ranking.length) {
          dailyFixedRanking = saved.ranking.map((entry) => ({
            username: entry.username ?? entry.nome ?? "Usuário",
            token: entry.token ?? null,
            real_total: Number(entry.real_total ?? 0),
            is_current_user: !!entry.is_current_user,
            userId: entry.userId ? String(entry.userId) : null
          }));

          // Use startAt salvo no DB (e, se não existir, fallback para criadoEm ou início do dia Brasília)
          if (saved.startAt) {
            horaInicioRanking = new Date(saved.startAt).getTime();
          } else if (saved.criadoEm) {
            horaInicioRanking = new Date(saved.criadoEm).getTime();
          } else {
            // fallback: define para meia-noite BR atual (03:00 UTC = 00:00 BR)
            const now = new Date();
            const offsetBrasilia = -3;
            const brasilNow = new Date(now.getTime() + offsetBrasilia * 60 * 60 * 1000);
            const startOfDayBR = new Date(
              Date.UTC(
                brasilNow.getUTCFullYear(),
                brasilNow.getUTCMonth(),
                brasilNow.getUTCDate(),
                3,
                0,
                0,
                0
              )
            );
            horaInicioRanking = startOfDayBR.getTime();
          }

          top3FixosHoje = dailyFixedRanking.slice(0, 3).map((u) => ({ ...u }));
          diaTop3 = hoje;
          zeroedAtMidnight = false;
          console.log("📥 Loaded dailyFixedRanking from DB for", hoje, dailyFixedRanking.map((d) => d.username));
        }
      } catch (e) {
        console.error("Erro ao carregar DailyRanking do DB:", e);
      }
    }

    // === 2) reset manual via ENV ou URL ?reset=true ===
    const resetPorEnv = process.env.RESET_RANKING === "true";
    const resetPorURL = query.reset === "true";
    if (resetPorEnv || resetPorURL) {
      await DailyEarning.deleteMany({});
      await User.updateMany({}, { $set: { balance: 0 } });

      // sample 10 users do DB
      let sampled = [];
      try {
        sampled = await User.aggregate([{ $sample: { size: 10 } }, { $project: { nome: 1, token: 1 } }]);
      } catch (e) {
        console.error("Erro ao samplear users:", e);
        sampled = [];
      }

      const NAMES_POOL = [
        "Allef 🔥","🤪","-","noname","⚡",
        "💪","-","KingdosMTD🥱🥱","kaduzinho",
        "Rei do ttk 👑","Deus🔥","Mago ✟","-","ldzz tiktok uva🍇","unknown",
        "vitor das continhas","-","@_01.kaio0",
        "Lipe Rodagem Interna 😄","-","dequelbest 🧙","Luiza","-","xxxxxxxxxx",
        "Bruno TK","-","[GODZ] MK ☠️","[GODZ] Leozin ☠️","Junior",
        "Metheus Rangel","Hackerzin☯","VIP++++","sagaz🐼","-",
      ];

      // embaralha fallback pool
      const shuffledFallback = shuffleArray(NAMES_POOL.slice());

      // monta lista de candidatos: usa sampled nomes (se houver) + fallback para completar
      let candidates = sampled
        .map(s => ({ username: s.nome || null, token: s.token || null }))
        .filter(x => !!x.username);

      // se faltarem nomes, preencha com fallback (sem repetir)
      let fallbackIdx = 0;
      while (candidates.length < 10) {
        const pick = shuffledFallback[fallbackIdx % shuffledFallback.length];
        if (!candidates.some(c => c.username === pick)) {
          candidates.push({ username: pick, token: null });
        }
        fallbackIdx++;
      }

      // agora embaralha a lista final para garantir ordem aleatória no primeiro dia
      dailyFixedRanking = shuffleArray(
        candidates.slice(0, 10).map(c => ({
          username: c.username,
          token: c.token || null,
          real_total: 0,
          is_current_user: c.token === effectiveToken,
          userId: c.userId ? String(c.userId) : null
        }))
      );

      // 🕒 Define hora atual e configurações de fuso horário de Brasília
      const agoraDate = new Date();
      const offsetBrasilia = -3;
      const brasilAgora = new Date(agoraDate.getTime() + offsetBrasilia * 60 * 60 * 1000);

      const hojeStr = brasilAgora.toLocaleDateString("pt-BR"); // ex: "12/11/2025"

      // 🕛 Calcula meia-noite de amanhã no horário de Brasília (em UTC)
      const brasilMidnightTomorrow = new Date(Date.UTC(
        brasilAgora.getUTCFullYear(),
        brasilAgora.getUTCMonth(),
        brasilAgora.getUTCDate() + 1, // amanhã
        3, // 03:00 UTC = 00:00 Brasília
        0,
        0,
        0
      ));

      // 🕒 Define a hora de início do ranking (meia-noite de hoje)
      const startAtDate = new Date(Date.UTC(
        brasilAgora.getUTCFullYear(),
        brasilAgora.getUTCMonth(),
        brasilAgora.getUTCDate(),
        3, // 03:00 UTC = 00:00 Brasília
        0,
        0,
        0
      ));

      // 🔢 Cria ou atualiza o ranking fixo do dia
      await DailyRanking.findOneAndUpdate(
        { data: hojeStr },
        {
          ranking: dailyFixedRanking,
          startAt: startAtDate,
          expiresAt: brasilMidnightTomorrow,
          criadoEm: new Date()
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      top3FixosHoje = dailyFixedRanking.slice(0, 3).map(u => ({ ...u }));
      diaTop3 = hojeStr;
      horaInicioRanking = agoraDate;
      ultimoRanking = null;
      ultimaAtualizacao = 0;
      zeroedAtMidnight = true;

      console.log("🔥 Reset manual/env — dailyFixedRanking criado:", dailyFixedRanking.map(d => d.username));

      if (resetPorURL) {
        const placeholder = dailyFixedRanking.map((d, i) => ({
          position: i + 1,
          username: d.username,
          total_balance: formatarValorRanking(d.real_total),
          is_current_user: !!d.is_current_user
        }));
        return res.status(200).json({
          success: true,
          message: "Ranking e saldos zerados (reset manual).",
          ranking: placeholder
        });
      }
    }

    // === 3) Reset automático à meia-noite (quando detecta mudança de dia) ===
    if (diaTop3 && diaTop3 !== hoje) {
      console.log("🕛 Novo dia detectado — resetando ranking diário automaticamente...");

      const agoraDate = new Date();
      console.log("🕒 Agora (UTC):", agoraDate.toISOString());

      const offsetBrasilia = -3; // UTC-3
      const brasilAgora = new Date(agoraDate.getTime() + offsetBrasilia * 60 * 60 * 1000);
      console.log("🇧🇷 Agora em Brasília:", brasilAgora.toISOString());

      const brasilMidnightTomorrow = new Date(Date.UTC(
        brasilAgora.getUTCFullYear(),
        brasilAgora.getUTCMonth(),
        brasilAgora.getUTCDate() + 1,
        3, // 03:00 UTC = 00:00 Brasília
        0, 0, 0
      ));
      console.log("🕛 Meia-noite de amanhã Brasília (UTC):", brasilMidnightTomorrow.toISOString());

      // === Reset de ganhos e saldos ===
      await DailyEarning.deleteMany({});
      await User.updateMany({}, { $set: { saldo: 0 } });

      // tenta samplear até 10 usuários aleatórios do DB
      let sampled = [];
      try {
        sampled = await User.aggregate([
          { $sample: { size: 10 } },
          { $project: { nome: 1, token: 1 } }
        ]);
      } catch (e) {
        console.error("Erro ao samplear users (midnight):", e);
        sampled = [];
      }

      const NAMES_POOL = [
        "Allef 🔥","🤪","-","noname","⚡",
        "💪","-","KingdosMTD🥱🥱","kaduzinho",
        "Rei do ttk 👑","Deus🔥","Mago ✟","-","ldzz tiktok uva🍇","unknown",
        "vitor das continhas","-","@_01.kaio0",
        "Lipe Rodagem Interna 😄","-","dequelbest 🧙","Luiza","-","xxxxxxxxxx",
        "Bruno TK","-","[GODZ] MK ☠️","[GODZ] Leozin ☠️","Junior",
        "Metheus Rangel","Hackerzin☯","VIP++++","sagaz🐼","-",
      ];

      const shuffledFallback = shuffleArray(NAMES_POOL.slice());

      let candidates = sampled
        .map(s => ({ username: s.nome || null, token: s.token || null }))
        .filter(x => !!x.username);

      let fallbackIdx = 0;
      while (candidates.length < 10) {
        const pick = shuffledFallback[fallbackIdx % shuffledFallback.length];
        if (!candidates.some(c => c.username === pick)) {
          candidates.push({ username: pick, token: null });
        }
        fallbackIdx++;
      }

      dailyFixedRanking = shuffleArray(
        candidates.slice(0, 10).map(c => ({
          username: c.username,
          token: c.token || null,
          real_total: 0,
          is_current_user: c.token === effectiveToken,
          userId: c.userId ? String(c.userId) : null
        }))
      );

      try {
        const agoraDate2 = new Date();
        const brasilAgora2 = new Date(agoraDate2.getTime() + offsetBrasilia * 60 * 60 * 1000);
        const hojeStr = brasilAgora2.toLocaleDateString("pt-BR");

        const brasilMidnightTomorrow2 = new Date(Date.UTC(
          brasilAgora2.getUTCFullYear(),
          brasilAgora2.getUTCMonth(),
          brasilAgora2.getUTCDate() + 1,
          3, 0, 0, 0
        ));

        const startAtDate = new Date(Date.UTC(
          brasilAgora2.getUTCFullYear(),
          brasilAgora2.getUTCMonth(),
          brasilAgora2.getUTCDate(),
          3, 0, 0, 0
        ));

        await DailyRanking.findOneAndUpdate(
          { data: hojeStr },
          {
            ranking: dailyFixedRanking,
            startAt: startAtDate,
            expiresAt: brasilMidnightTomorrow2,
            criadoEm: new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        console.log("💾 dailyFixedRanking salvo no DB (midnight reset) com startAt:", brasilAgora2.toISOString());
      } catch (e) {
        console.error("Erro ao salvar DailyRanking no DB (midnight):", e);
      }

      top3FixosHoje = dailyFixedRanking.slice(0, 3).map(u => ({ ...u }));
      diaTop3 = hoje;
      horaInicioRanking = brasilAgora;
      ultimoRanking = null;
      ultimaAtualizacao = brasilAgora;
      zeroedAtMidnight = true;

      const placeholder = dailyFixedRanking.map((d, i) => ({
        position: i + 1,
        username: d.username,
        total_balance: formatarValorRanking(d.real_total),
        is_current_user: !!d.is_current_user
      }));

      console.log("✅ Reset automático meia-noite — dailyFixedRanking:", dailyFixedRanking.map(d => d.username));
      return res.status(200).json({ ranking: placeholder });
    }

    // === 4) Cache check (mesmo dia e menos de CACHE_MS) ===
    if (ultimoRanking && agora - ultimaAtualizacao < CACHE_MS && diaTop3 === hoje) {
      return res.status(200).json({ ranking: ultimoRanking });
    }

    // === 5) Montagem do ranking base: prioriza dailyFixedRanking se definido para hoje, mas incorpora DailyEarning com PRIORIDADE ===
    let baseRankingRaw = null;

    // Helper para chave de fusão: prefira token (quando disponível), fallback para username normalizado
    const normalize = s => (String(s || "").trim().toLowerCase());

    if (dailyFixedRanking && diaTop3 === hoje) {
      // Clone do ranking fixo do dia (marca como source: 'fixed')
      const baseFromFixed = dailyFixedRanking.map((u) => ({
        username: (u.username || "Usuário").toString(),
        token: u.token || null,
        real_total: Number(u.real_total || 0),
        is_current_user: !!u.is_current_user,
        source: 'fixed',
        userId: u.userId ? String(u.userId) : null
      }));

      // --- Busca ganhos reais do DB (DailyEarning) — agora projetando userId para matching confiável
      let ganhosPorUsuario = [];
      try {
        ganhosPorUsuario = await DailyEarning.aggregate([
          { $group: { _id: "$userId", totalGanhos: { $sum: "$valor" } } },
          { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "usuario" } },
          { $unwind: { path: "$usuario", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              userId: "$_id",
              username: { $ifNull: ["$usuario.nome", "Usuário"] },
              token: { $ifNull: ["$usuario.token", null] },
              real_total: "$totalGanhos"
            }
          }
        ]);
      } catch (e) {
        console.error("Erro ao agregar DailyEarning durante fusão (prioridade):", e);
        ganhosPorUsuario = [];
      }

      // --- Prepara mapa e helpers de matching (versão final corrigida) ---
      const mapa = new Map();

      const makeKeyFromFixed = (u, idx) => {
        if (u.token) return `T:${String(u.token)}`;
        if (u.userId) return `I:${String(u.userId)}`;
        return `U:${String((u.username || "").trim().toLowerCase())}`;
      };

      // ganhos por posição (usado para projeção dos fixed)
      const ganhosPorPosicao = [20, 18, 16, 14, 10, 5.5, 4.5, 3.5, 2.5, 1.5];
      const perMinuteGain = ganhosPorPosicao.map(g => g / 10); // ganho por minuto

      // baseHoraInicio: usa horaInicioRanking (se definida) ou agora
      const agoraMs = Date.now();
      const baseHoraInicio = horaInicioRanking || agoraMs;
      const intervalosDecorridos = Math.floor((agoraMs - baseHoraInicio) / (60 * 1000));
      console.log("📊 intervalosDecorridos (min):", intervalosDecorridos, "horaInicioRanking:", new Date(baseHoraInicio).toISOString());

      // insere fixed no mapa com posição (fixedPosition)
      baseFromFixed.forEach((u, idx) => {
        const key = u.token ? `T:${String(u.token)}` : `U:${String((u.username || "").trim().toLowerCase())}`;
        mapa.set(key, {
          username: String(u.username || "Usuário"),
          token: u.token || null,
          real_total: Number(u.real_total || 0),
          source: 'fixed',
          fixedPosition: idx,
          is_current_user: !!u.is_current_user,
          userId: u.userId || null
        });
      });

      // helper para buscar chave existente por token / userId / username
      function findExistingKeyFor(item) {
        if (item.token) {
          const k = `T:${String(item.token)}`;
          if (mapa.has(k)) return k;
        }
        if (item.userId) {
          const k = `I:${String(item.userId)}`;
          if (mapa.has(k)) return k;
        }
        const uname = String(item.username || "").trim().toLowerCase();
        for (const existingKey of mapa.keys()) {
          if (existingKey === `U:${uname}`) return existingKey;
          const ex = mapa.get(existingKey);
          if (ex && String(ex.username || "").trim().toLowerCase() === uname) return existingKey;
        }
        return null;
      }

      // incorpora ganhos do DB (earnings). Ao encontrar fixed, compara projectedFixed x earnings.real_total
      ganhosPorUsuario.forEach(g => {
        const item = {
          username: String(g.username || "Usuário"),
          token: g.token || null,
          real_total: Number(g.real_total || 0),
          source: 'earnings',
          userId: g.userId ? String(g.userId) : null,
          is_current_user: (g.token && g.token === effectiveToken) || false
        };

        const existingKey = findExistingKeyFor(item);
        if (existingKey) {
          const ex = mapa.get(existingKey);

          if (ex && ex.source === 'fixed') {
            // projeção do fixed pelo tempo decorrido (usa fixedPosition quando disponível)
            const pos = (typeof ex.fixedPosition === 'number') ? ex.fixedPosition : null;
            const incrementoPorMinuto = pos !== null ? (perMinuteGain[pos] || 0) : 0;
            const projectedFixed = Number(ex.real_total || 0) + incrementoPorMinuto * intervalosDecorridos;

            // escolha o maior entre earnings.real_total e projectedFixed
            if (Number(item.real_total) >= projectedFixed) {
              // earnings domina -> substitui com valor real do DB
              mapa.set(existingKey, {
                username: item.username || ex.username,
                token: item.token || ex.token,
                real_total: Number(item.real_total),
                source: 'earnings',
                userId: item.userId || ex.userId || null,
                is_current_user: ex.is_current_user || item.is_current_user
              });
            } else {
              // fixed projetado vence -> mantenha fixed, mas armazene earnings_total para debug (não altera ordering)
              ex.earnings_total = Number(item.real_total);
              mapa.set(existingKey, ex);
            }
          } else {
            // substitui/merge normal quando não há fixed pré-existente
            mapa.set(existingKey, {
              username: item.username,
              token: item.token || (ex && ex.token) || null,
              real_total: Number(item.real_total),
              source: item.source,
              userId: item.userId || (ex && ex.userId) || null,
              is_current_user: (ex && ex.is_current_user) || item.is_current_user
            });
          }
        } else {
          // sem chave existente: adiciona novo entry (earnings)
          const key = item.token ? `T:${String(item.token)}` : `U:${String(item.username.trim().toLowerCase())}`;
          mapa.set(key, { ...item });
        }
      });

      // --- Agora: calcule current_total projetado para todos os items (fixed usam projeção, earnings usam valor real)
      const listaComProjetado = Array.from(mapa.values()).map(entry => {
        const e = { ...entry };
        if (e.source === 'fixed') {
          const pos = (typeof e.fixedPosition === 'number') ? e.fixedPosition : null;
          const incrementoPorMinuto = pos !== null ? (perMinuteGain[pos] || 0) : 0;
          const projected = Number(e.real_total || 0) + incrementoPorMinuto * intervalosDecorridos;
          e.current_total = Number(projected);
        } else {
          e.current_total = Number(e.real_total || 0);
        }
        return e;
      });

      // --- Garantir pelo menos 10 itens (fallback) sem sobrescrever existentes
      if (listaComProjetado.length < 10) {
        const NAMES_POOL2 = [
          "Allef 🔥","🤪","-","noname","⚡","💪","-","KingdosMTD🥱🥱","kaduzinho",
          "Rei do ttk 👑","Deus🔥","Mago ✟","-","ldzz tiktok uva🍇","unknown",
          "vitor das continhas","-","@_01.kaio0","Lipe Rodagem Interna 😄","-","dequelbest 🧙","Luiza","-","xxxxxxxxxx",
          "Bruno TK","-","[GODZ] MK ☠️","[GODZ] Leozin ☠️","Junior","Metheus Rangel","Hackerzin☯","VIP++++","sagaz🐼","-"
        ];
        let idx = 0;
        while (listaComProjetado.length < 10) {
          const nome = NAMES_POOL2[idx % NAMES_POOL2.length];
          if (!listaComProjetado.some(x => String(x.username || "").trim() === String(nome).trim())) {
            listaComProjetado.push({ username: nome, token: null, real_total: 0, current_total: 0, source: 'fixed', is_current_user: false });
          }
          idx++;
        }
      }

      // Ordena pelo valor projetado (current_total) DECRESCENTE e só então pega top10
      listaComProjetado.sort((a, b) => Number(b.current_total || 0) - Number(a.current_total || 0));

      // debug opcional
      console.log("DEBUG: top 12 after projection:", listaComProjetado.slice(0, 12).map((x, i) => `${i+1}=${x.username}:${(Number(x.current_total)||0).toFixed(2)}(src=${x.source})`));

      // pegar top10 definitivo
      const top10 = listaComProjetado.slice(0, 10);

      // helper de arredondamento
      function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

      // montar baseRankingRaw usando current_total como valor final
      baseRankingRaw = top10.map((item) => ({
        username: item.username,
        token: item.token || null,
        real_total: round2(Number(item.current_total || item.real_total || 0)), // representa o valor final exibido
        source: item.source || 'unknown',
        is_current_user: !!item.is_current_user
      }));
    } else {
      // fallback quando não há dailyFixedRanking: gera a partir do DB (sem fixed)
      const ganhosPorUsuario = await DailyEarning.aggregate([
        { $group: { _id: "$userId", totalGanhos: { $sum: "$valor" } } },
        { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "usuario" } },
        { $unwind: "$usuario" },
        { $project: { _id: 0, username: { $ifNull: ["$usuario.nome", "Usuário"] }, total_balance: "$totalGanhos", token: "$usuario.token" } },
      ]);

      baseRankingRaw = (ganhosPorUsuario || [])
        .filter((item) => (item.totalGanhos ?? item.total_balance) > 1)
        .map((item) => ({
          username: item.username || "Usuário",
          token: item.token || null,
          real_total: Number(item.totalGanhos ?? item.total_balance ?? 0),
          is_current_user: item.token === effectiveToken,
          source: 'earnings'
        }));

      // completa até 10 com fallback estático (determinístico)
      const NAMES_POOL2 = [
        "Allef 🔥","🤪","-","noname","⚡","💪","-","KingdosMTD🥱🥱","kaduzinho",
        "Rei do ttk 👑","Deus🔥","Mago ✟","-","ldzz tiktok uva🍇","unknown",
        "vitor das continhas","-","@_01.kaio0","Lipe Rodagem Interna 😄","-","dequelbest 🧙","Luiza","-","xxxxxxxxxx",
        "Bruno TK","-","[GODZ] MK ☠️","[GODZ] Leozin ☠️","Junior","Metheus Rangel","Hackerzin☯","VIP++++","sagaz🐼","-"
      ];
      while (baseRankingRaw.length < 10) {
        const nome = NAMES_POOL2[baseRankingRaw.length % NAMES_POOL2.length];
        baseRankingRaw.push({ username: nome, token: null, real_total: 0, is_current_user: false, source: 'fixed' });
      }

      baseRankingRaw.sort((a, b) => Number(b.real_total) - Number(a.real_total));
    }

    // === 6) Limita a 10 posições ===
    let finalRankingRaw = baseRankingRaw.slice(0, 10);

    // === 7) (OBS) já aplicamos projeção antes — não re-aplicar incrementos aqui.
    // helper: arredonda com 2 casas (final polishing)
    function round2(n) {
      return Math.round((Number(n) || 0) * 100) / 100;
    }

    // logs debug do pré-format
    console.log("🔢 pré-format finalRankingRaw:", finalRankingRaw.map((r, i) => `${i + 1}=${r.username}:${(r.real_total || 0).toFixed(2)}`));

    // === 8) Formata e responde ===
    const formatter = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const finalRanking = finalRankingRaw.map((item, idx) => ({
      position: idx + 1,
      username: item.username,
      total_balance: formatter.format(Number(item.real_total || 0)),
      real_total: Number(item.real_total || 0),
      is_current_user: !!(item.token && item.token === effectiveToken),
      source: item.source || 'unknown'
    }));

    // Atualiza cache
    ultimoRanking = finalRanking;
    ultimaAtualizacao = agora;
    zeroedAtMidnight = false;

    console.log("🔢 final top3 (numeros reais):", finalRanking.slice(0, 3).map(r => `${r.username}=${r.real_total}`));
    return res.status(200).json({ ranking: finalRanking });

  } catch (error) {
    console.error("❌ Erro ao buscar ranking:", error);
    return res.status(500).json({ error: "Erro interno ao buscar ranking" });
  }
}
