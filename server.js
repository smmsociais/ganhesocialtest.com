import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// Serve arquivos estáticos da raiz
app.use(express.static(__dirname));

// Rota API
app.use("/api", async (req, res) => {
  const { default: handler } = await import("./api/handler.js");
  return handler(req, res);
});

// Rota da página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Rota da página inicial
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "login.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
