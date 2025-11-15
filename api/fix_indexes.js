// fix_indexes.js
import mongoose from "mongoose";

async function run() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/test";
  await mongoose.connect(uri, { useNewUrlParser: true, useUnifiedTopology: true });

  const col = mongoose.connection.collection("users");

  // listar índices
  const indexes = await col.indexes();
  console.log("Índices atuais:", indexes.map(i => i.name));

  // tenta dropar se existir
  const existing = indexes.find(i => i.name === "codigo_afiliado_1");
  if (existing) {
    console.log("Dropando índice 'codigo_afiliado_1'...");
    await col.dropIndex("codigo_afiliado_1");
  } else {
    console.log("Índice antigo não encontrado, seguindo para criação.");
  }

  // cria índice parcial
  console.log("Criando índice parcial codigo_afiliado_1...");
  await col.createIndex(
    { codigo_afiliado: 1 },
    { unique: true, partialFilterExpression: { codigo_afiliado: { $type: "string" } }, name: "codigo_afiliado_1" }
  );

  console.log("Índice criado com sucesso.");
  await mongoose.disconnect();
}

run().catch(err => {
  console.error("Erro no script de índices:", err);
  process.exit(1);
});
