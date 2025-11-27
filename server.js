import express from "express";
import path from "path";
import { fileURLToPath } from "url";

// Corrige caminhos dos arquivos
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// Serve index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Qualquer outra rota passa para handler.js (se usar)
app.use("/api", async (req, res) => {
  const { default: handler } = await import("./handler.js");
  return handler(req, res);
});

// Porta Railway / fallback local
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando na porta " + PORT));
