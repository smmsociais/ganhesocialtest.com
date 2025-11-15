import { MongoClient, ObjectId } from "mongodb";

async function main() {
  const uri = "mongodb+srv://renisson:renisson@cluster0.1iy44.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"; // ajuste para sua URI (ex: mongodb+srv://user:pass@cluster/...)
  const client = new MongoClient(uri);

  try {
    await client.connect();
    const db = client.db("test"); // altere para o nome do seu banco
    const collection = db.collection("dailyrankings");

    const doc = {
      _id: new ObjectId("6915e4b82f0e790004d0bfcc"),
      data: "13/11/2025",
      __v: 0,
      criadoEm: new Date("2025-11-13T18:40:16.732Z"),
      expiresAt: new Date("2025-11-14T03:00:00.000Z"),
      startAt: new Date("2025-11-13T03:00:00.000Z"),
      ranking: [
        { token: null, real_total: 20, is_current_user: false, username: "unknown" },
        { token: null, real_total: 18, is_current_user: false, username: "KingdosMTD🥱🥱" },
        { token: null, real_total: 16, is_current_user: false, username: "Luiza" },
        { token: null, real_total: 14, is_current_user: false, username: "Allef 🔥" },
        { token: null, real_total: 10, is_current_user: false, username: "Deus🔥" },
        { token: null, real_total: 5.5, is_current_user: false, username: "Lipe Rodagem Interna 😄" },
        { token: null, real_total: 4.5, is_current_user: false, username: "-" },
        { token: null, real_total: 3.5, is_current_user: false, username: "-" },
        { token: null, real_total: 2.5, is_current_user: false, username: "-" },
        { token: null, real_total: 1.5, is_current_user: false, username: "Junior" },
        { token: null, real_total: 2.5, is_current_user: false, username: "-" },
        { token: null, real_total: 1.5, is_current_user: false, username: "-" }
      ]
    };

    const result = await collection.insertOne(doc);
    console.log("✅ Documento inserido com _id:", result.insertedId);

  } catch (err) {
    console.error("❌ Erro ao inserir documento:", err);
  } finally {
    await client.close();
  }
}

main();
