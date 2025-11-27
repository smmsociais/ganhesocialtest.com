import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(express.json());

// dirname raiz
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// importar rotas
import handler from "./api/handler.js";
app.use("/api", handler);

// servir arquivos estáticos
app.use(express.static(__dirname));

// logs.html
app.get("/logs", (req, res) => {
  res.sendFile(path.join(__dirname, "logs.html"));
});

// página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// iniciar
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🔥 Servidor rodando na porta " + PORT)
);
