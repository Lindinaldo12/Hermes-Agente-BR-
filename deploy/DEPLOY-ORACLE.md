#!/usr/bin/env bash
# ==========================================
# Guia de deploy do Bob AI X no Oracle Cloud
# ==========================================
#
# Executar NA MÁQUINA VIRTUAL (Ubuntu), não no celular.
#
# O plano Always Free da Oracle dá 2 VMs ARM Ampere A1 (até 4 vCPU e
# 24 GB RAM cada, no total). Isso roda o Bob com folga.
#
# ─────────────────────────────────────────
# PASSO 1 — preparar o servidor
# ─────────────────────────────────────────
#
#   sudo apt update && sudo apt upgrade -y
#   sudo apt install -y git curl
#   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
#   sudo apt install -y nodejs
#   node -v    # deve mostrar v22 ou maior
#
# ─────────────────────────────────────────
# PASSO 2 —-keys SSH
# ─────────────────────────────────────────
#
# No painel da Oracle, abra a VM e use "Console Connection".
# NUNCA envie senha nem chave privada para o chat.
#
# ─────────────────────────────────────────
# PASSO 3 — trazer o código
# ─────────────────────────────────────────
#
#   cd /home/ubuntu
#   git clone https://github.com/Lindinaldo12/Bobmeuagente.git bob
#   cd bob
#   npm install --omit=dev
#
# ─────────────────────────────────────────
# PASSO 4 — configurar as variáveis
# ─────────────────────────────────────────
#
#   nano .env
#
# O .env NUNCA vai para o git. Preencha:
#
#   TELEGRAM_BOT_TOKEN=token do @BotFather
#   MASTER_ID=8133082447
#   ACCESS_PASSWORD=uma senha forte
#   OPENROUTER_API_KEY=a chave da openrouter.ai/keys
#   ADMIN_IDS=
#   PORT=3000
#
# ─────────────────────────────────────────
# PASSO 5 — rodar como serviço (não morre ao fechar o terminal)
# ─────────────────────────────────────────
#
#   sudo cp deploy/bob.service /etc/systemd/system/
#   sudo systemctl daemon-reload
#   sudo systemctl enable bob
#   sudo systemctl start bob
#
# ─────────────────────────────────────────
# PASSO 6 — ver se está funcionando
# ─────────────────────────────────────────
#
#   sudo systemctl status bob      # deve mostrar "active (running)"
#   sudo journalctl -u bob -f      # log em tempo real
#
# Saída saudável:
#   ⚡ Conectado à OpenRouter com sucesso!
#   🔐 Acesso: master=8133082447 | admins=0 | senha=sim
#   ✅ Servidor Web iniciado na porta 3000
#
# ─────────────────────────────────────────
# PASSO 7 — manter o serviço vivo
# ─────────────────────────────────────────
#
#   sudo apt install -y unattended-upgrades
#   sudo dpkg-reconfigure --priority=low unattended-upgrades
#
# ─────────────────────────────────────────
# SEGREDOS QUE FICAM SÓ NO SERVIDOR
# ─────────────────────────────────────────
#
#   .env                      variáveis com chave e senha
#   memoria/acessos.json      registro de acessos dos usuários
#
# O .gitignore já protege ambos. Confira antes de commitar:
#   git check-ignore .env memoria/acessos.json
#
# Se aparecerem listados, o .gitignore foi alterado.
#
# ─────────────────────────────────────────
# DOMÍNIO (opcional)
# ─────────────────────────────────────────
#
# A VM pode ser acessada pelo IP público:
#   http://SEU_IP:3000
#
# Para um domínio próprio, o caminho mais direto na Oracle é:
#   1. Registered Domain (comprar o domínio)
#   2. Criar um "Domain Redirect Service" para o IP da VM
#
# A OCI também tem "API Gateway" e "Load Balancer" para HTTPS,
# mas ambos cobram. Para o Bob (só Telegram) não é necessário —
# o bot não recebe tráfego da web, só fala com a API do Telegram.
#
# ─────────────────────────────────────────
# RESOLVER PROBLEMAS
# ─────────────────────────────────────────
#
# "O app não sobe":
#   sudo journalctl -u bob -n 50 --no-pager
#
# Erro de chave da API:
#   o token do Telegram foi revogado. Fale com @BotFather, gere outro
#   e atualize TELEGRAM_BOT_TOKEN no .env, depois:
#     sudo systemctl restart bob
#
# "Address already in use":
#   a porta 3000 já está ocupada. Mude PORT no .env para 8080.
#
# Esqueceu a senha de ubuntu:
#   use "Reset Password" na VM no console do painel da Oracle.

set -e

if [ "$1" = "--check" ]; then
    echo "=== Verificação do ambiente ==="
    node -v 2>/dev/null || echo "✗ Node.js não instalado"
    git --version >/dev/null 2>&1 && echo "✓ git ok" || echo "✗ git ausente"
    [ -f .env ] && echo "✓ .env existe" || echo "✗ .env ausente"
    [ -f package.json ] && echo "✓ package.json existe" || echo "✗ fora do diretório do projeto"
    [ -d node_modules ] && echo "✓ dependências instaladas" || echo "✗ rode: npm install --omit=dev"
    exit 0
fi

echo "Este script é documentação. Veja os passos acima."
