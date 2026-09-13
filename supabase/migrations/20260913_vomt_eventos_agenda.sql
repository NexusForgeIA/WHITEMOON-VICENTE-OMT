-- VOMT · Agenda de eventos de Vicente One More Time
-- Proyecto compartido: la escritura NO se abre a cualquier "authenticated"
-- (hay usuarios de otros clientes); solo a los user_id dados de alta en vomt_admins.

-- 1) Admins del panel del artista (alta solo con service_role)
create table public.vomt_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.vomt_admins is 'Usuarios de Auth que gestionan la agenda VOMT desde el panel. Alta solo con service_role; sin políticas = invisible desde el cliente.';
alter table public.vomt_admins enable row level security;

create or replace function public.vomt_es_admin()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.vomt_admins where user_id = (select auth.uid()));
$$;
revoke all on function public.vomt_es_admin() from public, anon;
grant execute on function public.vomt_es_admin() to authenticated;

-- 2) Eventos
create table public.vomt_eventos (
  id uuid primary key default gen_random_uuid(),
  fecha date not null,
  nombre text not null check (char_length(nombre) between 1 and 120),
  sala text,
  ciudad text,
  ticket_url text check (ticket_url is null or ticket_url ~* '^https?://'),
  flyer_url text check (flyer_url is null or flyer_url ~* '^https?://'),
  destacado boolean not null default false,
  estado text not null default 'borrador' check (estado in ('publicado','borrador')),
  created_at timestamptz not null default now()
);
comment on table public.vomt_eventos is 'Agenda VOMT. Lectura anon solo estado=publicado; escritura solo vomt_es_admin().';
create index vomt_eventos_estado_fecha_idx on public.vomt_eventos (estado, fecha);
alter table public.vomt_eventos enable row level security;

grant select on public.vomt_eventos to anon, authenticated;
grant insert, update, delete on public.vomt_eventos to authenticated;

create policy vomt_eventos_select_publico on public.vomt_eventos
  for select to anon using (estado = 'publicado');
create policy vomt_eventos_select_auth on public.vomt_eventos
  for select to authenticated using (estado = 'publicado' or (select public.vomt_es_admin()));
create policy vomt_eventos_insert_admin on public.vomt_eventos
  for insert to authenticated with check ((select public.vomt_es_admin()));
create policy vomt_eventos_update_admin on public.vomt_eventos
  for update to authenticated using ((select public.vomt_es_admin())) with check ((select public.vomt_es_admin()));
create policy vomt_eventos_delete_admin on public.vomt_eventos
  for delete to authenticated using ((select public.vomt_es_admin()));

-- 3) Storage de flyers: lectura pública por URL, sin listado; escritura solo admins
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vomt-flyers', 'vomt-flyers', true, 5242880, array['image/jpeg','image/png','image/webp']);

create policy vomt_flyers_select_admin on storage.objects
  for select to authenticated using (bucket_id = 'vomt-flyers' and (select public.vomt_es_admin()));
create policy vomt_flyers_insert_admin on storage.objects
  for insert to authenticated with check (bucket_id = 'vomt-flyers' and (select public.vomt_es_admin()));
create policy vomt_flyers_update_admin on storage.objects
  for update to authenticated using (bucket_id = 'vomt-flyers' and (select public.vomt_es_admin()))
  with check (bucket_id = 'vomt-flyers' and (select public.vomt_es_admin()));
create policy vomt_flyers_delete_admin on storage.objects
  for delete to authenticated using (bucket_id = 'vomt-flyers' and (select public.vomt_es_admin()));

-- 4) vomt_admins solo se gestiona con service_role: fuera de la API pública
revoke all on public.vomt_admins from anon, authenticated;
