import fs from "fs";
import mongoose from "mongoose";

// === CONFIGURAÇÃO DO MONGO ===
const MONGODB_URI = "mongodb+srv://renisson:renisson@cluster0.1iy44.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0"; // coloque sua URI aqui

await mongoose.connect(MONGODB_URI, {
  dbName: "test"
});

// Modelo da coleção pedidos
const PedidoSchema = new mongoose.Schema({
  _id: Number,
  userId: { type: String, default: null },
  status: { type: String, default: "pendente" },
  rede: { type: String, default: "tiktok" },
  tipo: { type: String, default: "seguir" },
  nome: String,
  valor: Number,
  quantidade: Number,
  link: String,
  dataCriacao: Date
});

const Pedido = mongoose.model("pedidos", PedidoSchema);

// === LER URLs DO ARQUIVO ===
const urls = fs.readFileSync("urls.txt", "utf8").trim().split("\n");

// Função geradora de _id numérico
function gerarId() {
  return Math.floor(Math.random() * 900000000) + 100000000;
}

// === INSERIR NO MONGO ===
for (const link of urls) {
  const documento = {
    _id: gerarId(),
    userId: null,
    status: "pendente",
    rede: "tiktok",
    tipo: "seguir",
    nome: `Ação seguir - ${link}`,
    valor: 1.6,
    quantidade: 1,
    link: link,
    dataCriacao: new Date()
  };

  try {
    await Pedido.create(documento);
    console.log("Inserido:", documento.link);
  } catch (err) {
    console.error("Erro ao inserir:", link, err.message);
  }
}

console.log("Processo finalizado.");
process.exit();
