// rebuild_saldos.js
import { MongoClient, ObjectId } from "mongodb";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://renisson:renisson@cluster0.1iy44.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
if (!MONGODB_URI) throw new Error("MONGODB_URI não definido");

async function run() {
  const client = await MongoClient.connect(MONGODB_URI);
  const db = client.db();
  const usersCol = db.collection("users");
  const actionsCol = db.collection("actionhistories");

  // cursor de todos os usuários (pode paginar se tiver muitos)
  const cursor = usersCol.find({}, { projection: { _id: 1, saques: 1 } });

  let updated = 0;
  while (await cursor.hasNext()) {
    const user = await cursor.next();
    const userId = user._id;

    // soma das ações validadas (valor_confirmacao)
    const aAgg = await actionsCol.aggregate([
      { $match: { user: userId, acao_validada: "valida" } },
      { $group: { _id: null, totalEarnings: { $sum: { $toDouble: { $ifNull: ["$valor_confirmacao", 0] } } } } }
    ]).toArray();

    const totalEarnings = (aAgg[0] && aAgg[0].totalEarnings) ? aAgg[0].totalEarnings : 0;

    // soma de saques do próprio documento user.saques
    const totalSaques = (Array.isArray(user.saques) && user.saques.length) ? user.saques.reduce((s, x) => s + (x.valor || 0), 0) : 0;

    const newSaldo = Math.round((totalEarnings - totalSaques) * 100) / 100;

    // atualiza só se diferente (evita writes desnecessários)
    const currentSaldo = user.saldo || 0;
    if (currentSaldo !== newSaldo) {
      await usersCol.updateOne({ _id: userId }, { $set: { saldo: newSaldo } });
      updated++;
    }
  }

  console.log("Concluído. Users atualizados:", updated);
  await client.close();
}

run().catch(err => {
  console.error("Erro:", err);
  process.exit(1);
});
