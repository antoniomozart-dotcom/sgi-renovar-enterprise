-- =========================================================
-- SGI RENOVAR | PREDICTIVE INTELLIGENCE ENGINE
-- Burnout, afastamento, jurídico, fiscalização e turnover
-- =========================================================

create extension if not exists "pgcrypto";

create table if not exists predictions_risco_empresa (
  id uuid primary key default gen_random_uuid(),

  empresa_id uuid references empresas(id),

  score_burnout numeric(5,2) default 0,
  score_absenteismo numeric(5,2) default 0,
  score_juridico_preditivo numeric(5,2) default 0,
  score_fiscalizacao numeric(5,2) default 0,
  score_turnover numeric(5,2) default 0,
  score_psicossocial numeric(5,2) default 0,
  score_risco_geral numeric(5,2) default 0,

  nivel_burnout text default 'baixo',
  nivel_absenteismo text default 'baixo',
  nivel_juridico text default 'baixo',
  nivel_fiscalizacao text default 'baixo',
  nivel_turnover text default 'baixo',
  nivel_psicossocial text default 'baixo',
  nivel_risco_geral text default 'baixo',

  tendencia text default 'estavel',

  principais_fatores jsonb,
  recomendacoes jsonb,
  parecer_preditivo text,

  indicadores_base jsonb,

  periodo_referencia date default current_date,

  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create index if not exists idx_predictions_risco_empresa_empresa
on predictions_risco_empresa(empresa_id);

create index if not exists idx_predictions_risco_empresa_nivel
on predictions_risco_empresa(nivel_risco_geral);

create index if not exists idx_predictions_risco_empresa_updated
on predictions_risco_empresa(updated_at desc);

create or replace view vw_predictions_risco_atual as
select distinct on (p.empresa_id)
  p.*,
  e.nome as empresa_nome,
  e.cnpj as empresa_cnpj
from predictions_risco_empresa p
left join empresas e on e.id = p.empresa_id
order by p.empresa_id, p.updated_at desc;

alter table predictions_risco_empresa enable row level security;

drop policy if exists "Liberar leitura predictions_risco_empresa" on predictions_risco_empresa;
drop policy if exists "Liberar insert predictions_risco_empresa" on predictions_risco_empresa;
drop policy if exists "Liberar update predictions_risco_empresa" on predictions_risco_empresa;
drop policy if exists "Liberar delete predictions_risco_empresa" on predictions_risco_empresa;

create policy "Liberar leitura predictions_risco_empresa" on predictions_risco_empresa for select using (true);
create policy "Liberar insert predictions_risco_empresa" on predictions_risco_empresa for insert with check (true);
create policy "Liberar update predictions_risco_empresa" on predictions_risco_empresa for update using (true) with check (true);
create policy "Liberar delete predictions_risco_empresa" on predictions_risco_empresa for delete using (true);

notify pgrst, 'reload schema';
