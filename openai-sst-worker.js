import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const INTERVALO = Number(process.env.OPENAI_SST_WORKER_INTERVAL_MS || 180000);
const MAX_ITENS = Number(process.env.OPENAI_SST_WORKER_MAX_ITENS || 3);

let rodando = false;

function esperar(ms){ return new Promise(r => setTimeout(r, ms)); }
function limitarTexto(texto, max=10000){ texto=String(texto||""); return texto.length>max ? texto.slice(0,max) : texto; }

function safeJsonParse(texto){
  try{
    return JSON.parse(String(texto||"").replace(/^```json/i,"").replace(/^```/i,"").replace(/```$/i,"").trim());
  }catch(e){ return null; }
}

function fallback({parecer, ocr, doc}){
  const tipo = parecer.tipo_documento || doc?.tipo_documento || ocr?.tipo_documento_detectado || "Documento SST";
  const score = Number(parecer.score_compliance || 70);
  const criticidade = parecer.nivel_criticidade || "moderado";
  return {
    resumo_executivo:`Documento ${tipo} analisado. Score ${score}%. Criticidade ${criticidade}.`,
    parecer_humanizado:parecer.parecer_tecnico || "Parecer técnico automático do SGI Renovar.",
    analise_tecnica:"Análise técnica baseada em OCR, regras SST e motor cognitivo.",
    analise_juridica:"Há potencial risco jurídico caso as inconformidades não sejam saneadas e documentadas.",
    analise_previdenciaria:"Avaliar integração com LTCAT, PPP e eSocial quando houver exposição ocupacional.",
    analise_psicossocial:"Avaliar fatores psicossociais em documentos PGR/NR-01, como sobrecarga, assédio, burnout e organização do trabalho.",
    analise_nr01:"Verificar aderência ao GRO/PGR, inventário de riscos e plano de ação.",
    plano_acao_sugerido:parecer.recomendacoes || [],
    inconformidades_priorizadas:parecer.inconformidades || [],
    recomendacoes_diretoria:[{prioridade:"alta",acao:"Validar parecer",descricao:"Submeter análise a profissional habilitado antes de uso formal."}],
    risco_juridico_detalhado:parecer.risco_juridico || "moderado",
    risco_previdenciario_detalhado:parecer.risco_previdenciario || "baixo",
    risco_psicossocial_detalhado:parecer.risco_psicossocial || "baixo",
    risco_ocupacional_detalhado:parecer.risco_ocupacional || "moderado",
    criticidade_estrategica:criticidade,
    score_ia:score,
    linguagem_diretoria:`O documento ${tipo} requer acompanhamento gerencial para reduzir risco ocupacional e documental.`,
    linguagem_tecnica:parecer.parecer_tecnico || "",
    linguagem_juridica:"A ausência de saneamento das pendências pode ampliar risco administrativo, trabalhista ou previdenciário."
  };
}

function prompt({parecer, ocr, doc}){
  return `Você é auditor sênior de SST, eSocial, previdenciário, jurídico trabalhista e NR-01 psicossocial. Responda SOMENTE JSON válido.

TIPO: ${parecer.tipo_documento || doc?.tipo_documento || ocr?.tipo_documento_detectado || ""}
TÍTULO: ${parecer.titulo_documento || doc?.titulo || doc?.nome_arquivo || ""}

PARECER BASE:
${limitarTexto(parecer.parecer_tecnico, 3500)}

RESUMO BASE:
${limitarTexto(parecer.resumo_executivo, 1500)}

INCONFORMIDADES:
${JSON.stringify(parecer.inconformidades || [], null, 2)}

RECOMENDAÇÕES:
${JSON.stringify(parecer.recomendacoes || [], null, 2)}

OCR:
${limitarTexto(ocr?.texto_extraido || "", 7000)}

JSON obrigatório:
{
 "resumo_executivo":"",
 "parecer_humanizado":"",
 "analise_tecnica":"",
 "analise_juridica":"",
 "analise_previdenciaria":"",
 "analise_psicossocial":"",
 "analise_nr01":"",
 "plano_acao_sugerido":[],
 "inconformidades_priorizadas":[],
 "recomendacoes_diretoria":[],
 "risco_juridico_detalhado":"",
 "risco_previdenciario_detalhado":"",
 "risco_psicossocial_detalhado":"",
 "risco_ocupacional_detalhado":"",
 "criticidade_estrategica":"baixo|moderado|alto|critico",
 "score_ia":0,
 "linguagem_diretoria":"",
 "linguagem_tecnica":"",
 "linguagem_juridica":""
}`;
}

async function chamarOpenAI(payload){
  if(!OPENAI_API_KEY) return fallback(payload);

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method:"POST",
    headers:{ "Authorization":`Bearer ${OPENAI_API_KEY}`, "Content-Type":"application/json" },
    body:JSON.stringify({
      model:OPENAI_MODEL,
      temperature:0.2,
      messages:[
        {role:"system", content:"Você é auditor sênior de SST. Responda somente JSON válido."},
        {role:"user", content:prompt(payload)}
      ]
    })
  });

  if(!resp.ok) throw new Error(`Erro OpenAI: ${await resp.text()}`);

  const json = await resp.json();
  const parsed = safeJsonParse(json.choices?.[0]?.message?.content || "");
  if(!parsed) throw new Error("OpenAI retornou conteúdo não JSON.");
  parsed._tokens_estimados = json.usage?.total_tokens || null;
  return parsed;
}

async function buscarFila(){
  const { data, error } = await supabase
    .from("ged_pareceres_openai_fila")
    .select("*, ged_pareceres_ia_sst(*), ged_ocr_resultados(*), ged_documentos_enterprise(*)")
    .eq("status","fila")
    .order("created_at",{ascending:true})
    .limit(MAX_ITENS);
  if(error) throw error;
  return data || [];
}

async function processar(item){
  const parecer = item.ged_pareceres_ia_sst;
  const ocr = item.ged_ocr_resultados;
  const doc = item.ged_documentos_enterprise;
  if(!parecer) throw new Error("Parecer IA base não encontrado.");

  await supabase.from("ged_pareceres_openai_fila").update({
    status:"processando", started_at:new Date().toISOString(),
    tentativas:(item.tentativas||0)+1, updated_at:new Date().toISOString()
  }).eq("id", item.id);

  try{
    const analise = await chamarOpenAI({parecer, ocr, doc});
    const registro = {
      parecer_ia_id:parecer.id,
      documento_id:parecer.documento_id,
      resultado_ocr_id:parecer.resultado_ocr_id,
      empresa_id:parecer.empresa_id,
      tipo_documento:parecer.tipo_documento,
      titulo_documento:parecer.titulo_documento,
      resumo_executivo:analise.resumo_executivo,
      parecer_humanizado:analise.parecer_humanizado,
      analise_tecnica:analise.analise_tecnica,
      analise_juridica:analise.analise_juridica,
      analise_previdenciaria:analise.analise_previdenciaria,
      analise_psicossocial:analise.analise_psicossocial,
      analise_nr01:analise.analise_nr01,
      plano_acao_sugerido:analise.plano_acao_sugerido || [],
      inconformidades_priorizadas:analise.inconformidades_priorizadas || [],
      recomendacoes_diretoria:analise.recomendacoes_diretoria || [],
      risco_juridico_detalhado:analise.risco_juridico_detalhado,
      risco_previdenciario_detalhado:analise.risco_previdenciario_detalhado,
      risco_psicossocial_detalhado:analise.risco_psicossocial_detalhado,
      risco_ocupacional_detalhado:analise.risco_ocupacional_detalhado,
      criticidade_estrategica:analise.criticidade_estrategica || parecer.nivel_criticidade,
      score_ia:Number(analise.score_ia || parecer.score_compliance || 0),
      linguagem_diretoria:analise.linguagem_diretoria,
      linguagem_tecnica:analise.linguagem_tecnica,
      linguagem_juridica:analise.linguagem_juridica,
      modelo_openai:OPENAI_API_KEY ? OPENAI_MODEL : "fallback-sgi-sem-openai",
      tokens_estimados:analise._tokens_estimados || null,
      status:"gerado",
      payload:{analise,parecer,ocr,doc},
      updated_at:new Date().toISOString()
    };

    const { error } = await supabase.from("ged_pareceres_openai_sst").insert([registro]);
    if(error) throw error;

    await supabase.from("ged_pareceres_openai_fila").update({
      status:"concluido", finished_at:new Date().toISOString(), updated_at:new Date().toISOString()
    }).eq("id", item.id);

    console.log(`Parecer OpenAI SST gerado: ${parecer.titulo_documento}`);
  }catch(err){
    await supabase.from("ged_pareceres_openai_fila").update({
      status:"erro", erro_mensagem:err.message, finished_at:new Date().toISOString(), updated_at:new Date().toISOString()
    }).eq("id", item.id);
    console.error("Erro OpenAI SST:", err.message);
  }
}

async function ciclo(){
  if(rodando) return;
  rodando=true;
  try{
    const fila = await buscarFila();
    if(!fila.length) console.log(`[${new Date().toLocaleString("pt-BR")}] Nenhum parecer na fila OpenAI SST.`);
    for(const item of fila) await processar(item);
  }catch(err){ console.error("Erro no ciclo OpenAI SST:", err); }
  finally{ rodando=false; }
}

async function main(){
  console.log("SGI Renovar OpenAI SST Worker iniciado.");
  console.log(`Intervalo: ${INTERVALO}ms | Modelo: ${OPENAI_API_KEY ? OPENAI_MODEL : "fallback sem OPENAI_API_KEY"}`);
  await ciclo();
  while(true){ await esperar(INTERVALO); await ciclo(); }
}

main().catch(err=>{ console.error("Erro fatal:", err); process.exit(1); });
