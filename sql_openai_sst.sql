-- SGI RENOVAR | OPENAI SST ENTERPRISE

create extension if not exists "pgcrypto";

create table if not exists ged_pareceres_openai_sst (
  id uuid primary key default gen_random_uuid(),
  parecer_ia_id uuid references ged_pareceres_ia_sst(id) on delete cascade,
  documento_id uuid references ged_documentos_enterprise(id) on delete cascade,
  resultado_ocr_id uuid references ged_ocr_resultados(id) on delete set null,
  empresa_id uuid references empresas(id),
  tipo_documento text,
  titulo_documento text,
  resumo_executivo text,
  parecer_humanizado text,
  analise_tecnica text,
  analise_juridica text,
  analise_previdenciaria text,
  analise_psicossocial text,
  analise_nr01 text,
  plano_acao_sugerido jsonb,
  inconformidades_priorizadas jsonb,
  recomendacoes_diretoria jsonb,
  risco_juridico_detalhado text,
  risco_previdenciario_detalhado text,
  risco_psicossocial_detalhado text,
  risco_ocupacional_detalhado text,
  criticidade_estrategica text,
  score_ia numeric(5,2),
  linguagem_diretoria text,
  linguagem_tecnica text,
  linguagem_juridica text,
  modelo_openai text,
  tokens_estimados integer,
  status text default 'gerado',
  payload jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists ged_pareceres_openai_fila (
  id uuid primary key default gen_random_uuid(),
  parecer_ia_id uuid references ged_pareceres_ia_sst(id) on delete cascade,
  documento_id uuid references ged_documentos_enterprise(id) on delete cascade,
  resultado_ocr_id uuid references ged_ocr_resultados(id) on delete cascade,
  empresa_id uuid references empresas(id),
  status text default 'fila',
  prioridade text default 'media',
  tentativas integer default 0,
  erro_mensagem text,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_ged_pareceres_openai_empresa on ged_pareceres_openai_sst(empresa_id);
create index if not exists idx_ged_pareceres_openai_documento on ged_pareceres_openai_sst(documento_id);
create index if not exists idx_ged_pareceres_openai_fila_status on ged_pareceres_openai_fila(status);

create or replace view vw_openai_sst_painel as
select
  p.id as parecer_ia_id,
  p.documento_id,
  p.resultado_ocr_id,
  p.empresa_id,
  e.nome as empresa_nome,
  p.tipo_documento,
  p.titulo_documento,
  p.score_compliance,
  p.score_risco,
  p.nivel_criticidade,
  p.resumo_executivo as resumo_motor,
  p.parecer_tecnico as parecer_motor,
  p.inconformidades,
  p.recomendacoes,
  o.id as openai_id,
  o.resumo_executivo,
  o.parecer_humanizado,
  o.analise_tecnica,
  o.analise_juridica,
  o.analise_previdenciaria,
  o.analise_psicossocial,
  o.analise_nr01,
  o.criticidade_estrategica,
  o.score_ia,
  o.created_at as openai_created_at,
  f.id as fila_id,
  f.status as status_fila,
  f.erro_mensagem
from ged_pareceres_ia_sst p
left join empresas e on e.id = p.empresa_id
left join lateral (
  select * from ged_pareceres_openai_sst o
  where o.parecer_ia_id = p.id
  order by o.created_at desc
  limit 1
) o on true
left join lateral (
  select * from ged_pareceres_openai_fila f
  where f.parecer_ia_id = p.id
  order by f.created_at desc
  limit 1
) f on true;

alter table ged_pareceres_openai_sst enable row level security;
alter table ged_pareceres_openai_fila enable row level security;

drop policy if exists "Liberar leitura ged_pareceres_openai_sst" on ged_pareceres_openai_sst;
drop policy if exists "Liberar insert ged_pareceres_openai_sst" on ged_pareceres_openai_sst;
drop policy if exists "Liberar update ged_pareceres_openai_sst" on ged_pareceres_openai_sst;
create policy "Liberar leitura ged_pareceres_openai_sst" on ged_pareceres_openai_sst for select using (true);
create policy "Liberar insert ged_pareceres_openai_sst" on ged_pareceres_openai_sst for insert with check (true);
create policy "Liberar update ged_pareceres_openai_sst" on ged_pareceres_openai_sst for update using (true) with check (true);

drop policy if exists "Liberar leitura ged_pareceres_openai_fila" on ged_pareceres_openai_fila;
drop policy if exists "Liberar insert ged_pareceres_openai_fila" on ged_pareceres_openai_fila;
drop policy if exists "Liberar update ged_pareceres_openai_fila" on ged_pareceres_openai_fila;
create policy "Liberar leitura ged_pareceres_openai_fila" on ged_pareceres_openai_fila for select using (true);
create policy "Liberar insert ged_pareceres_openai_fila" on ged_pareceres_openai_fila for insert with check (true);
create policy "Liberar update ged_pareceres_openai_fila" on ged_pareceres_openai_fila for update using (true) with check (true);

notify pgrst, 'reload schema';
