import connectDB from './db.js';
import { User, ActionHistory } from './schema.js';

const handler = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const {
    token,
    id_pedido,
    id_conta,
    nome_usuario,
    url_dir,
    quantidade_pontos,
    tipo_acao,
    tipo
  } = req.body;

  if (!token || !id_pedido || !id_conta || !nome_usuario || !url_dir || !quantidade_pontos || !tipo_acao || !tipo) {
    return res.status(400).json({ error: 'Campos obrigatórios ausentes' });
  }

  try {
    await connectDB();

    const user = await User.findOne({ token });
    if (!user) {
      return res.status(401).json({ error: 'Token inválido' });
    }

const existente = await ActionHistory.findOne({
  id_pedido,
  id_conta,
  acao_validada: 'pulada',
});

if (existente) {
  return res.status(200).json({ status: 'JA_PULADA' });
}

const novaAcao = new ActionHistory({
  user: user._id,
  token,
  nome_usuario,
  id_action: crypto.randomUUID(),
  id_pedido,
  id_conta,
  url_dir,
  quantidade_pontos,
  tipo_acao,
  tipo,
  acao_validada: 'pulada',
  rede_social: 'TikTok',
  createdAt: new Date()
});

    await novaAcao.save();

    return res.status(200).json({ status: 'PULADA_REGISTRADA' });
  } catch (error) {
    console.error('Erro ao registrar ação pulada:', error);
    return res.status(500).json({ error: 'Erro interno' });
  }
};

export default handler;