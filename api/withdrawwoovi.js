// 🔹 Rota: /api/withdraw
if (url.startsWith("/api/withdraw")) {
  if (method !== "GET" && method !== "POST") {
    console.log("[DEBUG] Método não permitido:", method);
    return res.status(405).json({ error: "Método não permitido." });
  }

  const OPENPIX_API_KEY = process.env.OPENPIX_API_KEY;
  const OPENPIX_API_URL = process.env.OPENPIX_API_URL || "https://api.openpix.com.br";

  // conecta DB (assume função global connectDB e modelo User)
  await connectDB();

  // 🔹 Autenticação
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[DEBUG] Token ausente ou inválido:", authHeader);
    return res.status(401).json({ error: "Token ausente ou inválido." });
  }
  const token = authHeader.split(" ")[1];
  const user = await User.findOne({ token });
  if (!user) {
    console.log("[DEBUG] Usuário não encontrado para token:", token);
    return res.status(401).json({ error: "Usuário não autenticado." });
  }

  try {
    if (method === "GET") {
      const saquesFormatados = (user.saques || []).map(s => ({
        amount: s.valor ?? s.amount ?? null,
        pixKey: s.chave_pix ?? s.pixKey ?? null,
        keyType: s.tipo_chave ?? s.keyType ?? null,
        status: s.status ?? null,
        date: s.data ? (s.data instanceof Date ? s.data.toISOString() : new Date(s.data).toISOString()) : null,
        externalReference: s.externalReference || null,
        providerId: s.providerId || s.wooviId || s.openpixId || null,
      }));
      console.log("[DEBUG] Histórico de saques retornado:", saquesFormatados);
      return res.status(200).json(saquesFormatados);
    }

    // ===== POST =====
    // Normaliza body (compatível com body já parseado ou string)
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (e) { /* keep as-is */ }
    }

    const { amount, payment_method, payment_data } = body || {};
    console.log("[DEBUG] Dados recebidos para saque:", { amount, payment_method, payment_data });

    // Validações básicas
    if (!amount || (typeof amount !== "number" && typeof amount !== "string")) {
      console.log("[DEBUG] Valor de saque inválido:", amount);
      return res.status(400).json({ error: "Valor de saque inválido (mínimo R$0,01)." });
    }
    // aceita amount em reais (float) ou em centavos (inteiro)? assumimos reais (ex.: 10.50) -> convert below
    const amountNum = Number(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      console.log("[DEBUG] Valor de saque inválido após parse:", amountNum);
      return res.status(400).json({ error: "Valor de saque inválido." });
    }

    if (!payment_method || !payment_data?.pix_key || !payment_data?.pix_key_type) {
      console.log("[DEBUG] Dados de pagamento incompletos:", payment_data);
      return res.status(400).json({ error: "Dados de pagamento incompletos." });
    }

    // Verifica saldo (assumindo user.saldo em reais)
    if ((user.saldo ?? 0) < amountNum) {
      console.log("[DEBUG] Saldo insuficiente:", { saldo: user.saldo, amount: amountNum });
      return res.status(400).json({ error: "Saldo insuficiente." });
    }

    // Permitir apenas CPF por enquanto (ajuste se quiser permitir outros)
    const allowedTypes = ["CPF"];
    const keyType = (payment_data.pix_key_type || "").toUpperCase();
    if (!allowedTypes.includes(keyType)) {
      console.log("[DEBUG] Tipo de chave PIX inválido:", keyType);
      return res.status(400).json({ error: "Tipo de chave PIX inválido." });
    }

    // Formata chave
    let pixKey = String(payment_data.pix_key || "");
    if (keyType === "CPF" || keyType === "CNPJ") pixKey = pixKey.replace(/\D/g, "");
    console.log("[DEBUG] Chave PIX formatada:", pixKey);

    // Salva PIX do usuário se ainda não existir; se existir e diferente, bloqueia
    if (!user.pix_key) {
      user.pix_key = pixKey;
      user.pix_key_type = keyType;
      console.log("[DEBUG] Chave PIX salva no usuário:", { pixKey, keyType });
    } else if (user.pix_key !== pixKey) {
      console.log("[DEBUG] Chave PIX diferente da cadastrada:", { userPix: user.pix_key, novaPix: pixKey });
      return res.status(400).json({ error: "Chave PIX já cadastrada e não pode ser alterada." });
    }

    // Cria externalReference único
    const externalReference = `saque_${user._id}_${Date.now()}`;
    console.log("[DEBUG] externalReference gerada:", externalReference);

    // Monta objeto de saque e atualiza saldo & array (marca PENDING inicialmente)
    const novoSaque = {
      valor: amountNum,
      chave_pix: pixKey,
      tipo_chave: keyType,
      status: "PENDING",
      data: new Date(),
      providerId: null,
      externalReference,
      ownerName: user.name || "Usuário",
    };

    // Deduz saldo e armazena saque
    user.saldo = (user.saldo ?? 0) - amountNum;
    user.saques = user.saques || [];
    user.saques.push(novoSaque);
    await user.save();
    console.log("[DEBUG] Usuário atualizado com novo saque. Saldo agora:", user.saldo);

    // ===== Comunica com o provedor OpenPix (create -> approve) =====
    // Converte para centavos
    const valueInCents = Math.round(amountNum * 100);

    if (!OPENPIX_API_KEY) {
      console.error("[ERROR] OPENPIX_API_KEY não configurada");
      // restaura saldo e marca erro
      const idxErr0 = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idxErr0 >= 0) {
        user.saques[idxErr0].status = "FAILED";
        user.saques[idxErr0].error = { msg: "OPENPIX_API_KEY não configurada" };
        user.saldo += amountNum;
        await user.save();
      }
      return res.status(500).json({ error: "Configuração do provedor ausente." });
    }

    const createHeaders = {
      "Content-Type": "application/json",
      "Authorization": OPENPIX_API_KEY,
      "Idempotency-Key": externalReference
    };

    const createPayload = {
      value: valueInCents,
      destinationAlias: pixKey,
      destinationAliasType: keyType,
      correlationID: externalReference,
      comment: `Saque para ${user._id}`
    };

    console.log("[DEBUG] Payload createPayment enviado ao OpenPix:", createPayload);

    // Faz create payment
    let createRes;
    try {
      createRes = await fetch(`${OPENPIX_API_URL}/api/v1/payment`, {
        method: "POST",
        headers: createHeaders,
        body: JSON.stringify(createPayload)
      });
    } catch (err) {
      console.error("[ERROR] Falha na requisição createPayment:", err);
      // marca erro no saque e restaura saldo
      const idxErr = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idxErr >= 0) {
        user.saques[idxErr].status = "FAILED";
        user.saques[idxErr].error = { msg: "Falha na requisição createPayment", detail: err.message };
        user.saldo += amountNum; // restaura saldo
        await user.save();
      }
      return res.status(500).json({ error: "Erro ao comunicar com o provedor de pagamentos." });
    }

    const createText = await createRes.text();
    let createData;
    try { createData = JSON.parse(createText); } catch (err) {
      console.error("[ERROR] Resposta createPayment não-JSON:", createText);
      // restaura saldo e marca erro
      const idx = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idx >= 0) {
        user.saques[idx].status = "FAILED";
        user.saques[idx].error = { msg: "Resposta createPayment inválida", raw: createText };
        user.saldo += amountNum;
        await user.save();
      }
      return res.status(createRes.status || 500).json({ error: createText });
    }

    console.log("[DEBUG] Resposta createPayment:", createData, "Status HTTP:", createRes.status);

    if (!createRes.ok) {
      console.error("[DEBUG] Erro createPayment:", createData);
      // marca erro no saque e restaura saldo
      const idxErr = user.saques.findIndex(s => s.externalReference === externalReference);
      if (idxErr >= 0) {
        user.saques[idxErr].status = "FAILED";
        user.saques[idxErr].error = createData;
        user.saldo += amountNum;
        await user.save();
      }

      if (createRes.status === 403) {
        return res.status(403).json({ error: createData.error || createData.message || "Recurso não habilitado." });
      }

      return res.status(400).json({ error: createData.message || createData.error || "Erro ao criar pagamento no provedor." });
    }

    // Extrai possíveis identificadores úteis
    const paymentId = createData.id || createData.paymentId || createData.payment_id || createData.transaction?.id || null;
    const returnedCorrelation = createData.correlationID || createData.correlationId || createData.correlation || null;

    console.log("[DEBUG] paymentId extraído:", paymentId, "correlation retornada:", returnedCorrelation);

    // Atualiza o saque com providerId/correlation, mantendo status PENDING
    const createdIndex = user.saques.findIndex(s => s.externalReference === externalReference);
    if (createdIndex >= 0) {
      if (paymentId) user.saques[createdIndex].providerId = paymentId;
      if (!user.saques[createdIndex].externalReference) user.saques[createdIndex].externalReference = externalReference;
      user.saques[createdIndex].status = "PENDING";
      await user.save();
    }

    // Decide identificador para aprovação
    const toApproveIdentifier = paymentId || returnedCorrelation || externalReference;

    if (!toApproveIdentifier) {
      console.warn("[WARN] createPayment não retornou identificador usável — saque permanece PENDING.");
      return res.status(200).json({
        message: "Saque criado, aguardando aprovação manual (identificador não retornado).",
        create: createData
      });
    }

    // ===== Approve =====
    const approveHeaders = {
      "Content-Type": "application/json",
      "Authorization": OPENPIX_API_KEY,
      "Idempotency-Key": `approve_${toApproveIdentifier}`
    };

    // A API do OpenPix geralmente aceita { correlationID } conforme seu exemplo
    const approvePayload = paymentId ? { paymentId } : { correlationID: toApproveIdentifier };
    console.log("[DEBUG] Enviando approvePayment:", approvePayload);

    let approveRes;
    try {
      approveRes = await fetch(`${OPENPIX_API_URL}/api/v1/payment/approve`, {
        method: "POST",
        headers: approveHeaders,
        body: JSON.stringify(approvePayload)
      });
    } catch (err) {
      console.error("[ERROR] Falha na requisição approvePayment:", err);
      if (createdIndex >= 0) {
        user.saques[createdIndex].status = "PENDING_APPROVAL";
        user.saques[createdIndex].error = { msg: "Falha na requisição de aprovação", detail: err.message };
        await user.save();
      }
      return res.status(500).json({ error: "Erro ao aprovar pagamento (comunicação com provedor)." });
    }

    const approveText = await approveRes.text();
    let approveData;
    try { approveData = JSON.parse(approveText); } catch (err) {
      console.error("[ERROR] Resposta approvePayment não-JSON:", approveText);
      if (createdIndex >= 0) {
        user.saques[createdIndex].status = "PENDING_APPROVAL";
        user.saques[createdIndex].error = { msg: "Resposta de aprovação inválida", raw: approveText };
        await user.save();
      }
      return res.status(approveRes.status || 500).json({ error: approveText });
    }

    console.log("[DEBUG] Resposta approvePayment:", approveData, "Status HTTP:", approveRes.status);

    if (!approveRes.ok) {
      console.error("[DEBUG] Erro approvePayment:", approveData);
      if (approveRes.status === 403) {
        if (createdIndex >= 0) {
          user.saques[createdIndex].status = "PENDING_APPROVAL";
          user.saques[createdIndex].error = approveData;
          await user.save();
        }
        return res.status(403).json({ error: approveData.error || approveData.message || "Aprovação negada." });
      }

      if (createdIndex >= 0) {
        user.saques[createdIndex].status = "PENDING_APPROVAL";
        user.saques[createdIndex].error = approveData;
        await user.save();
      }
      return res.status(400).json({ error: approveData.message || approveData.error || "Erro ao aprovar pagamento." });
    }

    // Se approve ok -> atualiza status conforme retorno
    const approveStatus = approveData.status || approveData.transaction?.status || "COMPLETED";
    if (createdIndex >= 0) {
      user.saques[createdIndex].status = (approveStatus === "COMPLETED" || approveStatus === "EXECUTED") ? "COMPLETED" : approveStatus;
      user.saques[createdIndex].providerId = user.saques[createdIndex].providerId || paymentId || approveData.id || null;
      await user.save();
    }

    return res.status(200).json({
      message: "Saque processado (create → approve).",
      create: createData,
      approve: approveData
    });

  } catch (error) {
    console.error("💥 Erro em /withdraw:", error);
    return res.status(500).json({ error: "Erro ao processar saque." });
  }
}