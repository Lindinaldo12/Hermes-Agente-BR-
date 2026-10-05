require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const acesso = require('./core/acesso');
const websearch = require('./core/websearch');
const extrairDoc = require('./core/extrairDoc');
const ponte = require('./connect/ponteOrquestrador');

const token = process.env.TELEGRAM_TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const apiKey = process.env.OPENROUTER_API_KEY || process.env.API_KEY || process.env.GROQ_API_KEY;

if (!token) {
    console.error('❌ TELEGRAM_TOKEN não configurado no Render!');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

if (apiKey) {
    console.log('⚡ Conectado à OpenRouter com sucesso!');
} else {
    console.log('⚠️ Chave de API ausente nas variáveis do Render.');
}

// Diagnóstico de permissões na subida
const diag = acesso.diagnostico();
console.log(`🔐 Acesso: master=${diag.resumo.master} | admins=${diag.resumo.admins} | senha=${diag.resumo.senhaDefinida ? 'sim' : 'NÃO'}`);
diag.problemas.forEach((p) => console.warn(`⚠️  ${p}`));


// 📦 Função auxiliar para enviar mensagens longas sem estourar o limite de 4096 do Telegram
async function enviarMensagemLonga(chatId, texto, options = {}) {
    if (!texto) return;
    const LIMITE = 3800; // Margem de segurança

    if (texto.length <= LIMITE) {
        return await bot.sendMessage(chatId, texto, options);
    }

    let inicio = 0;
    while (inicio < texto.length) {
        let fim = inicio + LIMITE;
        if (fim < texto.length) {
            // Procura a última quebra de linha para não cortar uma frase ao meio
            const ultimaQuebra = texto.lastIndexOf('\n', fim);
            if (ultimaQuebra > inicio) {
                fim = ultimaQuebra;
            }
        }
        const pedaco = texto.slice(inicio, fim);
        await bot.sendMessage(chatId, pedaco, options);
        inicio = fim;
    }
}

// Modelos que NÃO servem para o bot mesmo sendo gratuitos.
// Filtrados na mão porque o filtro automático por 'image' os inclui:
//   - lyria-*          : geram ÁUDIO, não texto
//   - nemotron-*-safety : classificam conteúdo, não respondem
//   - stealth/*        : modelo de sistema, não está no catálogo público
const MODELOS_BLOQUEADOS = [
    'lyria',
    'content-safety',
    'stealth/',
];

function ehBloqueado(id) {
    const baixo = id.toLowerCase();
    return MODELOS_BLOQUEADOS.some((p) => baixo.includes(p.toLowerCase()));
}

/**
 * Verifica se o modelo aceita imagem E devolve texto.
 *
 * A API devolve modality como string no formato "text+image+video->text".
 * Precisamos dos dois lados: entrada tem image, saída tem text.
 */
function aceitaImagem(modelo) {
    const modality = modelo?.architecture?.modality;
    if (!modality) return false;
    if (Array.isArray(modality)) {
        return modality.includes('image') && modality.includes('text');
    }
    if (typeof modality === 'string') {
        const [entrada, saida] = modality.split('->');
        return entrada.split('+').includes('image') && saida.split('+').includes('text');
    }
    return false;
}

// Busca dinamicamente os modelos GRATUITOS e ATIVOS na OpenRouter
async function obterModelosGratuitosAtivos(eFoto = false) {
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models');
        if (res.ok) {
            const json = await res.json();
            const todosModelos = json.data || [];

            const gratis = todosModelos.filter((m) =>
                (m.id.endsWith(':free') || (m.pricing && m.pricing.prompt === '0')) &&
                !ehBloqueado(m.id)
            );

            if (eFoto) {
                // Só quem aceita imagem E responde texto.
                const visao = gratis.filter(aceitaImagem).map((m) => m.id);
                if (visao.length > 0) {
                    console.log(`👁️ ${visao.length} modelo(s) de visão disponível(is): ${visao.slice(0, 3).join(', ')}`);
                    return visao;
                }
                console.log('⚠️ Nenhum modelo gratuito de visão encontrado na lista.');
            } else {
                const texto = gratis.filter((m) => !aceitaImagem(m) || m.id === 'openrouter/free')
                    .map((m) => m.id);
                if (texto.length > 0) return texto;
            }
        }
    } catch (e) {
        console.log('⚠️ Falha ao buscar lista dinâmica da OpenRouter, usando fallback.');
    }

    // Fallback: modelos confirmados com visão por texto->texto.
    if (eFoto) {
        return [
            'google/gemma-4-26b-a4b-it:free',
            'dots-studio/dots-3-note-preview:free',
            'openrouter/free',
        ];
    } else {
        return [
            'meta-llama/llama-3.1-8b-instruct:free',
            'qwen/qwen-2.5-72b-instruct:free',
            'google/gemma-4-26b-a4b-it:free',
        ];
    }
}

// Função para chamar a IA no OpenRouter
// Busca web é ligada por padrão: o modelo decide se precisa consultar.
// timeout AbortController evita travamento quando a API não responde.
async function chamarOpenRouter(messages, eFoto = false, opcoes = {}) {
    if (!apiKey) {
        throw new Error('Chave de API não configurada no Render (OPENROUTER_API_KEY ou API_KEY).');
    }

    const buscarWeb = opcoes.buscarWeb !== false;
    const timeoutMs = opcoes.timeoutMs || 90000;

    const modelos = await obterModelosGratuitosAtivos(eFoto);
    let ultimoErro = null;

    for (const model of modelos) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const corpo = websearch.montarCorpo(model, messages, { buscarWeb });

            const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'HTTP-Referer': 'https://bobmeuagente.onrender.com',
                    'X-Title': 'Bob AI X',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(corpo),
                signal: controller.signal
            });

            const data = await res.json();

            if (res.ok && data.choices && data.choices[0]?.message?.content) {
                clearTimeout(timer);
                console.log(`✅ Resposta com ${model}${buscarWeb ? ' (busca web ligada)' : ''}`);
                const fontes = websearch.extrairFontes(data);
                return data.choices[0].message.content + websearch.formatarFontes(fontes);
            } else if (data.error) {
                clearTimeout(timer);
                console.log(`⚠️ Modelo ${model} indisponível: ${data.error.message || 'Erro'}. Testando próximo...`);
                ultimoErro = new Error(data.error.message || 'Erro no modelo');
            }
        } catch (err) {
            clearTimeout(timer);
            const msg = err.name === 'AbortError'
                ? `tempo esgotado (${Math.round(timeoutMs / 1000)}s)`
                : err.message;
            console.log(`⚠️ Erro no modelo ${model}: ${msg}`);
            ultimoErro = new Error(msg);
        }
    }

    throw ultimoErro || new Error('Nenhum modelo gratuito disponível no momento.');
}

/**
 * Erro amigável: o usuário vê a causa real, não um genérico.
 * Antes ele recebia "Erro na análise da foto" sem explicação e ficava
 * achando que o app estava quebrado.
 */
function explicarErro(error, contexto) {
    const msg = String(error?.message || '').toLowerCase();

    if (msg.includes('401') || msg.includes('user not found') || msg.includes('unauthorized')) {
        return '🔑 *Chave da API inválida ou expirada.*\n\n' +
            'O token da OpenRouter não foi aceito. Troque a chave no painel do Render ' +
            '(Environment → OPENROUTER_API_KEY) e faça novo deploy.';
    }
    if (msg.includes('no free') || msg.includes('nenhum modelo')) {
        return '⚠️ Nenhum modelo gratuito disponível agora.\n\n' +
            'Tente de novo em alguns minutos — a oferta gratuita da OpenRouter varia.';
    }
    if (msg.includes('image') || msg.includes('vision') || msg.includes('modalit')) {
        return '🖼️ *Não consegui analisar a imagem.*\n\n' +
            'Todos os modelos gratuitos de visão falharam. Tente:' +
            '\n• enviar uma foto menor' +
            '\n• usar um documento PDF em vez da foto' +
            '\n• tentar de novo mais tarde';
    }
    if (msg.includes('tempo esgotado') || msg.includes('timeout')) {
        return '⏱️ *Demorei demais para responder.*\n\n' +
            'O serviço está lento agora. Tente novamente em instantes.';
    }
    if (msg.includes('credit') || msg.includes('saldo') || msg.includes('402')) {
        return '💳 *Sem saldo na OpenRouter.*\n\n' +
            'Adicione créditos em openrouter.ai/credits para continuar usando.';
    }
    return `⚠️ ${contexto}: ${error?.message || 'erro desconhecido'}`;
}

// Preferência de busca por chat. Ausente na chave = ligado por padrão.
const waiters = new Map();

// 📋 Menu principal, montado conforme o papel
function menu(chatId) {
    const papel = acesso.papelDe(chatId);
    const nome = acesso.nomeDoPapel(papel);
    const linha = '━━━━━━━━━━━━━━━━━━';

    const base = [
        `🤖 *Bob AI X* — modo *${nome}*`,
        linha,
        '',
        '📝 *Texto* — pergunte qualquer coisa',
        '📸 *Foto* — analise uma imagem',
        '📄 *Arquivo* — PDF, Word, Excel, CSV, JSON, EPUB, TXT',
        '   basta enviar o arquivo, eu detecto o tipo',
        '🌐 *Busca web* — 🔔 ligada por padrão',
        linha,
        '/start — este menu',
        '/busca — ligar ou desligar a busca',
        '/uso — seu modo e limites',
    ];

    if (acesso.ehAdmin(chatId)) {
        base.push(
            linha,
            '🔐 *Administração*',
            '/painel — informações do bot',
            '/usuarios — lista de acessos',
            '/senha <senha> — libera comandos sensíveis'
        );
    }

    return base.join('\n');
}

// 💬 1. RESPONDER TEXTOS
bot.on('message', async (msg) => {
    if (msg.photo || msg.document || !msg.text) return;

    const chatId = msg.chat.id;
    const text = msg.text;
    const papel = acesso.papelDe(chatId);
    const limites = acesso.limitesDoPapel(papel);

    // Registra o acesso (sem contar a mensagem se for comando)
    const ehComando = text.startsWith('/');
    acesso.registrarAcesso({
        chatId,
        nome: msg.from?.first_name,
        username: msg.from?.username,
        mensagem: !ehComando,
    });

    // Comandos de administração
    if (text.startsWith('/painel') || text.startsWith('/usuarios') || text.startsWith('/senha')) {
        if (!acesso.ehAdmin(chatId)) {
            await enviarMensagemLonga(chatId, '⛔ Comando restrito.');
            return;
        }
        if (text.startsWith('/painel')) {
            const uptime = Math.round(process.uptime() / 60);
            const e = acesso.estatisticas();
            await enviarMensagemLonga(chatId, [
                '🔧 *Painel do Bob*',
                '',
                `⏱ No ar há ${uptime} min`,
                `🧠 Memória: ${Math.round(process.memoryUsage().heapUsed / 1048576)} MB`,
                `🔑 Chave OpenRouter: ${apiKey ? '✅ ativa' : '❌ ausente'}`,
                '',
                '*Acessos*',
                `👥 Total: ${e.total}`,
                `🟢 Ativos 24h: ${e.ativos24h}`,
                `📅 Ativos 7d: ${e.ativos7d}`,
                `💬 Mensagens: ${e.mensagens}`,
                `👑 Master: ${e.masters} | Admins: ${e.admins} | Users: ${e.users}`,
            ].join('\n'));
            return;
        }
        if (text.startsWith('/usuarios')) {
            const lista = acesso.listarAcessos(15);
            if (lista.length === 0) {
                await enviarMensagemLonga(chatId, '📭 Nenhum acesso registrado ainda.');
                return;
            }
            const linhas = lista.map((u, i) => {
                const quando = new Date(u.ultimaVez).toLocaleString('pt-BR', {
                    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                });
                const icone = u.papel === 'master' ? '👑' : u.papel === 'admin' ? '🛡' : '👤';
                const nome = u.nome || u.username || u.id;
                return `${i + 1}. ${icone} ${nome}\n   ${u.papel} · ${u.mensagens} msg\n   ${quando}`;
            });
            await enviarMensagemLonga(chatId, [
                `👥 *Acessos registrados* (${lista.length})`,
                '',
                ...linhas,
            ].join('\n'));
            return;
        }
        // /senha <senha>
        const senha = text.split(/\s+/)[1] || '';
        if (acesso.senhaCorreta(senha)) {
            await enviarMensagemLonga(chatId, '🔓 Senha confirmada.');
        } else {
            await enviarMensagemLonga(chatId, '🔒 Senha incorreta.');
        }
        return;
    }

    // /uso — consumo do usuário
    if (text === '/uso') {
        await enviarMensagemLonga(chatId, [
            '📊 *Seu uso*',
            `Papel: ${nomeDoPapelSeguro(papel)}`,
            `Limite por mensagem: ${limites.maxCaracteres} caracteres`,
            'Busca na web: 🔔 ligada (o modelo decide quando usar)',
            'Documentos: PDF, Word, Excel, PowerPoint, CSV, JSON, EPUB, TXT, código',
        ].join('\n'));
        return;
    }

    // /busca on|off — liga/desliga a busca na web
    if (text === '/busca' || text.startsWith('/busca ')) {
        const partes = text.split(/\s+/);
        const acao = (partes[1] || '').toLowerCase();

        if (acao === 'on' || acao === 'ligar') {
            waiters.set(chatId, true);
            await enviarMensagemLonga(chatId, '🔔 Busca na web *ligada*.');
        } else if (acao === 'off' || acao === 'desligar') {
            waiters.set(chatId, false);
            await enviarMensagemLonga(chatId, '🔕 Busca na web *desligada*.');
        } else {
            const estado = waiters.has(chatId)
                ? (waiters.get(chatId) ? '🔔 ligada' : '🔕 desligada')
                : '🔔 ligada por padrão';
            await enviarMensagemLonga(chatId, [
                '🌐 *Busca na web*',
                `Estado: ${estado}`,
                '',
                'Com a busca ligada, eu consulto a internet quando a pergunta',
                'precisa de informação atual, e cito as fontes.',
                '',
                '/busca on — liga',
                '/busca off — desliga',
            ].join('\n'));
        }
        return;
    }

    if (text === '/start') {
        const nome = msg.from?.first_name ? `, ${msg.from.first_name}` : '';
        await enviarMensagemLonga(chatId, [
            `👋 Olá${nome}! Eu sou o *Bob AI X*.`,
            '',
            `Você está no modo *${acesso.nomeDoPapel(papel)}*.`,
            '',
            'Envie texto, foto ou PDF que eu analiso.',
            '',
            menu(chatId),
        ].join('\n'));
        return;
    }

    // Respeita o limite do papel
    if (!limites.semLimite && text.length > limites.maxCaracteres) {
        await enviarMensagemLonga(chatId, `⚠️ Modo simples aceita até ${limites.maxCaracteres} caracteres por mensagem.`);
        return;
    }

    try {
        bot.sendChatAction(chatId, 'typing');

        // 1) Tenta um agente especializado (Professor, Programador...)
        //    O orquestrador decide sozinho; se nenhum servir, ele
        //    devolve status "ia" e caímos no passo 2.
        const comAgente = await ponte.consultarAgentes({
            texto: text,
            userId: chatId,
        });

        if (comAgente.usouAgente) {
            await enviarMensagemLonga(chatId, comAgente.resposta);
            return;
        }

        // 2) Nenhum agente serviu → IA direta, com busca web
        const messages = [
            { role: 'system', content: 'Você é o Bob AI X, um assistente virtual inteligente e útil criado para ajudar o Lindinaldo. Você tem busca na web disponível: use quando precisar de informação atual e cite as fontes. Responda sempre em português do Brasil.' },
            { role: 'user', content: text }
        ];
        const resposta = await chamarOpenRouter(messages, false, {
            buscarWeb: waiters.has(chatId) ? waiters.get(chatId) : true,
        });
        await enviarMensagemLonga(chatId, resposta);
    } catch (error) {
        console.error('❌ Erro no texto:', error.message);
        await enviarMensagemLonga(chatId, explicarErro(error, 'Erro na IA'));
    }
});

function nomeDoPapelSeguro(papel) {
    return acesso.nomeDoPapel(papel);
}


// 📸 2. ANALISAR FOTOS
bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    acesso.registrarAcesso({
        chatId,
        nome: msg.from?.first_name,
        username: msg.from?.username,
        mensagem: true,
    });

    // Analisa na hora. Antes o bot guardava o file_id e perguntava
    // "o que deseja fazer?", o que jogava fora a imagem: a resposta
    // seguinte chegava só como texto e o orquestrador não tinha o
    // arquivo — daí o "não há uma imagem anexada".
    const caption = msg.caption || `Analise esta imagem automaticamente. Sem esperar pergunta, entregue:
1) o que aparece na imagem
2) todo texto visível, transcrito
3) os detalhes importantes, números, nomes e datas
4) o que a imagem significa ou sugere

Não pergunte o que fazer. Entregue a análise.`;

    try {
        await enviarMensagemLonga(chatId, '👀 *Analisando a foto...*');
        bot.sendChatAction(chatId, 'typing');

        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);

        const imgRes = await fetch(fileLink);
        const arrayBuffer = await imgRes.arrayBuffer();
        const base64String = Buffer.from(arrayBuffer).toString('base64');
        // Telegram sempre entrega JPEG em msg.photo, mesmo que o
        // original fosse PNG — usar o mime errado faz o modelo recusar.
        const dataUrl = `data:image/jpeg;base64,${base64String}`;

        const messages = [
            {
                role: 'system',
                content:
                    'Você é o Bob AI X e tem visão. Responda SEMPRE em português do Brasil. ' +
                    'Descreva o que realmente vê, sem inventar. Quando o usuário não disser ' +
                    'o que quer, você decide sozinho e entrega a análise completa.'
            },
            {
                role: 'user',
                content: [
                    { type: 'text', text: caption },
                    { type: 'image_url', image_url: { url: dataUrl } }
                ]
            }
        ];

        bot.sendChatAction(chatId, 'typing');
        const resposta = await chamarOpenRouter(messages, true, {
            buscarWeb: waiters.has(chatId) ? waiters.get(chatId) : true,
        });
        await enviarMensagemLonga(chatId, resposta);

    } catch (error) {
        console.error('❌ Erro na foto:', error.message);
        await enviarMensagemLonga(chatId, explicarErro(error, 'Erro na análise da foto'));
    }
});

// 📄 3. ANALISAR DOCUMENTOS (PDF, Office, texto, CSV, JSON, EPUB, HTML)
// Auto-detecta o tipo: basta mandar o arquivo, sem comando.
bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    acesso.registrarAcesso({
        chatId,
        nome: msg.from?.first_name,
        username: msg.from?.username,
        mensagem: true,
    });

    const doc = msg.document;
    const fileName = doc.file_name || 'arquivo';
    const caption = msg.caption || null;
    const papel = acesso.papelDe(chatId);
    const limites = acesso.limitesDoPapel(papel);

    try {
        await enviarMensagemLonga(chatId, `📄 *Analisando ${fileName}...*`);
        bot.sendChatAction(chatId, 'typing');

        const fileLink = await bot.getFileLink(doc.file_id);
        const fileRes = await fetch(fileLink);
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // Segurança: o Telegram limita a 20 MB, mas o modelo tem
        // janela finita. Corta por PDF para não estourar memória.
        let resultado = extrairDoc.extrair(buffer, fileName, doc.mime_type);

        // Se o arquivo é uma imagem disfarçada de documento, manda pra visão
        if (/\.(png|jpe?g|webp|gif|bmp)$/i.test(fileName)) {
            const dataUrl = `data:${doc.mime_type || 'image/jpeg'};base64,${buffer.toString('base64')}`;
            const resposta = await chamarOpenRouter([
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: caption || 'Descreva esta imagem em detalhes e extraia qualquer texto visível.',
                        },
                        { type: 'image_url', image_url: { url: dataUrl } },
                    ],
                },
            ], true);
            await enviarMensagemLonga(chatId, resposta);
            return;
        }

        // Documento sem texto extraível (PDF escaneado, formato legado)
        if (!resultado.texto && resultado.aviso) {
            await enviarMensagemLonga(chatId, `⚠️ ${resultado.aviso}`);
            return;
        }

        if (!resultado.texto || !resultado.texto.trim()) {
            await enviarMensagemLonga(
                chatId,
                `⚠️ O arquivo *${fileName}* não tem texto extraível. Se for documento escaneado, envie uma foto dele.`
            );
            return;
        }

        const original = resultado.texto.length;
        const cortado = extrairDoc.aplicarLimite(resultado.texto, limites.maxCaracteres);
        resultado.texto = cortado.texto;

        // NENHUMA pergunta: se não veio legenda, o bot decide sozinho o
        // que fazer. Só usa o texto da legenda quando o usuário mandou.
        const instrucao = caption
            ? caption
            : `Analise este documento automaticamente. Sem esperar pergunta, entregue:
1) o que é o documento (tipo e finalidade)
2) resumo objetivo do conteúdo
3) os dados e números mais importantes, em lista
4) pontos de atenção ou riscos
5) sua conclusão em 2 ou 3 frases

Não pergunte o que fazer. Entregue a análise.`;

        const messages = [
            {
                role: 'system',
                content:
                    'Você é o Bob AI X, especialista em analisar documentos. ' +
                    'Responda SEMPRE em português do Brasil. Seja organizado e direto. ' +
                    'Quando o usuário não disser o que quer, você decide sozinho o que ' +
                    'analisar e entrega o resultado completo — nunca pergunta "o que devo fazer?". ' +
                    'Use a busca na web se precisar contextualizar dados ou verificar fatos externos.'
            },
            {
                role: 'user',
                content:
                    `${instrucao}\n\n` +
                    `--- ARQUIVO: ${fileName} (${resultado.tipo}) ---\n` +
                    `${resultado.texto}\n` +
                    `--- FIM DO ARQUIVO ---\n` +
                    (cortado.cortado ? `\n(Conteúdo original: ${original} caracteres, enviado um trecho.)` : '')
            }
        ];

        await bot.sendChatAction(chatId, 'typing');
        const resposta = await chamarOpenRouter(messages, false, {
            buscarWeb: waiters.has(chatId) ? waiters.get(chatId) : true,
        });
        await enviarMensagemLonga(chatId, resposta);

    } catch (error) {
        console.error('❌ Erro no documento:', error.message);
        await enviarMensagemLonga(chatId, explicarErro(error, 'Erro no documento'));
    }
});

// Registra os comandos para aparecerem no menu do Telegram
bot.setMyCommands([
    { command: 'start', description: 'Abrir o menu' },
    { command: 'busca', description: 'Ligar ou desligar a busca na web' },
    { command: 'uso', description: 'Ver seu modo de acesso' },
    { command: 'painel', description: 'Painel do bot (admin)' },
    { command: 'usuarios', description: 'Lista de acessos (admin)' },
    { command: 'senha', description: 'Confirmar senha (admin)' },
]);

bot.on('polling_error', (error) => {
    if (!error.message.includes('409 Conflict')) {
        console.error('❌ Erro no polling:', error.message);
    }
});

module.exports = bot;
