// ==========================================
// PONTE — Telegram → Orquestrador
// ==========================================
//
// Liga o bot do Telegram ao sistema de agentes que já existe no
// projeto (orquestrador/orquestrador.js). O orquestrador decide qual
// agente usar (Professor, Programador, Pesquisador...) e devolve:
//
//   { status: "agente", agente: "Professor", resposta: "texto" }
//   { status: "ia", agente: null, resposta: null }   ← caiu de volta pra IA
//
// Quando o orquestrador devolve "ia", quem responde é a chamada
// direta à OpenRouter que o telegram.js já faz. Ou seja: o orquestrador
// é um filtro inteligente, não um substituto.
//
// É esta ponte que estava faltando: nada no projeto chamava o
// orquestrador a partir do Telegram.

"use strict";

let orquestrador = null;
let carregou = false;

function obterOrquestrador() {
    if (carregou) return orquestrador;
    carregou = true;
    try {
        orquestrador = require("../orquestrador/orquestrador");
        console.log("🧠 Orquestrador de agentes conectado.");
    } catch (e) {
        console.warn(`⚠️ Orquestrador indisponível: ${e.message}`);
        console.warn("   O bot segue funcionando sem agentes.");
        orquestrador = null;
    }
    return orquestrador;
}

/**
 * Pergunta ao orquestrador.
 * @returns {Promise<{usouAgente:boolean, agente:string|null, resposta:string|null}>}
 */
async function consultarAgentes({ texto, userId, dadosWeb }) {
    const orq = obterOrquestrador();
    if (!orq || !orq.processar) {
        return { usouAgente: false, agente: null, resposta: null };
    }

    try {
        const saida = await orq.processar({
            texto: String(texto || ""),
            dadosWeb: dadosWeb || "",
            usuarioId: String(userId || "anonimo"),
        });

        if (saida && saida.status === "agente" && saida.resposta) {
            // O agente devolve o erro da API como se fosse resposta.
            // Não deixe isso chegar ao usuário: ele cairia no passo 2,
            // que tem tratamento de erro decente.
            const texto = String(saida.resposta);
            const pareceErro =
                /^(Erro na IA|.*\b401\b)|User not found|Unauthorized|tempo esgotado/i.test(
                    texto.trim()
                );
            if (pareceErro) {
                console.log(`⚠️ Agente ${saida.agente} devolveu erro, caindo para a IA direta.`);
                return { usouAgente: false, agente: saida.agente, resposta: null };
            }

            console.log(`✅ Agente respondeu: ${saida.agente}`);
            return {
                usouAgente: true,
                agente: saida.agente,
                resposta: texto,
            };
        }

        // status "ia" = nenhum agente serviu, a IA direta responde.
        return { usouAgente: false, agente: saida?.agente || null, resposta: null };
    } catch (e) {
        console.error(`❌ Erro no orquestrador: ${e.message}`);
        return { usouAgente: false, agente: null, resposta: null };
    }
}

module.exports = { consultarAgentes, obterOrquestrador };
