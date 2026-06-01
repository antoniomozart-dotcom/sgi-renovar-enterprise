create extension if not exists "pgcrypto";

create table if not exists ged_pareceres_ia_sst (
  id uuid primary key default gen_random_uuid(),
  documento_id uuid references ged_documentos_enterprise(id) on delete cascade,
  resultado_ocr_id uuid references ged_ocr_resultados(id) on delete set null,
  empresa_id uuid references empresas(id),
  tipo_documento text,
  titulo_documento text,
  score_compliance numeric(5,2),
  score_risco numeric(5,2),
  nivel_criticidade text default 'baixo',
  parecer_tecnico text,
  resumo_executivo text,
  nr_relacionadas jsonb,
  inconformidades jsonb,
  recomendacoes jsonb,
  riscos_identificados jsonb,
  evidencias_detectadas jsonb,
  risco_juridico text,
  risco_previdenciario text,
  risco_ocupacional text,
  risco_psicossocial text,
  status text default 'gerado',
  modelo_ia text default 'motor-parecer-sgi-v1',
  payload jsonb,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists ged_pareceres_ia_fila (
  id uuid primary key default gen_random_uuid(),
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

create or replace view vw_ged_pareceres_ia_painel as
select
  d.id as documento_id,
  d.empresa_id,
  e.nome as empresa_nome,
  d.titulo,
  d.tipo_documento,
  d.nome_arquivo,
  r.id as resultado_ocr_id,
  r.tipo_documento_detectado,
  r.score_confianca,
  r.resumo_ia,
  p.id as parecer_id,
  p.score_compliance,
  p.score_risco,
  p.nivel_criticidade,
  p.risco_juridico,
  p.risco_previdenciario,
  p.risco_ocupacional,
  p.risco_psicossocial,
  p.parecer_tecnico,
  p.resumo_executivo,
  p.created_at as parecer_created_at,
  f.id as fila_id,
  f.status as status_fila,
  f.erro_mensagem
from ged_documentos_enterprise d
left join empresas e on e.id = d.empresa_id
left join lateral (
  select * from ged_ocr_resultados r
  where r.documento_id = d.id
  order by r.created_at desc
  limit 1
) r on true
left join lateral (
  select * from ged_pareceres_ia_sst p
  where p.documento_id = d.id
  order by p.created_at desc
  limit 1
) p on true
left join lateral (
  select * from ged_pareceres_ia_fila f
  where f.documento_id = d.id
  order by f.created_at desc
  limit 1
) f on true
where r.id is not null;

alter table ged_pareceres_ia_sst enable row level security;
alter table ged_pareceres_ia_fila enable row level security;

drop policy if exists "Liberar leitura ged_pareceres_ia_sst" on ged_pareceres_ia_sst;
drop policy if exists "Liberar insert ged_pareceres_ia_sst" on ged_pareceres_ia_sst;
drop policy if exists "Liberar update ged_pareceres_ia_sst" on ged_pareceres_ia_sst;
create policy "Liberar leitura ged_pareceres_ia_sst" on ged_pareceres_ia_sst for select using (true);
create policy "Liberar insert ged_pareceres_ia_sst" on ged_pareceres_ia_sst for insert with check (true);
create policy "Liberar update ged_pareceres_ia_sst" on ged_pareceres_ia_sst for update using (true) with check (true);

drop policy if exists "Liberar leitura ged_pareceres_ia_fila" on ged_pareceres_ia_fila;
drop policy if exists "Liberar insert ged_pareceres_ia_fila" on ged_pareceres_ia_fila;
drop policy if exists "Liberar update ged_pareceres_ia_fila" on ged_pareceres_ia_fila;
create policy "Liberar leitura ged_pareceres_ia_fila" on ged_pareceres_ia_fila for select using (true);
create policy "Liberar insert ged_pareceres_ia_fila" on ged_pareceres_ia_fila for insert with check (true);
create policy "Liberar update ged_pareceres_ia_fila" on ged_pareceres_ia_fila for update using (true) with check (true);

notify pgrst, 'reload schema';
