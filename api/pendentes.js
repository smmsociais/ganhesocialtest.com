import mongoose from "mongoose";
import { ActionHistory } from "./schema.js";
import dotenv from "dotenv";
dotenv.config();


async function contarAcoesPendentes() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);

    const totalPendentes = await ActionHistory.countDocuments({
      acao_validada: "pendente"
    });

    console.log("Total de ações pendentes:", totalPendentes);
    return totalPendentes;

  } catch (error) {
    console.error("Erro ao contar ações pendentes:", error);
  } finally {
    await mongoose.disconnect();
  }
}

contarAcoesPendentes();
