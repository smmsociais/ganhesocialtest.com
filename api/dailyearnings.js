import { MongoClient, ObjectId } from "mongodb";

const uri = "mongodb+srv://renisson:renisson@cluster0.1iy44.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const client = new MongoClient(uri);

async function run() {
  try {
    await client.connect();

    // Nome do banco e coleção
    const db = client.db("test"); // altere se quiser outro banco
    const collection = db.collection("dailyearnings");

    // Documento a ser inserido
    const document = {
      _id: new ObjectId("6915e5e6f20e3d78723bd141"),
      expiresAt: new Date("2025-11-14T03:00:00.000Z"),
      userId: new ObjectId("68ed6d4e2237120004051a94"),
      __v: 0,
      valor: 500
    };

    // Inserir no banco
    const result = await collection.insertOne(document);
    console.log("✅ Documento inserido com sucesso!");
    console.log("🆔 ID inserido:", result.insertedId);
  } catch (err) {
    console.error("❌ Erro ao inserir documento:", err);
  } finally {
    await client.close();
  }
}

run();
