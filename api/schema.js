//schema.js
import mongoose from "mongoose";

// 🔹 Schema para Contas Vinculadas
const ContaSchema = new mongoose.Schema({
    nome_usuario: { type: String, required: true },
    status: { type: String, default: "ativa" },
    rede: {
        type: String
    },

    dataDesativacao: { type: Date }
});

// 🔹 Schema para Histórico de Ações
const ActionHistorySchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  token: { type: String },
  nome_usuario: { type: String },
  id_action: { type: String, required: true },
  url: { type: String, required: true },
  status: { type: String, enum: ['valida', 'pendente', 'pulada', 'invalida'], default: 'pendente' },
  acao_validada: { type: String, required: false },
  valor: { type: Number, required: false },
  tipo_acao: { type: String, required: true },
  rede_social: { type: String},
  afiliado: { type: String },
  data: { type: Date, default: Date.now },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

// 🔹 Schema para Histórico de Saques
const WithdrawSchema = new mongoose.Schema({
  valor: { type: Number, required: true },
  chave_pix: { type: String, required: true },
  tipo_chave: { type: String, default: "cpf" }
}, {
  timestamps: { createdAt: "data", updatedAt: "updatedAt" }
});

// 🔹 Schema do Usuário
const UserSchema = new mongoose.Schema(
  {
    nome: { type: String, required: false },

    email: {
      type: String,
      required: true,
      unique: true,
      index: true
    },

    // senha obrigatória apenas para cadastro tradicional
    senha: {
      type: String,
      required: function () {
        return this.provider === "local";
      }
    },

    token: { type: String, default: null },

    // provedor de autenticação
    provider: {
      type: String,
      enum: ["local", "google"],
      default: "local"
    },

    resetPasswordToken: { type: String, default: null },
    resetPasswordExpires: { type: Date, default: null },

    saldo: { type: Number, default: 0 },

    // contas conectadas
    contas: [ContaSchema],
    
historico_acoes: {
  type: [{ type: mongoose.Schema.Types.ObjectId, ref: "ActionHistory" }],
  default: [],
  set: v => {
    if (!Array.isArray(v)) return [];
    return v.filter(id => mongoose.Types.ObjectId.isValid(id));
  }
},
    saques: [WithdrawSchema],

    // afiliados
    codigo_afiliado: { type: String, default: null },
    indicado_por: { type: String, default: null },

    status: { type: String, default: "ativo" },
    ativo_ate: { type: Date, default: null }
  },
  {
    timestamps: true
  }
);

// 🔹 Índice parcial — só força unique se for string
UserSchema.index(
  { codigo_afiliado: 1 },
  {
    unique: true,
    partialFilterExpression: {
      codigo_afiliado: { $type: "string" }
    },
    name: "codigo_afiliado_1"
  }
);

const PedidoSchema = new mongoose.Schema({
  _id: { type: Number },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  rede: String,
  tipo: String,
  nome: String,
  quantidade: { type: Number, required: true },
  link: String,
  status: { type: String, enum: ["pendente", "reservada", "concluida"], default: "pendente" },
  dataCriacao: { type: Date, default: Date.now }
});

const DailyEarningSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  valor: {
    type: Number,
    required: true
  },
  data: {
    type: Date,
    required: true,
    default: () => new Date()
  },
  expiresAt: {
    type: Date,
    required: true
  }
});

DailyEarningSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// 🔹 Schema para Ranking Diário (atualizado)
const DailyRankingItemSchema = new mongoose.Schema({
  username: { type: String, required: true },
  token: { type: String, default: null },
  real_total: { type: Number, default: 0 },     // valor numérico real persistido
  is_current_user: { type: Boolean, default: false }
}, { _id: false });

const DailyRankingSchema = new mongoose.Schema({
  data: {
    type: String, // ex: "11/11/2025"
    required: true,
    unique: true
  },
  ranking: {
    type: [DailyRankingItemSchema],
    default: []
  },
  startAt: { type: Date, default: null },      // momento em que o ranking começou a progredir
  expiresAt: { type: Date, default: null },    // quando esse ranking expira (meia-noite)
  criadoEm: {
    type: Date,
    default: Date.now
  }
});

// índice único por data para garantir máximo 1 documento por dia
DailyRankingSchema.index({ data: 1 }, { unique: true });

// 🔥 LIMPA MODELS ANTIGOS (Vercel / Hot Reload)
if (mongoose.models.User) {
  try {
    mongoose.deleteModel("User");
  } catch (_) {}
}

if (mongoose.models.ActionHistory) {
  try {
    mongoose.deleteModel("ActionHistory");
  } catch (_) {}
}

// 🔹 Modelos (recriados com schema correto)
const User = mongoose.model("User", UserSchema);
const ActionHistory = mongoose.model("ActionHistory", ActionHistorySchema);
const Pedido = mongoose.models.Pedido || mongoose.model("Pedido", PedidoSchema);
const DailyEarning = mongoose.models.DailyEarning || mongoose.model("DailyEarning", DailyEarningSchema);
const DailyRanking = mongoose.models.DailyRanking || mongoose.model("DailyRanking", DailyRankingSchema);

export { User, ActionHistory, Pedido, DailyEarning, DailyRanking };
