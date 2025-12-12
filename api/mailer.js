// mailer.js
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendRecoveryEmail(email, link) {
  try {
    const data = await resend.emails.send({
      from: "GanheSocial <contato@ganhesocial.com>",
      to: email,
      subject: "Recuperação de Senha",
      html: `
        <p>Você solicitou a recuperação de senha.</p>
        <p>Clique no link abaixo para redefinir sua senha:</p>
        <p><a href="${link}">${link}</a></p>
        <p>Se você não solicitou essa recuperação, ignore este email.</p>
      `
    });

    console.log("Email enviado:", data);
    return data;

  } catch (error) {
    console.error("Erro ao enviar email:", error);
    throw new Error("Erro ao enviar email de recuperação");
  }
}
