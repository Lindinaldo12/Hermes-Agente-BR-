// ==========================================
// ORQUESTRADOR — configuração de headers HTTP
// ==========================================
//
// Este arquivo NÃO é um módulo completo: é apenas um fragmento de
// configuração (o objeto `headers` solto). Não é `require()` por nada
// no projeto e não exporta nada.
//
// Se você pretendia usar esses headers, o formato correto seria:
//
//     const apiKey = process.env.OPENROUTER_API_KEY || process.env.API_KEY;
//     const headers = {
//         "Authorization": `Bearer ${apiKey}`,
//         "HTTP-Referer": "https://bobmeuagente.onrender.com",
//         "X-Title": "Bob AI X",
//         "Content-Type": "application/json"
//     };
//     module.exports = { headers };
//
// O mesmo objeto já está montado dentro de telegram.js, na função
// chamarOpenRouter() — é de lá que as chamadas reais à OpenRouter saem.

const apiKey = process.env.OPENROUTER_API_KEY || process.env.API_KEY || process.env.OPEN_ROUTER_KEY;

const headers = {
    "Authorization": `Bearer ${apiKey}`,
    "HTTP-Referer": "https://bobmeuagente.onrender.com",
    "X-Title": "Bob AI X",
    "Content-Type": "application/json"
};

module.exports = { apiKey, headers };
