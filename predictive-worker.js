import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const INTERVALO = Number(process.env.PREDICTIVE_WORKER_INTERVAL_MS || 300000);

let rodando = false;

function esperar(ms){ return new Promise(r => setTimeout(r, ms)); }
function clamp(v){ return Math.max(0, Math.min(100, Math.round(v))); }

function nivel(score){
  if(score < 25) return "baixo";
  if(score < 50) return "moderado";
  if(score < 75) return "alto";
  return "critico";
}

function tendencia(score){
  if(score >= 75) return "crescente_critica";
  if(score >= 55) return "crescente";
  if(score >= 35) return "atencao";
  return "estavel";
}

async function selectSafe(table, cols, empresaId=null, limit=500){
  try{
    let q = supabase.from(table).select(cols).limit(limit);
    if(empresaId) q = q.eq("empresa_id", empresaId);
    const { data, error } = await q;
    if(error){
      console.log(`Aviso ${table}: ${error.message}`);
      return [];
    }
    return data || [];
  }catch(err){
    console.log(`Aviso ${table}: ${err.message}`);
    return [];
  }
}

async function buscarEmpresas(){
  const { data, error } = await supabase.from("empresas").select("id,nome,cnpj");
  if(error) throw error;
  return data || [];
}

async function dadosEmpresa(empresaId){
  const [
    score,
    documentos,
    inconsistencias,
    eventos,
    pareceres,
    openai,
    alertas,
    tarefas
  ] = await Promise.all([
    selectSafe("vw_compliance_score_atual","*",empresaId,1),
    selectSafe("documentos_sst","*",empresaId,500),
    selectSafe("ged_inconsistencias_documentais","*",empresaId,500),
    selectSafe("eventos_esocial","*",empresaId,500),
    selectSafe("ged_pareceres_ia_sst","*",empresaId,200),
    selectSafe("ged_pareceres_openai_sst","*",empresaId,200),
    selectSafe("alertas_sgi","*",empresaId,500),
    selectSafe("vw_automacao_tarefas_resumo","*",empresaId,500)
  ]);

  return {
    score: score?.[0] || {},
    documentos,
    inconsistencias,
    eventos,
    pareceres,
    openai,
    alertas,
    tarefas
  };
}

function contem(texto, termos){
  texto = String(texto || "").toLowerCase();
  return termos.some(t => texto.includes(t));
}

function contarPsicossocial(dados){
  const termos = ["psicossocial","burnout","assédio","assedio","sobrecarga","fadiga","pressão","pressao","liderança","lideranca","clima","emocional"];

  let total = 0;

  for(const p of dados.pareceres){
    if(contem(JSON.stringify(p), termos)) total++;
  }

  for(const p of dados.openai){
    if(contem(JSON.stringify(p), termos)) total++;
  }

  for(const a of dados.alertas){
    if(contem(JSON.stringify(a), termos)) total++;
  }

  return total;
}

function indicadores(dados){
  const score = dados.score || {};

  const docsVencidos = Number(score.documentos_vencidos || 0);
  const docsCriticos = Number(score.documentos_criticos || 0);
  const esocialRejeitado = Number(score.eventos_esocial_rejeitados || 0);
  const inconsistencias = Number(score.inconsistencias_ocr || dados.inconsistencias.length || 0);
  const inconsistenciasCriticas = Number(score.inconsistencias_criticas || 0);
  const asoVencidos = Number(score.aso_vencidos || 0);
  const catPendentes = Number(score.cat_pendentes || 0);
  const trabalhadoresSemGhe = Number(score.trabalhadores_sem_ghe || 0);
  const alertasCriticos = Number(score.alertas_criticos || 0);
  const tarefasVencidas = dados.tarefas.filter(t => t.status_prazo === "vencida").length;
  const psicossocial = contarPsicossocial(dados);

  return {
    compliance: Number(score.score_compliance || 100),
    documental: Number(score.score_documental || 100),
    esocial: Number(score.score_esocial || 100),
    juridico: Number(score.score_juridico || 100),
    ocupacional: Number(score.score_ocupacional || 100),
    psicossocial_score_base: Number(score.score_psicossocial || 100),
    docs_vencidos: docsVencidos,
    docs_criticos: docsCriticos,
    esocial_rejeitado: esocialRejeitado,
    inconsistencias,
    inconsistencias_criticas: inconsistenciasCriticas,
    aso_vencidos: asoVencidos,
    cat_pendentes: catPendentes,
    trabalhadores_sem_ghe: trabalhadoresSemGhe,
    alertas_criticos: alertasCriticos,
    tarefas_vencidas: tarefasVencidas,
    sinais_psicossociais: psicossocial,
    pareceres_openai: dados.openai.length
  };
}

function calcularPredicao(ind){
  const scoreBurnout = clamp(
    ind.sinais_psicossociais * 14 +
    ind.alertas_criticos * 5 +
    ind.tarefas_vencidas * 3 +
    (100 - ind.psicossocial_score_base) * 0.45 +
    (100 - ind.ocupacional) * 0.15
  );

  const scoreAbsenteismo = clamp(
    ind.aso_vencidos * 10 +
    ind.cat_pendentes * 9 +
    ind.trabalhadores_sem_ghe * 2 +
    ind.alertas_criticos * 4 +
    (100 - ind.ocupacional) * 0.35
  );

  const scoreJuridico = clamp(
    ind.docs_vencidos * 7 +
    ind.docs_criticos * 8 +
    ind.inconsistencias_criticas * 9 +
    ind.cat_pendentes * 12 +
    ind.esocial_rejeitado * 7 +
    (100 - ind.juridico) * 0.40
  );

  const scoreFiscalizacao = clamp(
    ind.docs_vencidos * 8 +
    ind.esocial_rejeitado * 8 +
    ind.inconsistencias * 3 +
    ind.alertas_criticos * 6 +
    (100 - ind.compliance) * 0.50
  );

  const scoreTurnover = clamp(
    ind.sinais_psicossociais * 10 +
    ind.alertas_criticos * 4 +
    ind.tarefas_vencidas * 3 +
    (100 - ind.psicossocial_score_base) * 0.35
  );

  const scorePsicossocial = clamp(
    ind.sinais_psicossociais * 16 +
    (100 - ind.psicossocial_score_base) * 0.55 +
    ind.alertas_criticos * 4
  );

  const scoreGeral = clamp(
    scoreBurnout * 0.20 +
    scoreAbsenteismo * 0.20 +
    scoreJuridico * 0.25 +
    scoreFiscalizacao * 0.20 +
    scoreTurnover * 0.10 +
    scorePsicossocial * 0.05
  );

  return {
    scoreBurnout,
    scoreAbsenteismo,
    scoreJuridico,
    scoreFiscalizacao,
    scoreTurnover,
    scorePsicossocial,
    scoreGeral
  };
}

function fatores(ind){
  const f = [];

  if(ind.docs_vencidos) f.push({tipo:"documental", criticidade:"alta", descricao:`${ind.docs_vencidos} documento(s) vencido(s).`});
  if(ind.esocial_rejeitado) f.push({tipo:"esocial", criticidade:"alta", descricao:`${ind.esocial_rejeitado} evento(s) eSocial rejeitado(s).`});
  if(ind.inconsistencias_criticas) f.push({tipo:"ocr", criticidade:"alta", descricao:`${ind.inconsistencias_criticas} inconsistência(s) crítica(s) OCR/GED.`});
  if(ind.cat_pendentes) f.push({tipo:"cat", criticidade:"alta", descricao:`${ind.cat_pendentes} CAT(s) pendente(s).`});
  if(ind.aso_vencidos) f.push({tipo:"aso", criticidade:"media", descricao:`${ind.aso_vencidos} ASO(s) vencido(s).`});
  if(ind.sinais_psicossociais) f.push({tipo:"psicossocial", criticidade:"alta", descricao:`${ind.sinais_psicossociais} sinal(is) psicossocial(is) detectado(s).`});
  if(ind.trabalhadores_sem_ghe) f.push({tipo:"ppp", criticidade:"media", descricao:`${ind.trabalhadores_sem_ghe} trabalhador(es) sem GHE/exposição.`});

  if(!f.length){
    f.push({tipo:"estabilidade", criticidade:"baixa", descricao:"Nenhum fator preditivo crítico detectado."});
  }

  return f;
}

function recomendacoes(ind, pred){
  const r = [];

  if(pred.scoreJuridico >= 50) r.push({prioridade:"alta", modulo:"Jurídico/SST", acao:"Auditar evidências documentais e CAT/PPP/LTCAT."});
  if(pred.scoreFiscalizacao >= 50) r.push({prioridade:"alta", modulo:"Compliance", acao:"Regularizar documentos vencidos e eventos eSocial rejeitados."});
  if(pred.scoreBurnout >= 50) r.push({prioridade:"alta", modulo:"NR-01 Psicossocial", acao:"Aplicar diagnóstico psicossocial e plano de ação preventivo."});
  if(pred.scoreAbsenteismo >= 50) r.push({prioridade:"media", modulo:"Saúde Ocupacional", acao:"Revisar ASO, exames periódicos e setores críticos."});
  if(pred.scoreTurnover >= 50) r.push({prioridade:"media", modulo:"Pessoas", acao:"Avaliar clima, liderança e pressão operacional."});

  if(!r.length){
    r.push({prioridade:"baixa", modulo:"Governança", acao:"Manter monitoramento preventivo e rotina mensal de indicadores."});
  }

  return r;
}

function parecer(empresa, ind, pred){
  return [
    `Análise preditiva da empresa ${empresa.nome || ""}.`,
    `Risco geral preditivo: ${pred.scoreGeral}% (${nivel(pred.scoreGeral)}).`,
    `Burnout: ${pred.scoreBurnout}%. Afastamento/absenteísmo: ${pred.scoreAbsenteismo}%. Jurídico: ${pred.scoreJuridico}%. Fiscalização: ${pred.scoreFiscalizacao}%. Turnover: ${pred.scoreTurnover}%.`,
    ind.docs_vencidos ? `Há ${ind.docs_vencidos} documento(s) vencido(s), aumentando risco de fiscalização e passivo.` : `Não há documentos vencidos relevantes no score atual.`,
    ind.esocial_rejeitado ? `Existem ${ind.esocial_rejeitado} evento(s) eSocial com erro ou rejeição.` : `Não há rejeição eSocial relevante no score atual.`,
    ind.sinais_psicossociais ? `Foram detectados sinais psicossociais que exigem atenção preventiva.` : `Não há sinal psicossocial relevante identificado pela base atual.`,
    `Recomenda-se ação preventiva proporcional à criticidade e validação técnica pela equipe Renovar.`
  ].join(" ");
}

async function salvar(empresa, dados){
  const ind = indicadores(dados);
  const pred = calcularPredicao(ind);

  const registro = {
    empresa_id: empresa.id,

    score_burnout: pred.scoreBurnout,
    score_absenteismo: pred.scoreAbsenteismo,
    score_juridico_preditivo: pred.scoreJuridico,
    score_fiscalizacao: pred.scoreFiscalizacao,
    score_turnover: pred.scoreTurnover,
    score_psicossocial: pred.scorePsicossocial,
    score_risco_geral: pred.scoreGeral,

    nivel_burnout: nivel(pred.scoreBurnout),
    nivel_absenteismo: nivel(pred.scoreAbsenteismo),
    nivel_juridico: nivel(pred.scoreJuridico),
    nivel_fiscalizacao: nivel(pred.scoreFiscalizacao),
    nivel_turnover: nivel(pred.scoreTurnover),
    nivel_psicossocial: nivel(pred.scorePsicossocial),
    nivel_risco_geral: nivel(pred.scoreGeral),

    tendencia: tendencia(pred.scoreGeral),

    principais_fatores: fatores(ind),
    recomendacoes: recomendacoes(ind, pred),
    parecer_preditivo: parecer(empresa, ind, pred),

    indicadores_base: ind,

    periodo_referencia: new Date().toISOString().slice(0,10),
    updated_at: new Date().toISOString()
  };

  const { error } = await supabase
    .from("predictions_risco_empresa")
    .insert([registro]);

  if(error) throw error;

  console.log(`Predição calculada: ${empresa.nome} = ${pred.scoreGeral}% (${registro.nivel_risco_geral})`);
}

async function ciclo(){
  if(rodando) return;
  rodando = true;

  try{
    const empresas = await buscarEmpresas();

    console.log(`[${new Date().toLocaleString("pt-BR")}] Calculando predições de ${empresas.length} empresa(s).`);

    for(const empresa of empresas){
      const dados = await dadosEmpresa(empresa.id);
      await salvar(empresa, dados);
    }

    console.log("Ciclo preditivo finalizado.");

  }catch(err){
    console.error("Erro no ciclo preditivo:", err);
  }finally{
    rodando = false;
  }
}

async function main(){
  console.log("SGI Renovar Predictive Intelligence Worker iniciado.");
  console.log(`Intervalo: ${INTERVALO}ms`);

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
