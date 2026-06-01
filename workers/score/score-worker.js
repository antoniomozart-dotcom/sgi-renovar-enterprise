import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const INTERVALO = Number(process.env.SCORE_WORKER_INTERVAL_MS || 300000);
let rodando = false;

function esperar(ms){ return new Promise(r => setTimeout(r, ms)); }
function clamp(v){ return Math.max(0, Math.min(100, Math.round(v))); }
function nivel(score){ if(score>=85)return"baixo"; if(score>=65)return"moderado"; if(score>=45)return"alto"; return"critico"; }
function diffDias(data){ if(!data)return null; const h=new Date(); h.setHours(0,0,0,0); const a=new Date(String(data).slice(0,10)+"T00:00:00"); return Math.ceil((a-h)/(1000*60*60*24)); }
function statusDocumento(d){ if(d.status)return d.status; if(!d.data_validade)return"sem_validade"; const dias=diffDias(d.data_validade); if(dias<0)return"vencido"; if(dias<=60)return"a_vencer"; return"valido"; }

async function selectSafe(table, cols, empresaId){
  const {data,error}=await supabase.from(table).select(cols).eq("empresa_id",empresaId);
  if(error){ console.log(`Aviso ${table}:`, error.message); return []; }
  return data||[];
}

async function buscarEmpresas(){
  const {data,error}=await supabase.from("empresas").select("id,nome,cnpj");
  if(error) throw error;
  return data||[];
}

async function dadosEmpresa(empresaId){
  const [documentos,eventos,inconsistencias,aso,cat,ppp,trabalhadores,alertas] = await Promise.all([
    selectSafe("documentos_sst","*",empresaId),
    selectSafe("eventos_esocial","*",empresaId),
    selectSafe("ged_inconsistencias_documentais","*",empresaId),
    selectSafe("s2220_aso","*",empresaId),
    selectSafe("cat_comunicacoes","*",empresaId),
    selectSafe("ppp_inteligente_gerado","*",empresaId),
    selectSafe("vw_ppp_trabalhadores_resumo","*",empresaId),
    selectSafe("alertas_sgi","*",empresaId)
  ]);
  return {documentos,eventos,inconsistencias,aso,cat,ppp,trabalhadores,alertas};
}

function calcDoc(docs, incs){
  const venc=docs.filter(d=>statusDocumento(d)==="vencido").length;
  const av=docs.filter(d=>statusDocumento(d)==="a_vencer").length;
  const crit=incs.filter(i=>["alta","critica"].includes(String(i.severidade||"").toLowerCase())).length;
  return clamp(100 - venc*9 - av*3 - incs.length*3 - crit*5);
}
function calcEsocial(evs){
  const rej=evs.filter(e=>["erro","recusado","rejeitado"].includes(String(e.status||"").toLowerCase())).length;
  const fila=evs.filter(e=>["fila","fila_envio","processando","gerando_xml","assinando_xml","enviando"].includes(String(e.status||"").toLowerCase())).length;
  return clamp(100 - rej*12 - fila*2);
}
function calcOcup(aso,cat,trab){
  const asoV=aso.filter(a=>a.data_aso && Math.floor((new Date()-new Date(a.data_aso+"T00:00:00"))/(1000*60*60*24))>=365).length;
  const catP=cat.filter(c=>!["enviado","processado","concluido"].includes(String(c.status_esocial||c.status||"").toLowerCase())).length;
  const semGhe=trab.filter(t=>Number(t.total_exposicoes||0)===0).length;
  return clamp(100 - asoV*5 - catP*8 - semGhe*2);
}
function calcJur(cat,incs,alerts){
  const catP=cat.filter(c=>!["enviado","processado","concluido"].includes(String(c.status_esocial||c.status||"").toLowerCase())).length;
  const crit=incs.filter(i=>["alta","critica"].includes(String(i.severidade||"").toLowerCase())).length;
  const acrit=alerts.filter(a=>["alta","critica"].includes(String(a.prioridade||"").toLowerCase()) && String(a.status||"")!=="resolvido").length;
  return clamp(100 - catP*10 - crit*7 - acrit*5);
}
function parecer(emp,scores,indic){
  const p=[`Análise automática da empresa ${emp.nome||""}. Score geral: ${scores.geral}%.`];
  if(scores.doc<70)p.push("Dimensão documental com fragilidade relevante.");
  if(scores.eso<75)p.push("eSocial com pendências, fila ou rejeições.");
  if(scores.ocup<75)p.push("Dimensão ocupacional com ASO, CAT ou GHE pendente.");
  if(scores.jur<75)p.push("Risco jurídico/previdenciário aumentado.");
  if(indic.documentos_vencidos)p.push(`Documentos vencidos: ${indic.documentos_vencidos}.`);
  if(indic.eventos_esocial_rejeitados)p.push(`Eventos eSocial com erro/rejeição: ${indic.eventos_esocial_rejeitados}.`);
  if(indic.inconsistencias_ocr)p.push(`Inconsistências OCR abertas: ${indic.inconsistencias_ocr}.`);
  return p.join(" ");
}
function recomendacoes(ind){
  const r=[];
  if(ind.documentos_vencidos>0)r.push({prioridade:"alta",modulo:"Documentos SST",acao:"Regularizar documentos vencidos"});
  if(ind.eventos_esocial_rejeitados>0)r.push({prioridade:"alta",modulo:"eSocial",acao:"Corrigir eventos eSocial"});
  if(ind.inconsistencias_criticas>0)r.push({prioridade:"alta",modulo:"GED/OCR",acao:"Revisar inconsistências críticas"});
  if(ind.trabalhadores_sem_ghe>0)r.push({prioridade:"media",modulo:"PPP",acao:"Vincular GHE/exposição"});
  if(ind.cat_pendentes>0)r.push({prioridade:"alta",modulo:"CAT",acao:"Regularizar CAT"});
  return r;
}

async function salvar(emp,d){
  const ind={
    documentos_total:d.documentos.length,
    documentos_vencidos:d.documentos.filter(x=>statusDocumento(x)==="vencido").length,
    documentos_a_vencer:d.documentos.filter(x=>statusDocumento(x)==="a_vencer").length,
    documentos_criticos:d.inconsistencias.filter(i=>["alta","critica"].includes(String(i.severidade||"").toLowerCase())).length,
    eventos_esocial_total:d.eventos.length,
    eventos_esocial_rejeitados:d.eventos.filter(e=>["erro","recusado","rejeitado"].includes(String(e.status||"").toLowerCase())).length,
    eventos_esocial_fila:d.eventos.filter(e=>["fila","fila_envio","processando","gerando_xml","assinando_xml","enviando"].includes(String(e.status||"").toLowerCase())).length,
    inconsistencias_ocr:d.inconsistencias.filter(i=>String(i.status||"")!=="resolvida").length,
    inconsistencias_criticas:d.inconsistencias.filter(i=>["alta","critica"].includes(String(i.severidade||"").toLowerCase())).length,
    aso_total:d.aso.length,
    aso_vencidos:d.aso.filter(a=>a.data_aso && Math.floor((new Date()-new Date(a.data_aso+"T00:00:00"))/(1000*60*60*24))>=365).length,
    cat_total:d.cat.length,
    cat_pendentes:d.cat.filter(c=>!["enviado","processado","concluido"].includes(String(c.status_esocial||c.status||"").toLowerCase())).length,
    ppp_total:d.ppp.length,
    trabalhadores_sem_ghe:d.trabalhadores.filter(t=>Number(t.total_exposicoes||0)===0).length,
    alertas_pendentes:d.alertas.filter(a=>String(a.status||"")!=="resolvido").length,
    alertas_criticos:d.alertas.filter(a=>["alta","critica"].includes(String(a.prioridade||"").toLowerCase())).length
  };
  const score_documental=calcDoc(d.documentos,d.inconsistencias);
  const score_esocial=calcEsocial(d.eventos);
  const score_ocupacional=calcOcup(d.aso,d.cat,d.trabalhadores);
  const score_juridico=calcJur(d.cat,d.inconsistencias,d.alertas);
  const score_psicossocial=100;
  const score_compliance=clamp(score_documental*.30+score_esocial*.25+score_ocupacional*.20+score_juridico*.15+score_psicossocial*.10);
  const scores={geral:score_compliance,doc:score_documental,eso:score_esocial,ocup:score_ocupacional,jur:score_juridico};
  const registro={
    empresa_id:emp.id, score_compliance, score_documental, score_esocial, score_psicossocial, score_ocupacional, score_juridico,
    risco_geral:nivel(score_compliance), risco_psicossocial:nivel(score_psicossocial), risco_juridico:nivel(score_juridico), risco_documental:nivel(score_documental), risco_esocial:nivel(score_esocial), risco_ocupacional:nivel(score_ocupacional),
    ...ind,
    parecer_automatico:parecer(emp,scores,ind),
    recomendacoes:recomendacoes(ind),
    payload:{empresa:emp,indicadores:ind,analisado_em:new Date().toISOString()},
    ultima_analise:new Date().toISOString(), updated_at:new Date().toISOString()
  };
  const {error}=await supabase.from("compliance_score_empresas").insert([registro]);
  if(error) throw error;
  console.log(`Score calculado: ${emp.nome} = ${score_compliance}% (${registro.risco_geral})`);
}

async function ciclo(){
  if(rodando)return; rodando=true;
  try{
    const empresas=await buscarEmpresas();
    console.log(`[${new Date().toLocaleString("pt-BR")}] Calculando score cognitivo de ${empresas.length} empresa(s).`);
    for(const emp of empresas){ await salvar(emp, await dadosEmpresa(emp.id)); }
    console.log("Ciclo de score cognitivo finalizado.");
  }catch(e){ console.error("Erro no ciclo score cognitivo:",e); }
  finally{ rodando=false; }
}

async function main(){
  console.log("SGI Renovar Score Cognitivo Worker iniciado.");
  console.log(`Intervalo: ${INTERVALO}ms`);
  await ciclo();
  while(true){ await esperar(INTERVALO); await ciclo(); }
}
main().catch(e=>{ console.error("Erro fatal:",e); process.exit(1); });