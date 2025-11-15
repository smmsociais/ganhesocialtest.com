import mongoose from 'mongoose';

const MONGO_URI = 'mongodb+srv://renisson:renisson@cluster0.1iy44.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0'; // 🔁 Substitua pela sua URI

const userSchema = new mongoose.Schema({}, { strict: false });
const User = mongoose.model('User', userSchema);

async function atualizarContasSemStatus() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Conectado ao MongoDB");

    const usuarios = await User.find({ "contas.status": { $exists: false } });

    console.log(`🔎 Encontrados ${usuarios.length} usuários com contas sem status.`);

    for (const user of usuarios) {
      let atualizado = false;

      for (let conta of user.contas) {
        if (!conta.status) {
          conta.status = 'ativa';
          atualizado = true;
        }
      }

      if (atualizado) {
        await user.save();
        console.log(`✅ Usuário ${user.email || user._id} atualizado.`);
      }
    }

    console.log("🎉 Atualização concluída!");
    process.exit(0);

  } catch (error) {
    console.error("❌ Erro ao atualizar usuários:", error);
    process.exit(1);
  }
}

atualizarContasSemStatus();
