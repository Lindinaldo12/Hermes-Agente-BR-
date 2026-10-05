// ==========================================
// BUSCA WEB — server tool da OpenRouter
// ==========================================
//
// A variante `:online` e o plugin `web` foram DEPRECIADOS pela
// OpenRouter. O caminho atual e expor a ferramenta `web_search` no
// corpo da requisicao; a OpenRouter promove para o server tool
// `openrouter:web_search` e o modelo decide quando buscar.
//
// Sem isso o modelo responde so com o que ja sabia no treino — que e
// justamente o problema de "me de informacoes atuais".

"use strict";

const TETO_RESULTADOS = 5;
const TETO_BUSCAS_POR_MSG = 6;

/**
 * Monta o corpo da requisicao de chat.
 *
 * @param {string} modelo    id do modelo, ex.: "meta-llama/llama-3.1-8b-instruct:free"
 * @param {Array}  messages  historico no formato OpenAI
 * @param {object} opcoes
 * @param {boolean} opcoes.buscarWeb   liga a busca (default true)
 * @param {boolean} opcoes.visao      forces a busca em perguntas de imagem
 * @returns {object} corpo pronto para JSON.stringify
 */
function montarCorpo(modelo, messages, opcoes = {}) {
    const buscarWeb = opcoes.buscarWeb !== false;

    const corpo = {
        model: modelo,
        messages,
    };

    if (buscarWeb) {
        // Tool declaration no formato OpenAI. A OpenRouter reconhece
        // `web_search` e promove para o server tool openrouter:web_search.
        corpo.tools = [
            {
                type: "web_search",
                search_prompt: "Considere estes resultados da web ao responder, citando as fontes.",
                max_results: TETO_RESULTADOS,
            },
        ];

        // Preferir o motor nativo quando o modelo tem (Anthropic,
        // Google, OpenAI, Perplexity). Para os demais a OpenRouter usa Exa.
        corpo.tool_choice = { type: "auto" };
    }

    return corpo;
}

/**
 * Extrai as fontes citadas na resposta, se a API as devolver.
 * A OpenRouter anexa em `data.choices[0].message.annotations` ou em
 * `citations`, dependendo do modelo. Tolerante a ausencia.
 */
function extrairFontes(data) {
    const msg = data?.choices?.[0]?.message;
    if (!msg) return [];

    const fontes = [];

    // Formato novo: annotations
    if (Array.isArray(msg.annotations)) {
        for (const a of msg.annotations) {
            const url = a.url_citation?.url || a.url || null;
            const titulo = a.url_citation?.title || a.title || null;
            if (url) fontes.push({ titulo, url });
        }
    }

    // Formato legado: citations
    if (!fontes.length && Array.isArray(msg.citations)) {
        for (const c of msg.citations) {
            if (c.url) fontes.push({ titulo: c.title || null, url: c.url });
        }
    }

    // Deduplica por URL
    const vistas = new Set();
    return fontes.filter((f) => {
        if (vistas.has(f.url)) return false;
        vistas.add(f.url);
        return true;
    });
}

/**
 * Monta o rodapé com as fontes, para o Telegram.
 */
function formatarFontes(fontes) {
    if (!fontes || !fontes.length) return "";
    const linhas = fontes
        .slice(0, TETO_BUSCAS_POR_MSG)
        .map((f, i) => `${i + 1}. ${f.titulo || f.url}\n   ${f.url}`);
    return `\n\n🔗 *Fontes*\n${linhas.join("\n")}`;
}

/**
 * Heurística barata: decide se vale ligar a busca.
 *
 * Busca custa $$ por requisicao, entao so liga quando a pergunta
 * realmente pede algo que o modelo pode nao saber. Mando como
 * parametro, nao adivinho: quem decide e o proprio modelo via
 * tool_choice=auto.
 */
function deveBuscar(texto) {
    const marcadores = [
        /\b(hoje|ontem|amanh[ãa]|agora|atualmente|recente|recentemente)\b/i,
        /\b(qual (é|sao) (o |a )?(pre[çc]o|not[íi]cia|resultado|pre[çc]o de))\b/i,
        /\b(quem (é|foi|ganhou|venceu))\b/i,
        /\b(cotação|cota[çc][ãa]o|pre[çc]o|d[óo]lar|euro|bitcoin|ac[çc][ãa]o)\b/i,
        /\b(vers[ãa]o|changelog|release|lan[çc]amento|atualiza[çc][ãa]o)\b/i,
        /\b(ler|abrir|acessar|baixar) (essa |esta )?(url|link|p[áa]gina|site)\b/i,
        /\bhttps?:\/\/\S+/i,
        /\b(ultimas noticias|not[íi]cias de hoje|o que aconteceu)\b/i,
    ];
    return marcadores.some((r) => r.test(texto || ""));
}

module.exports = {
    montarCorpo,
    extrairFontes,
    formatarFontes,
    deveBuscar,
    TETO_RESULTADOS,
};
