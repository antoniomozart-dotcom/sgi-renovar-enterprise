-- =========================================================
-- SGI RENOVAR | COPILOT IA ENTERPRISE
-- Chat conversacional SST, eSocial, GED, OCR, Compliance e NR-01
-- =========================================================

create extension if not exists "pgcrypto";

create table if not exists copilot_conversas (
  id uuid primary key default gen_random_uuid(),
  empresa_id uuid references empresas(id),
  usuario_id uuid,
  titulo text,
  modo text default 'executivo',
  status text default 'ativa',
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists copilot_mensagens (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid references copilot_conversas(id) on delete cascade,
  empresa_id uuid references empresas(id),
  papel text not null, -- user | assistant | system
  conteudo text not null,
  contexto jsonb,
  tokens_estimados integer,
  created_at timestamp with time zone default now()
);

create table if not exists copilot_fila (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid references copilot_conversas(id) on delete cascade,
  mensagem_id uuid references copilot_mensagens(id) on delete cascade,
  empresa_id uuid references empresas(id),
  pergunta text not null,
  modo text default 'executivo',
  status text default 'fila',
  prioridade text default 'media',
  tentativas integer default 0,
  erro_mensagem text,
  started_at timestamp with time zone,
  finished_at timestamp with time zone,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);

create table if not exists copilot_respostas (
  id uuid primary key default gen_random_uuid(),
  conversa_id uuid references copilot_conversas(id) on delete cascade,
  mensagem_id uuid references copilot_mensagens(id) on delete set null,
  empresa_id uuid references empresas(id),
  pergunta text,
  resposta text,
  resumo_contexto text,
  fontes jsonb,
  insights jsonb,
  acoes_sugeridas jsonb,
  modo text,
  modelo_ia text,
  status text default 'gerado',
  payload jsonb,
  created_at timestamp with time zone default now()
);

create index if not exists idx_copilot_conversas_empresa on copilot_conversas(empresa_id);
create index if not exists idx_copilot_mensagens_conversa on copilot_mensagens(conversa_id);
create index if not exists idx_copilot_fila_status on copilot_fila(status);
create index if not exists idx_copilot_respostas_conversa on copilot_respostas(conversa_id);

create or replace view vw_copilot_conversas_resumo as
select
  c.*,
  e.nome as empresa_nome,
  (
    select count(*)
    from copilot_mensagens m
    where m.conversa_id = c.id
  ) as total_mensagens,
  (
    select max(m.created_at)
    from copilot_mensagens m
    where m.conversa_id = c.id
  ) as ultima_mensagem
from copilot_conversas c
left join empresas e on e.id = c.empresa_id;

alter table copilot_conversas enable row level security;
alter table copilot_mensagens enable row level security;
alter table copilot_fila enable row level security;
alter table copilot_respostas enable row level security;

drop policy if exists "Liberar leitura copilot_conversas" on copilot_conversas;
drop policy if exists "Liberar insert copilot_conversas" on copilot_conversas;
drop policy if exists "Liberar update copilot_conversas" on copilot_conversas;
create policy "Liberar leitura copilot_conversas" on copilot_conversas for select using (true);
create policy "Liberar insert copilot_conversas" on copilot_conversas for insert with check (true);
create policy "Liberar update copilot_conversas" on copilot_conversas for update using (true) with check (true);

drop policy if exists "Liberar leitura copilot_mensagens" on copilot_mensagens;
drop policy if exists "Liberar insert copilot_mensagens" on copilot_mensagens;
create policy "Liberar leitura copilot_mensagens" on copilot_mensagens for select using (true);
create policy "Liberar insert copilot_mensagens" on copilot_mensagens for insert with check (true);

drop policy if exists "Liberar leitura copilot_fila" on copilot_fila;
drop policy if exists "Liberar insert copilot_fila" on copilot_fila;
drop policy if exists "Liberar update copilot_fila" on copilot_fila;
create policy "Liberar leitura copilot_fila" on copilot_fila for select using (true);
create policy "Liberar insert copilot_fila" on copilot_fila for insert with check (true);
create policy "Liberar update copilot_fila" on copilot_fila for update using (true) with check (true);

drop policy if exists "Liberar leitura copilot_respostas" on copilot_respostas;
drop policy if exists "Liberar insert copilot_respostas" on copilot_respostas;
create policy "Liberar leitura copilot_respostas" on copilot_respostas for select using (true);
create policy "Liberar insert copilot_respostas" on copilot_respostas for insert with check (true);

notify pgrst, 'reload schema';
