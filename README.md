# Nexia API

API de chat estilo Anthropic, rodando o modelo `SmolLM2-135M-Instruct` no servidor
(em vez de no navegador de quem usa). Cada chave de API tem um limite de **5 horas
de geração por dia** — depois disso a chave fica bloqueada até o dia seguinte
(reseta à meia-noite UTC).

## ⚠️ Sobre hospedagem

Isso **não roda no GitHub Pages** (só serve arquivo estático). Precisa de uma
hospedagem que rode Node.js de verdade e continue ligada:
- **Render.com** (tem plano free — o servidor "dorme" depois de um tempo sem uso e demora ~30s pra acordar na próxima chamada)
- **Railway.app**
- **Discloud** (já que você já usa pro VendaFlow)
- Um VPS qualquer

## Configuração

1. `npm install` (isso baixa o `@huggingface/transformers`, que já vem com o runtime de rodar o modelo).
2. Define a variável de ambiente `ADMIN_SECRET` (senha só sua, pra gerar chaves). Se não definir, usa `troque-esse-segredo` — **troca isso antes de subir pra produção**.
3. `npm start` — no primeiro request o modelo baixa (~uma vez só, fica em cache).

## Gerar uma chave de API (você, como admin)

```bash
curl -X POST https://SEU-SERVIDOR/v1/keys \
  -H "x-admin-secret: SEU_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"label": "app do pedrin"}'
```

Resposta:
```json
{ "key": "nexia-abcd1234...", "daily_limit_hours": 5 }
```

## Usar a API (quem tem a chave)

```bash
curl -X POST https://SEU-SERVIDOR/v1/messages \
  -H "x-api-key: nexia-abcd1234..." \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{ "role": "user", "content": "Oi, qual seu nome?" }],
    "max_tokens": 300
  }'
```

Resposta:
```json
{
  "id": "msg_xxxxx",
  "role": "assistant",
  "model": "HuggingFaceTB/SmolLM2-135M-Instruct",
  "content": [{ "type": "text", "text": "..." }],
  "usage": { "generation_ms": 4210, "remaining_ms_today": 17995790, "daily_limit_hours": 5 }
}
```

Se a chave já estourou as 5 horas do dia, a API responde `429` com
`error.type = "rate_limit_error"`.

## Rotas de administração

- `POST /v1/keys` — cria chave nova (`x-admin-secret` obrigatório)
- `GET /v1/keys` — lista todas as chaves e quanto cada uma já gastou (`x-admin-secret` obrigatório)
- `DELETE /v1/keys/:key` — revoga uma chave (`x-admin-secret` obrigatório)

## Sobre o limite de 5h

É por chave, reseta todo dia à meia-noite UTC, e conta o **tempo real gasto
gerando texto** (não número de mensagens) — assim uma pergunta rápida gasta
pouco e uma resposta longa gasta mais, exatamente como quantidade de "fala".
