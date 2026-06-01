import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const INTERVALO = Number(process.env.PARECER_WORKER_INTERVAL_MS || 120000);
const MAX_ITENS = Number(process.env.PARECER_WORKER_MAX_ITENS || 5);
let rodando = false;

function esperar(ms){return new Promise(r=>setTimeout(r,ms));}
function clamp(v){return Math.max(0,Math.min(100,Math.round(v)));}
function nivel(score){if(score>=85)return"baixo";if(score>=65)return"moderado";if(score>=45)return"alto";return"critico";}
function tem(texto, termos){const t=String(texto||"").toLowerCase();return termos.some(x=>t.includes(x));}

function analisar(tipo,texto,ocr){
  const inconformidades=[], recomendacoes=[], riscos=[], nrs=new Set(), evidencias=[];
  const tipoNorm=String(tipo||"Documento SST").toUpperCase();

  if(tipoNorm.includes("PGR")){
    nrs.add("NR-01");
    if(!tem(texto,["inventário de riscos","inventario de riscos"])) inconformidades.push({item:"Inventário de riscos",criticidade:"alta",descricao:"Inventário de riscos não identificado claramente."});
    if(!tem(texto,["plano de ação","plano de acao"])) inconformidades.push({item:"Plano de ação",criticidade:"alta",descricao:"Plano de ação não identificado claramente."});
    if(!tem(texto,["ergonômico","ergonomia","psicossocial"])) inconformidades.push({item:"Ergonomia/psicossocial",criticidade:"media",descricao:"Elementos ergonômicos ou psicossociais não identificados."});
    recomendacoes.push({prioridade:"alta",acao:"Revisar PGR",descricao:"Validar inventário, plano de ação, GHE e riscos psicossociais."});
  }

  if(tipoNorm.includes("PCMSO")){
    nrs.add("NR-07");
    if(!tem(texto,["médico coordenador","medico coordenador","crm"])) inconformidades.push({item:"Médico/CRM",criticidade:"alta",descricao:"Médico responsável/CRM não identificado claramente."});
    if(!tem(texto,["aso","atestado de saúde ocupacional"])) inconformidades.push({item:"ASO",criticidade:"media",descricao:"Referência a ASO não identificada."});
    if(!tem(texto,["periodicidade","exames complementares","exame clínico","exame clinico"])) inconformidades.push({item:"Exames/periodicidade",criticidade:"media",descricao:"Exames e periodicidade não identificados claramente."});
    recomendacoes.push({prioridade:"alta",acao:"Revisar PCMSO",descricao:"Validar médico responsável, exames, periodicidade e vínculo com o PGR."});
  }

  if(tipoNorm.includes("LTCAT")){
    nrs.add("Previdenciário");
    if(!tem(texto,["agente nocivo","agentes nocivos","ruído","ruido","calor","químico","quimico"])) inconformidades.push({item:"Agentes nocivos",criticidade:"alta",descricao:"Agentes nocivos não identificados claramente."});
    if(!tem(texto,["metodologia","técnica utilizada","tecnica utilizada","avaliação quantitativa","avaliacao quantitativa"])) inconformidades.push({item:"Metodologia",criticidade:"alta",descricao:"Metodologia/técnica de avaliação não identificada."});
    recomendacoes.push({prioridade:"alta",acao:"Revisar LTCAT",descricao:"Validar agentes, metodologia, responsável técnico e enquadramento previdenciário."});
  }

  if(tipoNorm.includes("PPP")){
    nrs.add("Previdenciário");
    if(!tem(texto,["ltcat","agente nocivo","gfip","responsável","responsavel"])) inconformidades.push({item:"Campos previdenciários",criticidade:"alta",descricao:"Campos críticos do PPP não identificados claramente."});
    recomendacoes.push({prioridade:"alta",acao:"Revisar PPP",descricao:"Conferir LTCAT, agentes, GFIP, responsáveis e histórico laboral."});
  }

  if(tipoNorm.includes("ASO")){
    nrs.add("NR-07");
    if(!tem(texto,["apto","inapto"])) inconformidades.push({item:"Resultado ASO",criticidade:"alta",descricao:"Resultado APTO/INAPTO não identificado."});
    if(!tem(texto,["crm","médico","medico"])) inconformidades.push({item:"Médico/CRM",criticidade:"alta",descricao:"Médico ou CRM não identificado."});
    recomendacoes.push({prioridade:"media",acao:"Validar ASO",descricao:"Conferir tipo de exame, resultado, assinatura e CRM."});
  }

  if(Array.isArray(ocr.agentes_detectados)&&ocr.agentes_detectados.length) evidencias.push({tipo:"agentes",itens:ocr.agentes_detectados});
  if(Array.isArray(ocr.riscos_detectados)&&ocr.riscos_detectados.length) riscos.push(...ocr.riscos_detectados);

  const altas=inconformidades.filter(i=>i.criticidade==="alta").length;
  const scoreCompliance=clamp(100 - inconformidades.length*10 - altas*8);
  const scoreRisco=clamp(100-scoreCompliance+altas*10);

  return {scoreCompliance,scoreRisco,criticidade:nivel(scoreCompliance),nrRelacionadas:[...nrs],inconformidades,recomendacoes,riscos:[...new Set(riscos)],evidencias};
}

function gerarTextos(doc,ocr,a){
  const tipo=ocr.tipo_documento_detectado||doc.tipo_documento||"Documento SST";
  const resumo=`Documento classificado como ${tipo}. Score de compliance ${a.scoreCompliance}%. Criticidade ${a.criticidade}. Foram identificadas ${a.inconformidades.length} inconformidade(s).`;
  const parecer=[
    `Parecer técnico automático do SGI Renovar sobre o documento "${doc.titulo||doc.nome_arquivo}".`,
    `Tipo documental: ${tipo}.`,
    `Resumo OCR: ${ocr.resumo_ia||"Sem resumo OCR disponível."}`,
    `NRs relacionadas: ${a.nrRelacionadas.join(", ")||"não identificadas automaticamente"}.`,
    a.inconformidades.length?`Inconformidades: ${a.inconformidades.map(i=>i.item).join(", ")}.`:`Não foram identificadas inconformidades relevantes pelas regras atuais.`,
    `Recomenda-se validação técnica por profissional habilitado.`
  ].join(" ");
  return {resumo,parecer};
}

async function buscarFila(){
  const {data,error}=await supabase.from("ged_pareceres_ia_fila").select("*, ged_documentos_enterprise(*), ged_ocr_resultados(*)").eq("status","fila").order("created_at",{ascending:true}).limit(MAX_ITENS);
  if(error) throw error;
  return data||[];
}

async function processar(item){
  const doc=item.ged_documentos_enterprise, ocr=item.ged_ocr_resultados;
  if(!doc||!ocr) throw new Error("Documento ou OCR não encontrado.");
  await supabase.from("ged_pareceres_ia_fila").update({status:"processando",started_at:new Date().toISOString(),tentativas:(item.tentativas||0)+1}).eq("id",item.id);

  try{
    const texto=`${ocr.texto_extraido||""}\n${ocr.resumo_ia||""}`;
    const a=analisar(ocr.tipo_documento_detectado||doc.tipo_documento,texto,ocr);
    const t=gerarTextos(doc,ocr,a);
    const registro={
      documento_id:doc.id, resultado_ocr_id:ocr.id, empresa_id:doc.empresa_id,
      tipo_documento:ocr.tipo_documento_detectado||doc.tipo_documento, titulo_documento:doc.titulo||doc.nome_arquivo,
      score_compliance:a.scoreCompliance, score_risco:a.scoreRisco, nivel_criticidade:a.criticidade,
      parecer_tecnico:t.parecer, resumo_executivo:t.resumo, nr_relacionadas:a.nrRelacionadas,
      inconformidades:a.inconformidades, recomendacoes:a.recomendacoes, riscos_identificados:a.riscos,
      evidencias_detectadas:a.evidencias,
      risco_juridico:a.scoreCompliance<65?"alto":"baixo",
      risco_previdenciario:String(a.nrRelacionadas).includes("Previdenciário")&&a.scoreCompliance<75?"moderado":"baixo",
      risco_ocupacional:a.scoreCompliance<75?"moderado":"baixo",
      risco_psicossocial:tem(texto,["psicossocial","assédio","assedio","burnout","sobrecarga"])?"moderado":"baixo",
      payload:{doc,ocr,analise:a}, status:"gerado", updated_at:new Date().toISOString()
    };
    const {error}=await supabase.from("ged_pareceres_ia_sst").insert([registro]);
    if(error) throw error;
    await supabase.from("ged_pareceres_ia_fila").update({status:"concluido",finished_at:new Date().toISOString()}).eq("id",item.id);
    console.log(`Parecer IA gerado: ${doc.titulo||doc.nome_arquivo}`);
  }catch(err){
    await supabase.from("ged_pareceres_ia_fila").update({status:"erro",erro_mensagem:err.message,finished_at:new Date().toISOString()}).eq("id",item.id);
    console.error("Erro parecer IA:",err.message);
  }
}

async function ciclo(){
  if(rodando)return; rodando=true;
  try{
    const fila=await buscarFila();
    if(!fila.length) console.log(`[${new Date().toLocaleString("pt-BR")}] Nenhum documento na fila de parecer IA.`);
    for(const item of fila) await processar(item);
  }catch(e){console.error("Erro no ciclo parecer IA:",e);}
  finally{rodando=false;}
}

async function main(){
  console.log("SGI Renovar Parecer IA SST Worker iniciado.");
  console.log(`Intervalo: ${INTERVALO}ms`);
  await ciclo();
  while(true){await esperar(INTERVALO);await ciclo();}
}
main().catch(e=>{console.error("Erro fatal:",e);process.exit(1);});
