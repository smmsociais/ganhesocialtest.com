import express from "express";
import axios from "axios";
import connectDB from './db.js';
import { User } from "./schema.js";

const router = express.Router();

const CAPMONSTER_API_KEY = "cbbe3f324b95a704eeb9a2d3aa1565b3";
const WEBSITE_URL = "https://www.ganharnasredes.com/painel/?pagina=login";
const WEBSITE_KEY = "6LeHHAoaAAAAAO8g8W16nDsmqD7sh1co6HBy_hpT";

const EMAIL = "renissontk@gmail.com";
const SENHA = "ffffff";

// 🔍 Resolver Captcha
async function resolverCaptcha() {
    console.log("🚩 Iniciando resolução do captcha...");
    const { data } = await axios.post("https://api.capmonster.cloud/createTask", {
        clientKey: CAPMONSTER_API_KEY,
        task: {
            type: "NoCaptchaTaskProxyless",
            websiteURL: WEBSITE_URL,
            websiteKey: WEBSITE_KEY
        }
    });

    if (data.errorId !== 0) throw new Error(`❌ Erro criando task no CapMonster: ${data.errorDescription}`);
    const taskId = data.taskId;
    console.log(`🆗 Task criada com ID: ${taskId}`);

    while (true) {
        console.log("⏳ Aguardando resultado do captcha...");
        const { data: res } = await axios.post("https://api.capmonster.cloud/getTaskResult", {
            clientKey: CAPMONSTER_API_KEY,
            taskId
        });

        if (res.errorId !== 0) throw new Error(`❌ Erro no captcha: ${res.errorDescription}`);
        if (res.status === "ready") {
            console.log("✅ Captcha resolvido com sucesso.");
            return res.solution.gRecaptchaResponse;
        }
        await new Promise(r => setTimeout(r, 50000)); // Espera 5 segundos
    }
}

// 🔐 Login no site externo
async function loginSiteExterno() {
    console.log("🚀 Iniciando login no site externo...");
    const captchaToken = await resolverCaptcha();

    console.log("🔑 Enviando dados de login...");
    const formData = new URLSearchParams();
    formData.append("email", EMAIL);
    formData.append("senha", SENHA);
    formData.append("g-recaptcha-response", captchaToken);

    const response = await axios.post(
        "https://www.ganharnasredes.com/painel/",
        formData.toString(),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0",
                Referer: WEBSITE_URL,
            },
            maxRedirects: 0,
            validateStatus: status => status < 500,
        }
    );

    const cookies = response.headers["set-cookie"];
    if (!cookies) {
        console.log("❌ Falha no login. Cookies não recebidos.");
        throw new Error("Falha no login externo");
    }

    console.log("🎉 Login realizado com sucesso. Cookies obtidos.");
    return cookies;
}

// ➕ Adicionar conta no site externo
async function adicionarContaSiteExterno(cookies, nomeConta) {
    console.log(`🚩 Iniciando adição da conta "${nomeConta}" no site externo...`);

    const formData = new URLSearchParams();
    formData.append("rede_social", "tiktok");
    formData.append("nome_usuario", nomeConta);
    formData.append("sexo", "1");
    formData.append("estado", "SP");

    const response = await axios.post(
        "https://www.ganharnasredes.com/painel/?pagina=adicionar_conta&action=informar_dados",
        formData.toString(),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "User-Agent": "Mozilla/5.0",
                Cookie: cookies.join("; "),
                Referer: "https://www.ganharnasredes.com/painel/?pagina=adicionar_conta&action=informar_dados"
            }
        }
    );

    if (response.status === 200) {
        console.log(`✅ Conta "${nomeConta}" adicionada com sucesso no site externo.`);
    } else {
        console.log(`❌ Falha ao adicionar conta. Status: ${response.status}`);
        throw new Error("Erro ao adicionar conta no site externo");
    }
}

// 🔗 Rota da API
router.post("/api/adicionar-conta-externa", async (req, res) => {
    const { nomeConta, token } = req.body;
    console.log(`📥 Requisição recebida para adicionar conta: "${nomeConta}"`);

    if (!nomeConta || !token) {
        console.log("❌ Nome da conta ou token ausente.");
        return res.status(400).json({ error: "Nome da conta e token são obrigatórios." });
    }

    try {
        await connectDB();
        console.log("🗄️ Banco de dados conectado.");

        const user = await User.findOne({ token });
        if (!user) {
            console.log("❌ Token inválido. Usuário não encontrado.");
            return res.status(401).json({ error: "Token inválido" });
        }

        console.log("🔑 Token válido. Usuário autenticado.");

        const cookies = await loginSiteExterno();
        await adicionarContaSiteExterno(cookies, nomeConta);

        console.log(`🎯 Processo concluído para a conta "${nomeConta}".`);
        return res.json({ success: true, message: `Conta "${nomeConta}" adicionada no site externo.` });
    } catch (error) {
        console.error("❌ Erro durante o processo:", error.message);
        return res.status(500).json({ error: error.message });
    }
});

export default router;
