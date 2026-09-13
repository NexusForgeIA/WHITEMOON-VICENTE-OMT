/* Panel del artista · Vicente One More Time
   Login real con Supabase Auth. Los permisos NO se deciden aquí: los impone el RLS
   (vomt_es_admin). Este archivo solo muestra la vista adecuada y traduce errores. */
(() => {
'use strict';

const $ = (s) => document.querySelector(s);

if (!window.supabase || !window.VOMT_CONFIG) {
  $('#view-cargando').textContent = 'No se ha podido cargar el panel. Revisa tu conexión y recarga la página.';
  return;
}

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.VOMT_CONFIG;
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const BUCKET = 'vomt-flyers';
const MAX_BYTES = 5 * 1024 * 1024;
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isHttp = (u) => /^https?:\/\/\S+$/i.test(u || '');
const hoyMadrid = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const fechaLarga = (f) => { const [y, m, d] = f.split('-'); return `${d} ${MESES[+m - 1]} ${y}`; };

let usuarioActual = null;
let eventos = [];
let editId = null;
let flyerActual = null; // flyer guardado del evento en edición
let quitarFlyer = false;
let previewUrl = null;

/* ---------- vistas y mensajes ---------- */
function mostrar(vista) {
  for (const v of ['cargando', 'login', 'denegado', 'panel']) $('#view-' + v).hidden = v !== vista;
}

function mensajeError(e) {
  const msg = String(e?.message || e || '');
  const code = String(e?.code || e?.error_code || '');
  if (code === 'invalid_credentials' || /invalid login credentials/i.test(msg)) return 'Email o contraseña incorrectos.';
  if (code === 'email_not_confirmed') return 'Tu email aún no está confirmado.';
  if (code === 'over_request_rate_limit' || /rate limit/i.test(msg)) return 'Demasiados intentos. Espera un minuto y vuelve a probar.';
  if (code === '42501' || code === 'PGRST116' || /row-level security|permission denied|unauthorized/i.test(msg)) return 'Permiso denegado: esta cuenta no puede gestionar la agenda.';
  if (code === '23514') return 'Algún dato no es válido: revisa el nombre y que los enlaces empiecen por http(s)://.';
  if (/exceeded the maximum allowed size|payload too large/i.test(msg)) return 'El archivo supera el tamaño máximo (5 MB).';
  if (/mime type|invalid_mime_type/i.test(msg)) return 'Formato no permitido: usa JPG, PNG o WebP.';
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Sin conexión con el servidor. Revisa tu internet y vuelve a intentarlo.';
  return msg || 'Error inesperado. Vuelve a intentarlo.';
}

function formMsg(texto, tipo = '') {
  const el = $('#formMsg');
  el.textContent = texto;
  el.className = 'msg ' + tipo;
}

let toastTimer;
function toast(texto, tipo = 'ok') {
  const t = $('#toast');
  t.textContent = texto;
  t.className = 'toast show ' + tipo;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 4000);
}

/* ---------- sesión ---------- */
async function enrutar(session) {
  const uid = session?.user?.id || null;
  if (!uid) { usuarioActual = null; mostrar('login'); return; }
  if (uid === usuarioActual) return; // p. ej. refresco de token: no reiniciar el panel

  mostrar('cargando');
  const { data: esAdmin, error } = await sb.rpc('vomt_es_admin');
  if (error || esAdmin !== true) {
    usuarioActual = null;
    $('#deniedEmail').textContent = session.user.email || '';
    $('#deniedMsg').textContent = error
      ? mensajeError(error)
      : 'Has iniciado sesión, pero esta cuenta no tiene permiso para gestionar la agenda de Vicente.';
    mostrar('denegado');
    return;
  }
  usuarioActual = uid;
  $('#userEmail').textContent = session.user.email || '';
  resetForm();
  mostrar('panel');
  await cargarEventos();
}

// setTimeout: no se llama a Supabase dentro del callback (evita bloqueos de supabase-js)
sb.auth.onAuthStateChange((_evento, session) => { setTimeout(() => enrutar(session), 0); });

$('#loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = $('#loginBtn');
  $('#loginError').textContent = '';
  btn.disabled = true;
  btn.textContent = 'Entrando…';
  const { error } = await sb.auth.signInWithPassword({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  btn.disabled = false;
  btn.textContent = 'Entrar';
  $('#password').value = '';
  if (error) { $('#loginError').textContent = mensajeError(error); $('#password').focus(); }
});

async function salir() {
  const { error } = await sb.auth.signOut();
  if (error) await sb.auth.signOut({ scope: 'local' }); // sin red: al menos cerrar en este navegador
}
document.querySelectorAll('[data-logout]').forEach((b) => b.addEventListener('click', salir));

/* ---------- listado ---------- */
async function cargarEventos() {
  const lista = $('#eventList');
  lista.dataset.state = 'loading';
  lista.innerHTML = '<li class="empty">Cargando eventos…</li>';
  const { data, error } = await sb.from('vomt_eventos').select('*')
    .order('fecha', { ascending: true }).order('created_at', { ascending: true });
  if (error) {
    lista.dataset.state = 'error';
    lista.innerHTML = `<li class="empty error">${esc(mensajeError(error))} <button type="button" class="btn-s" data-act="reload">Reintentar</button></li>`;
    return;
  }
  eventos = data;
  pintarLista();
}

function pintarLista() {
  const lista = $('#eventList');
  const hoy = hoyMadrid();
  const visibles = eventos.filter((e) => e.estado === 'publicado' && e.fecha >= hoy).length;
  $('#eventCount').textContent = eventos.length ? `${eventos.length} en total · ${visibles} visibles en la web` : '';
  lista.dataset.state = 'ready';
  if (!eventos.length) {
    lista.innerHTML = '<li class="empty">Aún no hay eventos. Crea el primero con el formulario.</li>';
    return;
  }
  lista.innerHTML = eventos.map((e) => {
    const pasado = e.fecha < hoy;
    const pub = e.estado === 'publicado';
    const flyer = isHttp(e.flyer_url) ? e.flyer_url : '';
    const lugar = [e.sala, e.ciudad].filter(Boolean).join(' · ');
    return `
    <li class="item${pasado ? ' past' : ''}" data-id="${esc(e.id)}">
      <div class="thumb">${flyer ? `<img src="${esc(flyer)}" alt="" loading="lazy">` : 'Sin flyer'}</div>
      <div class="info">
        <div class="when"><time datetime="${esc(e.fecha)}">${fechaLarga(e.fecha)}</time>${pasado ? '<span class="tag past">Pasado</span>' : ''}${e.destacado ? '<span class="tag dest">Destacado</span>' : ''}</div>
        <h3 class="ev-name">${esc(e.nombre)}</h3>
        ${lugar ? `<p class="where">${esc(lugar)}</p>` : ''}
        ${isHttp(e.ticket_url) ? `<a class="tklink" href="${esc(e.ticket_url)}" target="_blank" rel="noopener noreferrer">Entradas ↗</a>` : ''}
      </div>
      <div class="side">
        <span class="badge ${pub ? 'publicado' : 'borrador'}">${pub ? 'Publicado' : 'Borrador'}</span>
        <div class="actions">
          <button type="button" class="btn-s" data-act="edit">Editar</button>
          <button type="button" class="btn-s" data-act="toggle">${pub ? 'Pasar a borrador' : 'Publicar'}</button>
          <button type="button" class="btn-s danger" data-act="delete">Borrar</button>
        </div>
      </div>
    </li>`;
  }).join('');
}

$('#eventList').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'reload') { cargarEventos(); return; }
  const id = b.closest('[data-id]')?.dataset.id;
  if (!id) return;
  if (b.dataset.act === 'edit') editar(id);
  else if (b.dataset.act === 'toggle') cambiarEstado(id, b);
  else if (b.dataset.act === 'delete') borrar(id, b);
});

/* ---------- formulario ---------- */
function limpiarPreview() {
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  $('#flyerPreview').hidden = true;
  $('#flyerImg').removeAttribute('src');
}
function verPreview(src) { $('#flyerImg').src = src; $('#flyerPreview').hidden = false; }

function resetForm() {
  $('#eventForm').reset();
  editId = null;
  flyerActual = null;
  quitarFlyer = false;
  limpiarPreview();
  $('#formTitle').textContent = 'Nuevo evento';
  $('#saveBtn').textContent = 'Crear evento';
  $('#cancelEdit').hidden = true;
  formMsg('');
}

function validarFlyer(file) {
  if (!EXT[file.type]) return 'El flyer debe ser JPG, PNG o WebP.';
  if (file.size > MAX_BYTES) return 'El flyer pesa más de 5 MB. Redúcelo y vuelve a intentarlo.';
  return '';
}

$('#flyer').addEventListener('change', (ev) => {
  const file = ev.target.files[0];
  limpiarPreview();
  formMsg('');
  if (!file) { if (flyerActual && !quitarFlyer) verPreview(flyerActual); return; }
  const problema = validarFlyer(file);
  if (problema) {
    formMsg(problema, 'error');
    ev.target.value = '';
    if (flyerActual && !quitarFlyer) verPreview(flyerActual);
    return;
  }
  previewUrl = URL.createObjectURL(file);
  verPreview(previewUrl);
});

$('#flyerRemove').addEventListener('click', () => {
  $('#flyer').value = '';
  limpiarPreview();
  if (flyerActual) quitarFlyer = true;
});

$('#cancelEdit').addEventListener('click', resetForm);

function editar(id) {
  const e = eventos.find((x) => x.id === id);
  if (!e) return;
  resetForm();
  editId = id;
  const f = $('#eventForm');
  f.fecha.value = e.fecha;
  f.nombre.value = e.nombre;
  f.sala.value = e.sala || '';
  f.ciudad.value = e.ciudad || '';
  f.ticket_url.value = e.ticket_url || '';
  f.destacado.checked = e.destacado;
  f.estado.value = e.estado;
  flyerActual = e.flyer_url;
  if (flyerActual) verPreview(flyerActual);
  $('#formTitle').textContent = 'Editar evento';
  $('#saveBtn').textContent = 'Guardar cambios';
  $('#cancelEdit').hidden = false;
  $('#formCard').scrollIntoView({ block: 'start' });
  f.nombre.focus({ preventScroll: true });
}

async function subirFlyer(file) {
  const problema = validarFlyer(file);
  if (problema) throw new Error(problema);
  const path = `flyers/${crypto.randomUUID()}.${EXT[file.type]}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type, cacheControl: '31536000', upsert: false });
  if (error) throw new Error('No se ha podido subir el flyer. ' + mensajeError(error));
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

function borrarFlyer(url) {
  const base = sb.storage.from(BUCKET).getPublicUrl('').data.publicUrl;
  if (!url || !url.startsWith(base)) return; // solo flyers de nuestro bucket
  const path = decodeURIComponent(url.slice(base.length));
  sb.storage.from(BUCKET).remove([path]).then(({ error }) => {
    if (error) console.warn('[VOMT panel] no se pudo borrar el flyer', error);
  });
}

$('#eventForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (!f.reportValidity()) return;
  const ticket = f.ticket_url.value.trim();
  if (ticket && !isHttp(ticket)) { formMsg('El enlace de entradas debe empezar por http:// o https://', 'error'); f.ticket_url.focus(); return; }

  const datos = {
    fecha: f.fecha.value,
    nombre: f.nombre.value.trim(),
    sala: f.sala.value.trim() || null,
    ciudad: f.ciudad.value.trim() || null,
    ticket_url: ticket || null,
    destacado: f.destacado.checked,
    estado: f.estado.value,
  };
  const archivo = f.flyer.files[0];
  const btn = $('#saveBtn');
  btn.disabled = true;
  formMsg('');
  let subido = null;
  try {
    if (archivo) { btn.textContent = 'Subiendo flyer…'; subido = await subirFlyer(archivo); datos.flyer_url = subido; }
    else if (quitarFlyer) datos.flyer_url = null;

    btn.textContent = 'Guardando…';
    const tabla = sb.from('vomt_eventos');
    const { data, error } = editId
      ? await tabla.update(datos).eq('id', editId).select().single()
      : await tabla.insert(datos).select().single();
    if (error) throw error;

    if (editId && flyerActual && flyerActual !== data.flyer_url) borrarFlyer(flyerActual); // flyer sustituido o quitado
    const eraNuevo = !editId;
    resetForm();
    toast(eraNuevo
      ? (data.estado === 'publicado' ? 'Evento creado y publicado en la web.' : 'Evento creado como borrador (oculto en la web).')
      : 'Cambios guardados.');
    await cargarEventos();
  } catch (e) {
    if (subido) borrarFlyer(subido); // no dejar flyers huérfanos si falla el guardado
    formMsg(mensajeError(e), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = editId ? 'Guardar cambios' : 'Crear evento';
  }
});

/* ---------- acciones rápidas ---------- */
async function cambiarEstado(id, boton) {
  const e = eventos.find((x) => x.id === id);
  if (!e) return;
  const nuevo = e.estado === 'publicado' ? 'borrador' : 'publicado';
  boton.disabled = true;
  const { error } = await sb.from('vomt_eventos').update({ estado: nuevo }).eq('id', id).select('id').single();
  boton.disabled = false;
  if (error) { toast(mensajeError(error), 'error'); return; }
  toast(nuevo === 'publicado' ? 'Publicado: ya se ve en la web.' : 'Pasado a borrador: oculto en la web.');
  if (editId === id) $('#eventForm').estado.value = nuevo;
  await cargarEventos();
}

async function borrar(id, boton) {
  if (boton.dataset.confirm !== '1') { // doble clic de confirmación, sin diálogos bloqueantes
    boton.dataset.confirm = '1';
    boton.textContent = '¿Seguro? Borrar';
    boton.classList.add('armed');
    setTimeout(() => {
      if (!boton.isConnected) return;
      boton.dataset.confirm = '';
      boton.textContent = 'Borrar';
      boton.classList.remove('armed');
    }, 4000);
    return;
  }
  const e = eventos.find((x) => x.id === id);
  boton.disabled = true;
  const { data, error } = await sb.from('vomt_eventos').delete().eq('id', id).select('id');
  if (error || !data?.length) {
    boton.disabled = false;
    toast(error ? mensajeError(error) : 'Permiso denegado: no se ha podido borrar.', 'error');
    return;
  }
  if (e?.flyer_url) borrarFlyer(e.flyer_url);
  if (editId === id) resetForm();
  toast('Evento borrado.');
  await cargarEventos();
}
})();
