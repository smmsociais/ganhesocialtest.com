import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Se server.js rodar em /app, mas os arquivos estiverem em /app/api,
// detecta automaticamente:
const ROOT = path.join(__dirname); // diretório real do server.js
const HTML_DIR = path.join(ROOT);  // tenta servir do mesmo diretório

console.log("Server rodando a partir de:", ROOT);
console.log("Tentando servir HTML de:", HTML_DIR);

const app = express();
app.use(express.json());

// Serve arquivos estáticos (index.html e outros)
app.use(express.static(HTML_DIR));

// Rota /
app.get("/", (req, res) => {
  res.sendFile(path.join(HTML_DIR, "index.html"));
});

// Rotas /api
app.use("/api", async (req, res) => {
  const { default: handler } = await import("./handler.js");
  return handler(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
