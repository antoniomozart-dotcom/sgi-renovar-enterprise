import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.COPILOT_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";
const INTERVALO = Number(process.env.COPILOT_WORKER_INTERVAL_MS || 60000);
const MAX_ITENS = Number(process.env.COPILOT_WORKER_MAX_ITENS || 5);

let rodando = false;

function esperar(ms){ return new Promise(r => setTimeout(r, ms)); }

function limite(texto, max=9000){
  texto = String(texto || "");
  return texto.length > max ? texto.slice(0, max) : texto;
}

function safeJsonParse(texto){
  try{
    const cleaned = String(texto || "")
      .replace(/^```json/i,"")
      .replace(/^```/i,"")
      .replace(/```$/i,"")
      .trim();
    return JSON.parse(cleaned);
  }catch(e){
    return null;
  }
}

async function selectSafe(table, cols, empresaId=null, limit=50, orderCol=null){
  try{
    let q = supabase.from(table).select(cols).limit(limit);
    if(empresaId) q = q.eq("empresa_id", empresaId);
    if(orderCol) q = q.order(orderCol,{ascending:false});
    const {data,error} = await q;
    if(error){
      console.log(`Aviso ${table}:`, error.message);
      return [];
    }
    return data || [];
  }catch(e){
    console.log(`Aviso ${table}:`, e.message);
    return [];
  }
}

async function coletarContexto(empresaId){
  const [
    scores,
    documentos,
    inconsistencias,
    eventos,
    pareceres,
    openai,
    alertas,
    tarefas
  ] = await Promise.all([
    selectSafe("vw_compliance_score_atual","*",empresaId,20,"updated_at"),
    selectSafe("documentos_sst","*",empresaId,80,"created_at"),
    selectSafe("ged_inconsistencias_documentais","*",empresaId,80,"created_at"),
    selectSafe("eventos_esocial","*",empresaId,80,"created_at"),
    selectSafe("ged_pareceres_ia_sst","*",empresaId,30,"created_at"),
    selectSafe("ged_pareceres_openai_sst","*",empresaId,30,"created_at"),
    selectSafe("alertas_sgi","*",empresaId,50,"created_at"),
    selectSafe("vw_automacao_tarefas_resumo","*",empresaId,50,"created_at")
  ]);

  return {scores,documentos,inconsistencias,eventos,pareceres,openai,alertas,tarefas};
}

function gerarRespostaFallback(pergunta, contexto, modo){
  const score = contexto.scores?.[0] || {};
  const docsVencidos = contexto.documentos.filter(d => {
    if(d.status === "vencido") return true;
    if(!d.data_validade) return false;
    return new Date(d.data_validade) < new Date();
  }).length;

  const eventosErro = contexto.eventos.filter(e => ["erro","rejeitado","recusado"].includes(String(e.status||"").toLowerCase())).length;
  const inconsistencias = contexto.inconsistencias.filter(i => String(i.status||"") !== "resolvida").length;
  const alertas = contexto.alertas.filter(a => String(a.status||"") !== "resolvido").length;

  let resposta = `Análise do Copilot SGI Renovar (${modo}).\n\n`;

  resposta += `Compliance atual: ${Math.round(Number(score.score_compliance || 0))}%.\n`;
  resposta += `Risco geral: ${score.risco_geral || "não definido"}.\n`;
  resposta += `Documentos vencidos: ${docsVencidos}.\n`;
  resposta += `Eventos eSocial com erro/rejeição: ${eventosErro}.\n`;
  resposta += `Inconsistências OCR/GED abertas: ${inconsistencias}.\n`;
  resposta += `Alertas pendentes: ${alertas}.\n\n`;

  if(docsVencidos > 0) resposta += `Prioridade: regularizar documentos vencidos e atualizar evidências no GED.\n`;
  if(eventosErro > 0) resposta += `Prioridade: revisar eventos eSocial rejeitados/recusados.\n`;
  if(inconsistencias > 0) resposta += `Prioridade: tratar inconsistências documentais apontadas pela IA.\n`;
  if(alertas > 0) resposta += `Prioridade: concluir alertas e tarefas pendentes.\n`;

  resposta += `\nPergunta recebida: ${pergunta}\n\n`;
  resposta += `Observação: resposta gerada em modo fallback. Ao configurar OPENAI_API_KEY, o Copilot usará IA generativa contextual.`;

  return {
    resposta,
    resumo_contexto:`Score ${Math.round(Number(score.score_compliance || 0))}%, ${docsVencidos} documentos vencidos, ${eventosErro} eventos eSocial com erro, ${inconsistencias} inconsistências OCR.`,
    fontes:[
      {tipo:"score", total:contexto.scores.length},
      {tipo:"documentos", total:contexto.documentos.length},
      {tipo:"eventos_esocial", total:contexto.eventos.length},
      {tipo:"inconsistencias", total:contexto.inconsistencias.length}
    ],
    insights:[
      {titulo:"Compliance", valor:Math.round(Number(score.score_compliance || 0))},
      {titulo:"Documentos vencidos", valor:docsVencidos},
      {titulo:"eSocial erro", valor:eventosErro},
      {titulo:"OCR inconsistências", valor:inconsistencias}
    ],
    acoes_sugeridas:[
      {prioridade:"alta", acao:"Revisar pendências críticas", modulo:"Compliance"},
      {prioridade:"media", acao:"Atualizar evidências documentais", modulo:"GED"}
    ]
  };
}

function montarPrompt(pergunta, contexto, modo){
  return `
Você é o SGI Renovar Copilot IA, um auditor virtual enterprise de SST, eSocial, PPP, GED, OCR, NR-01 psicossocial, jurídico trabalhista e previdenciário.

MODO DE RESPOSTA: ${modo}

PERGUNTA DO USUÁRIO:
${pergunta}

CONTEXTO DO SGI:
${limite(JSON.stringify(contexto, null, 2), 18000)}

Responda SOMENTE em JSON válido:
{
  "resposta": "texto completo em português do Brasil",
  "resumo_contexto": "síntese curta dos dados usados",
  "fontes": [],
  "insights": [],
  "acoes_sugeridas": []
}

Regras:
- Seja objetivo, técnico e executivo.
- Não invente dados ausentes.
- Quando um dado não existir, diga que não foi encontrado no SGI.
- Se a pergunta envolver NR-01 psicossocial, considere burnout, assédio, sobrecarga, fadiga, liderança, organização do trabalho e plano de ação.
- Se envolver eSocial, destaque S-2210, S-2220 e S-2240 quando aplicável.
- Se envolver documentos, destaque PGR, PCMSO, LTCAT, PPP, ASO e CAT.
- Se envolver risco jurídico/previdenciário, explique criticidade e ação recomendada.
`;
}

async function chamarOpenAI(pergunta, contexto, modo){
  if(!OPENAI_API_KEY){
    return gerarRespostaFallback(pergunta, contexto, modo);
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{
      "Authorization":`Bearer ${OPENAI_API_KEY}`,
      "Content-Type":"application/json"
    },
    body:JSON.stringify({
      model:OPENAI_MODEL,
      temperature:0.2,
      messages:[
        {role:"system", content:"Você é um copiloto enterprise de SST. Responda somente JSON válido."},
        {role:"user", content:montarPrompt(pergunta, contexto, modo)}
      ]
    })
  });

  if(!resp.ok){
    throw new Error(`Erro OpenAI: ${await resp.text()}`);
  }

  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content || "";
  const parsed = safeJsonParse(content);

  if(!parsed){
    throw new Error("OpenAI retornou conteúdo não JSON.");
  }

  parsed._tokens_estimados = json.usage?.total_tokens || null;

  return parsed;
}

async function buscarFila(){
  const {data,error} = await supabase
    .from("copilot_fila")
    .select("*")
    .eq("status","fila")
    .order("created_at",{ascending:true})
    .limit(MAX_ITENS);

  if(error) throw error;

  return data || [];
}

async function processar(item){
  await supabase.from("copilot_fila").update({
    status:"processando",
    started_at:new Date().toISOString(),
    tentativas:(item.tentativas || 0) + 1,
    updated_at:new Date().toISOString()
  }).eq("id",item.id);

  try{
    const contexto = await coletarContexto(item.empresa_id);
    const analise = await chamarOpenAI(item.pergunta, contexto, item.modo || "executivo");

    const {data:msgAssistente,error:msgErro} = await supabase
      .from("copilot_mensagens")
      .insert([{
        conversa_id:item.conversa_id,
        empresa_id:item.empresa_id,
        papel:"assistant",
        conteudo:analise.resposta,
        contexto:{
          resumo_contexto:analise.resumo_contexto,
          fontes:analise.fontes,
          insights:analise.insights,
          acoes_sugeridas:analise.acoes_sugeridas
        },
        tokens_estimados:analise._tokens_estimados || null
      }])
      .select()
      .single();

    if(msgErro) throw msgErro;

    await supabase.from("copilot_respostas").insert([{
      conversa_id:item.conversa_id,
      mensagem_id:msgAssistente.id,
      empresa_id:item.empresa_id,
      pergunta:item.pergunta,
      resposta:analise.resposta,
      resumo_contexto:analise.resumo_contexto,
      fontes:analise.fontes || [],
      insights:analise.insights || [],
      acoes_sugeridas:analise.acoes_sugeridas || [],
      modo:item.modo,
      modelo_ia:OPENAI_API_KEY ? OPENAI_MODEL : "fallback-sgi-sem-openai",
      payload:{contexto,analise},
      status:"gerado"
    }]);

    await supabase.from("copilot_fila").update({
      status:"concluido",
      finished_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    }).eq("id",item.id);

    await supabase.from("copilot_conversas").update({
      updated_at:new Date().toISOString()
    }).eq("id",item.conversa_id);

    console.log(`Copilot respondeu: ${item.pergunta}`);

  }catch(err){
    await supabase.from("copilot_fila").update({
      status:"erro",
      erro_mensagem:err.message,
      finished_at:new Date().toISOString(),
      updated_at:new Date().toISOString()
    }).eq("id",item.id);

    console.error("Erro Copilot:",err.message);
  }
}

async function ciclo(){
  if(rodando) return;
  rodando = true;

  try{
    const fila = await buscarFila();

    if(!fila.length){
      console.log(`[${new Date().toLocaleString("pt-BR")}] Nenhuma pergunta na fila do Copilot.`);
    }

    for(const item of fila){
      await processar(item);
    }

  }catch(err){
    console.error("Erro no ciclo Copilot:",err);
  }finally{
    rodando = false;
  }
}

async function main(){
  console.log("SGI Renovar Copilot IA Worker iniciado.");
  console.log(`Intervalo: ${INTERVALO}ms | Modelo: ${OPENAI_API_KEY ? OPENAI_MODEL : "fallback sem OPENAI_API_KEY"}`);

  await ciclo();

  while(true){
    await esperar(INTERVALO);
    await ciclo();
  }
}

main().catch(err=>{
  console.error("Erro fatal:",err);
  process.exit(1);
});
