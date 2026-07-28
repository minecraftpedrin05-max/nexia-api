const express = require("express");
const cors = require("cors");
const {
  DAILY_LIMIT_MS,
  generateKey,
  getKeyRecord,
  remainingMs,
  registerUsage,
  listKeys,
  revokeKey,
} = require("./keys");

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || "troque-esse-segredo";
const MODEL_ID = "HuggingFaceTB/SmolLM2-135M-Instruct";

// Mesma técnica do app: exemplos fixos pra calibrar o "jeito de falar" do modelo pequeno.
const FEW_SHOT_EXAMPLES = [
  { role: "user", content: "Oi, tudo bem?" },
  { role: "assistant", content: "Fala! Tudo certo por aqui, e você? Se precisar de alguma coisa é só falar." },
  { role: "user", content: "Qual a capital do Brasil?" },
  { role: "assistant", content: "A capital do Brasil é Brasília." },
];

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Carrega o modelo uma vez, no boot ----------
let generatorPromise = null;
function getGenerator() {
  if (!generatorPromise) {
    generatorPromise = import("@huggingface/transformers").then((lib) =>
      lib.pipeline("text-generation", MODEL_ID, { dtype: "q4" })
    );
  }
  return generatorPromise;
}
getGenerator()
  .then(() => console.log("[nexia-api] modelo carregado, pronto pra receber pedidos"))
  .catch((e) => console.error("[nexia-api] falha ao carregar modelo:", e));

// ---------- Middlewares ----------
function requireApiKey(req, res, next) {
  const key = req.header("x-api-key") || (req.header("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!key) return res.status(401).json({ error: { type: "authentication_error", message: "Faltou a x-api-key." } });
  const rec = getKeyRecord(key);
  if (!rec) return res.status(401).json({ error: { type: "authentication_error", message: "Chave de API inválida." } });
  req.apiKey = key;
  req.keyRecord = rec;
  next();
}

function requireAdmin(req, res, next) {
  const secret = req.header("x-admin-secret");
  if (secret !== ADMIN_SECRET) return res.status(401).json({ error: { type: "authentication_error", message: "Admin secret inválido." } });
  next();
}

// ---------- Rota pública: qualquer um pode gerar SUA PRÓPRIA chave (sem senha) ----------
// Protegido só por um limite de chaves por IP/dia, pra não virar fábrica de chaves.
const selfServeByIp = new Map(); // ip -> { day, count }
const SELF_SERVE_DAILY_LIMIT = 3;

app.post("/v1/keys/self", (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  const today = new Date().toISOString().slice(0, 10);
  const entry = selfServeByIp.get(ip);
  if (!entry || entry.day !== today) {
    selfServeByIp.set(ip, { day: today, count: 1 });
  } else {
    if (entry.count >= SELF_SERVE_DAILY_LIMIT) {
      return res.status(429).json({ error: { type: "rate_limit_error", message: "Limite de chaves novas por hoje atingido. Tenta amanhã." } });
    }
    entry.count += 1;
  }
  const key = generateKey(req.body?.label || "app nexia");
  res.json({ key, daily_limit_hours: DAILY_LIMIT_MS / 3600000 });
});

// ---------- Rotas de administração de chaves ----------
app.post("/v1/keys", requireAdmin, (req, res) => {
  const key = generateKey(req.body?.label);
  res.json({ key, daily_limit_hours: DAILY_LIMIT_MS / 3600000 });
});

app.get("/v1/keys", requireAdmin, (req, res) => {
  res.json({ keys: listKeys() });
});

app.delete("/v1/keys/:key", requireAdmin, (req, res) => {
  const ok = revokeKey(req.params.key);
  res.json({ revoked: ok });
});

// ---------- Rota principal, estilo Anthropic /v1/messages ----------
app.post("/v1/messages", requireApiKey, async (req, res) => {
  const remaining = remainingMs(req.apiKey);
  if (remaining <= 0) {
    return res.status(429).json({
      error: {
        type: "rate_limit_error",
        message: "Essa chave já usou as 5 horas de geração de hoje. Volta amanhã ou usa outra chave.",
      },
    });
  }

  const { messages, max_tokens, temperature, system } = req.body || {};
  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: { type: "invalid_request_error", message: "Manda 'messages' como array [{role, content}]." } });
  }

  try {
    const generator = await getGenerator();
    const chatMessages = [
      ...(system ? [{ role: "system", content: system }] : []),
      ...FEW_SHOT_EXAMPLES,
      ...messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })),
    ];

    const start = Date.now();
    const output = await generator(chatMessages, {
      max_new_tokens: Math.min(Math.max(Number(max_tokens) || 300, 1), 600),
      temperature: temperature ?? 0.3,
      top_p: 0.85,
      do_sample: true,
      repetition_penalty: 1.1,
    });
    const elapsedMs = Date.now() - start;
    registerUsage(req.apiKey, elapsedMs);

    const lastTurn = output?.[0]?.generated_text?.at?.(-1);
    const text = (lastTurn?.content || "").trim();

    res.json({
      id: "msg_" + Math.random().toString(36).slice(2, 12),
      role: "assistant",
      model: MODEL_ID,
      content: [{ type: "text", text }],
      usage: {
        generation_ms: elapsedMs,
        remaining_ms_today: remainingMs(req.apiKey),
        daily_limit_hours: DAILY_LIMIT_MS / 3600000,
      },
    });
  } catch (err) {
    console.error("[nexia-api] erro gerando resposta:", err);
    res.status(500).json({ error: { type: "server_error", message: "Deu erro rodando o modelo. Tenta de novo." } });
  }
});

// ---------- Health check ----------
app.get("/", (req, res) => res.json({ ok: true, service: "nexia-api", model: MODEL_ID }));

// ---------- Painel de admin (gerar/ver/revogar chaves pelo navegador) ----------
app.get("/admin", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="pt-br"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nexia API - Admin</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0a0a0a;color:#eee;margin:0;padding:20px;max-width:560px;margin:0 auto}
  h1{font-size:20px} label{display:block;margin:14px 0 4px;font-size:13px;color:#aaa}
  input,button{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #333;background:#161616;color:#eee;font-size:15px}
  button{background:#eee;color:#111;font-weight:600;margin-top:10px;cursor:pointer}
  .card{background:#141414;border:1px solid #262626;border-radius:10px;padding:12px;margin-top:10px;word-break:break-all;font-size:13px}
  .row{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .del{width:auto;background:#3a1414;color:#f88;padding:8px 12px;margin:0;flex:none}
  #keys{margin-top:20px}
</style></head>
<body>
  <h1>Nexia API — Admin</h1>
  <label>Admin secret</label>
  <input id="secret" type="password" placeholder="sua ADMIN_SECRET" />
  <label>Nome/etiqueta da nova chave (opcional)</label>
  <input id="label" placeholder="ex: app do pedrin" />
  <button onclick="criar()">Gerar nova chave</button>
  <button onclick="listar()" style="background:#222;color:#eee;border:1px solid #333">Atualizar lista</button>
  <div id="keys"></div>
  <div id="newkey"></div>
<script>
function h(){ return { "x-admin-secret": document.getElementById('secret').value, "Content-Type": "application/json" }; }
async function copiar(txt, btn){
  try { await navigator.clipboard.writeText(txt); btn.textContent = "Copiado!"; }
  catch(e){ btn.textContent = "Seleciona e copia manual"; }
  setTimeout(()=> btn.textContent = "Copiar", 1800);
}
async function criar(){
  const label = document.getElementById('label').value;
  const r = await fetch('/v1/keys', { method:'POST', headers:h(), body: JSON.stringify({label}) });
  const d = await r.json();
  if(!r.ok){ alert('Erro: ' + (d.error?.message||'')); return; }
  document.getElementById('newkey').innerHTML = \`
    <div class="card" style="border-color:#3a3">
      <div style="color:#8f8;margin-bottom:6px">Chave criada — copia agora:</div>
      <input readonly value="\${d.key}" onclick="this.select()" style="width:100%;background:#0a0a0a;border:1px solid #333;border-radius:6px;padding:8px;color:#eee;font-size:12px;margin-bottom:8px" />
      <button onclick="copiar('\${d.key}', this)" style="width:auto;padding:8px 14px;margin:0">Copiar</button>
    </div>\`;
  listar();
}
async function revogar(key){
  if(!confirm('Revogar essa chave?')) return;
  await fetch('/v1/keys/' + encodeURIComponent(key), { method:'DELETE', headers:h() });
  listar();
}
async function listar(){
  const r = await fetch('/v1/keys', { headers:h() });
  const d = await r.json();
  const el = document.getElementById('keys');
  if(!r.ok){ el.innerHTML = '<p style="color:#f88">Erro: ' + (d.error?.message||'confere a senha') + '</p>'; return; }
  if(!d.keys.length){ el.innerHTML = '<p style="color:#888">Nenhuma chave ainda.</p>'; return; }
  el.innerHTML = d.keys.map(k => \`
    <div class="card">
      <div class="row"><b>\${k.label || '(sem nome)'}</b><button class="del" onclick="revogar('\${k.key}')">Revogar</button></div>
      <div style="margin-top:6px">\${k.key}</div>
      <div style="color:#888;margin-top:6px">Hoje: \${(k.usedMsToday/3600000).toFixed(2)}h de 5h &nbsp;•&nbsp; Total: \${(k.totalRequests||0)} pedidos</div>
    </div>\`).join('');
}
</script>
</body></html>`);
});

app.listen(PORT, () => console.log(`[nexia-api] rodando na porta ${PORT}`));
      
