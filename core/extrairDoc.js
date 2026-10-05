// ==========================================
// EXTRATOR DE DOCUMENTOS
// ==========================================
//
// Antes o bot so lia PDF e TXT. Aqui foi ampliado para o que ele
// recebe de verdade no Telegram: Office, imagens, CSV, JSON, EPUB.
//
// Retorna sempre { texto, tipo, aviso } — nunca lanca excecao, porque
// uma falha aqui derrubaria o atendimento inteiro.

"use strict";

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const LIMITE_CARACTERES = 60000; // teto antes do corte por papel

/**
 * Dispensa o extrator pelo tipo do arquivo.
 * @returns {{texto:string, tipo:string, aviso:string|null}}
 */
function extrair(buffer, nomeArquivo, mimeType) {
    const nome = String(nomeArquivo || "").toLowerCase();
    const mime = String(mimeType || "").toLowerCase();

    try {
        // --- PDF ---
        if (nome.endsWith(".pdf") || mime === "application/pdf") {
            return porPdf(buffer);
        }
        // --- DOCX / PPTX / XLSX (ZIP com XML) ---
        if (/\.(docx|pptx|xlsx|odt|odp|ods)$/.test(nome)) {
            return porOffice(buffer, nome);
        }
        // --- Documento antigo .doc / .xls / .ppt (binário OLE) ---
        if (/\.(doc|xls|ppt)$/.test(nome)) {
            return {
                tipo: "legado",
                texto: "",
                aviso:
                    "Arquivos .doc/.xls/.ppt antigos não são lidos. " +
                    "Salve como .docx ou PDF e envie de novo.",
            };
        }
        // --- EPUB ---
        if (nome.endsWith(".epub")) {
            return porEpub(buffer);
        }
        // --- JSON / XML / CSV / Markdown / código ---
        if (/\.(json|xml|csv|tsv|md|txt|log|yaml|yml|ini|conf)$/.test(nome)) {
            return porTexto(buffer);
        }
        // --- HTML ---
        if (nome.endsWith(".html") || nome.endsWith(".htm") || mime === "text/html") {
            return porHtml(buffer);
        }
        // --- PDF unbekannt, texto genérico ---
        return porTexto(buffer);
    } catch (e) {
        return {
            tipo: "erro",
            texto: "",
            aviso: `Não consegui ler o arquivo: ${e.message}`,
        };
    }
}

// ==========================================
// EXTRATORES
// ==========================================

function porPdf(buffer) {
    const pdfParse = require("pdf-parse");
    const dados = pdfParse(buffer);
    const texto = (dados.text || "").trim();

    if (!texto) {
        // PDF escaneado = só imagens, sem camada de texto.
        return {
            tipo: "pdf-imagem",
            texto: "",
            aviso:
                "Este PDF parece ser imagem digitalizada (sem texto selecionável). " +
                "Envie uma foto da página que eu analiso por visão.",
            paginas: dados.numpages || null,
        };
    }
    return { tipo: "pdf", texto, aviso: null, paginas: dados.numpages || null };
}

function porTexto(buffer) {
    let texto = buffer.toString("utf8");
    // Remove BOM e null bytes comuns em arquivos exportados do Windows
    texto = texto.replace(/^﻿/, "").replace(/\0/g, "");
    return { tipo: "texto", texto: texto.trim(), aviso: null };
}

function porHtml(buffer) {
    let html = buffer.toString("utf8");
    // Remove script/style antes de extrair o texto
    html = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ");
    return { tipo: "html", texto: html.trim(), aviso: null };
}

/**
 * DOCX/PPTX/XLSX são ZIP cheios de XML.
 * Lê o ZIP em memória e concatena as partes de texto.
 */
function porOffice(buffer, nome) {
    // Zip de Office começa com PK\x03\x04. Validamos antes de tentar.
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        return {
            tipo: "office-invalido",
            texto: "",
            aviso: "O arquivo não parece ser um documento válido do Office.",
        };
    }

    const partes = extrairTextoDeZip(buffer, nome);
    if (!partes) {
        return {
            tipo: "office",
            texto: "",
            aviso: "Abri o documento mas não encontrei texto legível dentro dele.",
        };
    }
    return { tipo: "office", texto: partes, aviso: null };
}

/**
 * Percorre as entradas do ZIP procurando conteúdo textual.
 * Não depende de biblioteca externa: o ZIP do Office usa o método
 * 0 (store) ou 8 (deflate), ambos treatáveis com zlib do core.
 */
function extrairTextoDeZip(buffer, nome) {
    const textos = [];
    const alvo = /\.xlsx$/.test(nome) ? "sheet" : /\.pptx$/.test(nome) ? "slide" : "word";

    // Varre as assinaturas de arquivo local (PK\x03\x04)
    let i = 0;
    while (i < buffer.length - 4) {
        if (buffer[i] !== 0x50 || buffer[i + 1] !== 0x4b || buffer[i + 2] !== 0x03 || buffer[i + 3] !== 0x04) {
            i++;
            continue;
        }
        try {
            const metodo = buffer.readUInt16LE(i + 8);
            const tamComprimido = buffer.readUInt32LE(i + 18);
            const tamNome = buffer.readUInt16LE(i + 26);
            const tamExtra = buffer.readUInt16LE(i + 28);
            const inicioNome = i + 30;
            const inicioDados = inicioNome + tamNome + tamExtra;

            const nomeEntrada = buffer.slice(inicioNome, inicioNome + tamNome).toString("utf8");
            const dados = buffer.slice(inicioDados, inicioDados + tamComprimido);

            if (nomeEntrada.includes(alvo) && /\.(xml|rels)$/.test(nomeEntrada)) {
                let xml;
                if (metodo === 0) {
                    xml = dados.toString("utf8");
                } else if (metodo === 8) {
                    xml = zlib.inflateRawSync(dados).toString("utf8");
                }
                if (xml) {
                    const limpo = xml
                        .replace(/<[^>]+>/g, " ")
                        .replace(/&amp;/g, "&")
                        .replace(/&lt;/g, "<")
                        .replace(/&gt;/g, ">")
                        .replace(/\s+/g, " ")
                        .trim();
                    if (limpo) textos.push(limpo);
                }
            }
            i = inicioDados + tamComprimido;
        } catch (e) {
            i += 4;
        }
    }

    return textos.length ? textos.join("\n\n") : null;
}

function porEpub(buffer) {
    if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
        return { tipo: "epub", texto: "", aviso: "EPUB inválido." };
    }
    const textos = extrairTextoDeZip(buffer, "epub");
    // O EPUB guarda o conteúdo em arquivos .xhtml/.html
    return textos
        ? { tipo: "epub", texto: textos, aviso: null }
        : { tipo: "epub", texto: "", aviso: "EPUB sem texto extraível." };
}

/**
 * Corta respeitando o limite do papel.
 * Tenta não partir palavra no meio.
 */
function aplicarLimite(texto, maximo) {
    if (!texto || texto.length <= maximo) {
        return { texto, cortado: false };
    }
    let corte = texto.slice(0, maximo);
    const ultimoEspaco = corte.lastIndexOf(" ");
    if (ultimoEspaco > maximo * 0.6) corte = corte.slice(0, ultimoEspaco);
    return {
        texto: `${corte}\n\n[... conteúdo cortado em ${maximo} caracteres ...]`,
        cortado: true,
    };
}

module.exports = { extrair, aplicarLimite, LIMITE_CARACTERES };
