// ==========================================
// AUTH — controle de acesso do Bob
// ==========================================
//
// Três níveis de permissão:
//   master  → acesso total + painel de administração
//   admin   → acesso total, sem painel
//   user    → uso simples: texto, foto e PDF.
//
// Quem não estiver na lista e não tiver convite entra como `user`
// automaticamente. Isso é intencional: o bot é aberto via link, mas
// o custo de API é limitado ao uso simples.
//
// A senha (ACCESS_PASSWORD) só é exigida para operações
// administrativas — nunca no uso normal.

"use strict";

require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const REGISTRO_PATH = path.join(__dirname, "../memoria/acessos.json");

const MASTER_ID = String(process.env.MASTER_ID || "").trim();
// Aceita tanto JSON (["1","2"]) quanto lista simples (1,2) — remove
// aspas E colchetes antes de dividir.
const ADMIN_IDS = new Set(
  String(process.env.ADMIN_IDS || "")
    .replace(/[[\]"']/g, "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const SENHA = String(process.env.ACCESS_PASSWORD || "").trim();

// ==========================================
// PAPÉIS
// ==========================================

const PAPEIS = {
    MASTER: "master",
    ADMIN: "admin",
    USER: "user",
};

/**
 * Descobre o papel de um chatId a partir do ambiente.
 */
function papelDe(chatId) {
    const id = String(chatId);
    if (MASTER_ID && id === MASTER_ID) return PAPEIS.MASTER;
    if (ADMIN_IDS.has(id)) return PAPEIS.ADMIN;
    return PAPEIS.USER;
}

function ehMaster(chatId) {
    return papelDe(chatId) === PAPEIS.MASTER;
}

function ehAdmin(chatId) {
    const p = papelDe(chatId);
    return p === PAPEIS.MASTER || p === PAPEIS.ADMIN;
}

/**
 * Trava de senha: só admin precisa, e só para comando sensível.
 * Retorna true se liberado (inclusive quando não há senha configurada).
 */
function senhaCorreta(senhaTentada) {
    // Sem senha configurada, não há o que checar.
    if (!SENHA) return true;
    if (typeof senhaTentada !== "string" || !senhaTentada) return false;

    // Comparação em tempo constante, para não vazar por timing.
    const a = crypto.createHash("sha256").update(senhaTentada).digest();
    const b = crypto.createHash("sha256").update(SENHA).digest();
    return crypto.timingSafeEqual(a, b);
}

/**
 * Limites por papel, para conter o custo de API.
 * Recebe o PAPEL (não o chatId) — quem chama já resolveu o papel.
 */
function limitesDoPapel(papel) {
    if (papel === PAPEIS.MASTER || papel === PAPEIS.ADMIN) {
        return { maxCaracteres: 15000, maxImagens: true, semLimite: true };
    }
    return { maxCaracteres: 6000, maxImagens: true, semLimite: false };
}

function nomeDoPapel(papel) {
    switch (papel) {
        case PAPEIS.MASTER: return "Master";
        case PAPEIS.ADMIN: return "Administrador";
        default: return "Usuário";
    }
}

// ==========================================
// REGISTRO PERSISTENTE DE ACESSOS
// ==========================================
//
// Grava em memoria/acessos.json: quem já entrou, quando, e com que
// papel. Sobrevive a reinício — o .env sozinho não guarda histórico.
//
// A escrita é atômica (grava em .tmp e renomeia) para não corromper o
// arquivo se o processo cair no meio da escrita.

function caminhoRegistro() {
    // Permite trocar o destino em testes sem mexer no código.
    return process.env.ACESSOS_PATH || REGISTRO_PATH;
}

function carregarRegistro() {
    try {
        const bruto = fs.readFileSync(caminhoRegistro(), "utf8");
        const dados = JSON.parse(bruto);
        if (!dados || typeof dados !== "object") throw new Error("formato inválido");
        if (!Array.isArray(dados.usuarios)) dados.usuarios = [];
        return dados;
    } catch (e) {
        // Arquivo ausente ou corrompido: começa limpo, sem derrubar o bot.
        return { usuarios: [], criadoEm: new Date().toISOString() };
    }
}

function salvarRegistro(dados) {
    const destino = caminhoRegistro();
    const tmp = destino + ".tmp";
    try {
        fs.mkdirSync(path.dirname(destino), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(dados, null, 2));
        fs.renameSync(tmp, destino); // rename é atômico no mesmo volume
        return true;
    } catch (e) {
        console.warn(`⚠️  Não consegui gravar o registro de acessos: ${e.message}`);
        try { fs.unlinkSync(tmp); } catch (_) { /* nada a fazer */ }
        return false;
    }
}

/**
 * Registra um acesso. Chamado a cada mensagem recebida.
 * Não duplica: um usuário existente é só atualizado (últimaSeen, mensagens).
 */
function registrarAcesso({ chatId, nome, username, mensagem = true }) {
    const dados = carregarRegistro();
    const id = String(chatId);
    const papel = papelDe(id);
    const agora = new Date().toISOString();

    let reg = dados.usuarios.find((u) => String(u.id) === id);

    if (!reg) {
        reg = {
            id,
            nome: nome || null,
            username: username || null,
            papel,
            papelOriginal: papel,
            primeiraVez: agora,
            ultimaVez: agora,
            mensagens: 0,
            elegivel: true,
        };
        dados.usuarios.push(reg);
        console.log(`👤 Novo acesso: ${nome || id} (${papel})`);
    } else {
        reg.ultimaVez = agora;
        if (nome) reg.nome = nome;
        if (username) reg.username = username;
        // Papel do registro segue o .env, mas guarda o original para
        // auditoria (saber se já foi master e perdeu acesso).
        reg.papel = papel;
    }

    if (mensagem) reg.mensagens = (reg.mensagens || 0) + 1;

    salvarRegistro(dados);
    return reg;
}

/**
 * Lista os acessos, do mais recente para o mais antigo.
 */
function listarAcessos(limite = 20) {
    const dados = carregarRegistro();
    return [...dados.usuarios]
        .sort((a, b) => String(b.ultimaVez).localeCompare(String(a.ultimaVez)))
        .slice(0, limite);
}

/**
 * Estatísticas agregadas para o /painel.
 */
function estatisticas() {
    const dados = carregarRegistro();
    const u = dados.usuarios;
    const agora = Date.now();
    const ativos24h = u.filter(
        (x) => (agora - Date.parse(x.ultimaVez || 0)) < 86400000
    ).length;
    const ativos7d = u.filter(
        (x) => (agora - Date.parse(x.ultimaVez || 0)) < 604800000
    ).length;
    return {
        total: u.length,
        masters: u.filter((x) => x.papel === PAPEIS.MASTER).length,
        admins: u.filter((x) => x.papel === PAPEIS.ADMIN).length,
        users: u.filter((x) => x.papel === PAPEIS.USER).length,
        ativos24h,
        ativos7d,
        mensagens: u.reduce((s, x) => s + (x.mensagens || 0), 0),
    };
}

/**
 * Remove um acesso do registro (não revoga o acesso ao bot — quem
 * não estiver no .env já entra como user de qualquer forma).
 */
function removerAcesso(chatId) {
    const dados = carregarRegistro();
    const antes = dados.usuarios.length;
    dados.usuarios = dados.usuarios.filter((u) => String(u.id) !== String(chatId));
    if (dados.usuarios.length !== antes) {
        salvarRegistro(dados);
        return true;
    }
    return false;
}

/**
 * Diagnóstico na inicialização: registra no log o estado do registro.
 */
function diagnostico() {
    const problemas = [];
    if (!MASTER_ID) problemas.push("MASTER_ID não configurado — nenhum master reconhecido.");
    if (!SENHA) problemas.push("ACCESS_PASSWORD não configurada — comandos administrativos ficam abertos.");
    if (ADMIN_IDS.size === 0) problemas.push("ADMIN_IDS vazio — somente o master tem permissão elevada.");
    const reg = carregarRegistro();
    return {
        ok: problemas.length === 0,
        problemas,
        resumo: {
            master: MASTER_ID || "(não configurado)",
            admins: ADMIN_IDS.size,
            senhaDefinida: Boolean(SENHA),
            registrados: reg.usuarios.length,
            registroAtivo: reg.usuarios.length > 0,
        },
    };
}

module.exports = {
    PAPEIS,
    papelDe,
    ehMaster,
    ehAdmin,
    senhaCorreta,
    limitesDoPapel,
    nomeDoPapel,
    registrarAcesso,
    listarAcessos,
    estatisticas,
    removerAcesso,
    diagnostico,
};
