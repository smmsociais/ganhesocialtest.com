import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());

// ⬇️ IMPORTAR SUAS ROTAS
import handler from "./api/handler.js";
app.use("/api", handler);

// ⬇️ SERVIR ARQUIVOS HTML
app.use(express.static(__dirname));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// ⬇️ INICIAR SERVIDOR
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log("🔥 Servidor rodando na porta " + PORT)
);
