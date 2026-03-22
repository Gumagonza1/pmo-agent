'use strict';

/**
 * pmo-agent — Agente PMO del Ecosistema Aragón
 *
 * Proceso PM2 que:
 * 1. Monitorea la cola SQLite para instrucciones PMO (!pmo) y autocorrecciones
 * 2. Spawns claude -p (plan Max, sin API key) con MCP project servers
 * 3. Escribe resultados de vuelta a la cola → telegram-dispatcher → admin
 *
 * Flujo:
 *   Admin envía "!pmo tacos-bot: agrega validación de RFC en pedidos"
 *     → telegram-dispatcher escribe en mensajes_responses id='pmo-...'
 *     → pmo-agent lee, identifica proyecto, spawns claude -p
 *     → claude usa MCP tools para leer/editar código
 *     → resultado se encola → telegram-dispatcher → admin
 *
 *   Monitor detecta error repetido
 *     → monitor escribe en mensajes_queue con origen='autocorrect'
 *     → pmo-agent lee, spawns claude -p con prompt autocorrect.md
 *     → claude diagnostica, corrige, reinicia, verifica
 *     → resultado se encola → admin recibe reporte
 */

const Database = require('better-sqlite3');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const { ejecutarClaude, getSesionInfo, resetSesion, estaEjecutando } = require('./claude-runner');
const {
  PROYECTOS,
  MENSAJES_DB,
  STATE_DIR,
  POLL_INTERVAL_MS,
  MAX_CONCURRENT,
  COOLDOWN_MS,
} = require('./config');

// ── Estado ────────────────────────────────────────────────────────────────

let ejecutando   = 0;
const cooldowns  = new Map(); // proyecto → timestamp último fix

// ── Base de datos ─────────────────────────────────────────────────────────

let _db = null;

function obtenerDb() {
  if (_db) return _db;
  _db = new Database(MENSAJES_DB);
  _db.pragma('journal_mode = WAL');
  _db.pragma('busy_timeout = 5000');

  // Tabla para trackear ejecuciones del PMO
  _db.exec(`
    CREATE TABLE IF NOT EXISTS pmo_ejecuciones (
      id          TEXT PRIMARY KEY,
      tipo        TEXT NOT NULL,
      proyecto    TEXT NOT NULL,
      instruccion TEXT NOT NULL,
      resultado   TEXT,
      estado      TEXT NOT NULL DEFAULT 'ejecutando',
      ts_inicio   INTEGER NOT NULL,
      ts_fin      INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pmo_estado ON pmo_ejecuciones(estado);
  `);

  return _db;
}

// ── Utilidades ────────────────────────────────────────────────────────────

function generarId(prefijo) {
  return `${prefijo}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function log(msg) {
  const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Hermosillo' });
  console.log(`[${ahora}] [pmo-agent] ${msg}`);
}

function encolarRespuesta(mensaje, origen) {
  const db = obtenerDb();
  const id = generarId('pmo');
  db.prepare(`
    INSERT OR REPLACE INTO mensajes_queue (id, tipo, mensaje, origen, enviado, ts)
    VALUES (?, 'texto', ?, ?, 0, ?)
  `).run(id, mensaje.slice(0, 4096), origen || 'pmo', Date.now());
}

function enCooldown(proyecto) {
  const ts = cooldowns.get(proyecto);
  if (!ts) return false;
  return (Date.now() - ts) < COOLDOWN_MS;
}

// ── Identificar proyecto desde texto ──────────────────────────────────────

function identificarProyecto(texto) {
  const textoLower = texto.toLowerCase();

  // Buscar mención directa del nombre PM2
  for (const [nombre, config] of Object.entries(PROYECTOS)) {
    if (textoLower.includes(nombre.toLowerCase())) {
      return { nombre, config };
    }
  }

  // Aliases comunes
  const aliases = {
    'bot':        'TacosAragon',
    'whatsapp':   'TacosAragon',
    'tacos':      'TacosAragon',
    'taqueria':   'TacosAragon',
    'monitor':    'MonitorBot',
    'api':        'tacos-api',
    'telegram':   'telegram-dispatcher',
    'cfo':        'cfo-agent',
    'fiscal':     'cfo-agent',
    'portfolio':  'portfolio-aragon',
    'portafolio': 'portfolio-aragon',
  };

  for (const [alias, nombre] of Object.entries(aliases)) {
    if (textoLower.includes(alias)) {
      return { nombre, config: PROYECTOS[nombre] };
    }
  }

  return null;
}

// ── Procesar instrucción PMO del admin ────────────────────────────────────

async function procesarInstruccionPMO(texto) {
  const textoLower = texto.toLowerCase().trim();

  // Comando: listar proyectos disponibles
  if (textoLower === 'proyectos' || textoLower === 'lista' || textoLower === 'help' || textoLower === 'ayuda') {
    const lineas = Object.entries(PROYECTOS).map(([nombre, cfg]) => {
      const estado = enCooldown(nombre) ? '⏳' : '✅';
      const puerto = cfg.puerto ? ` :${cfg.puerto}` : '';
      const critico = cfg.critico ? ' ⚠️' : '';
      return `${estado} *${nombre}*${puerto}${critico}\n    ${cfg.descripcion}`;
    });

    encolarRespuesta(
      `PMO — Proyectos disponibles:\n\n` +
      lineas.join('\n\n') +
      `\n\n` +
      `✅ disponible  ⏳ cooldown  ⚠️ crítico\n\n` +
      `Uso: !pmo [proyecto]: [instrucción]\n` +
      `Ej: !pmo tacos-api: agrega endpoint /health`,
      'pmo'
    );
    return;
  }

  // Comando: ver sesión activa
  if (textoLower === 'sesion' || textoLower === 'session' || textoLower === 'contexto') {
    const info = getSesionInfo();
    if (!info) {
      encolarRespuesta('PMO — No hay sesión activa. Se creará una nueva con tu próximo mensaje.\n\nLas sesiones duran 1 hora y mantienen contexto entre mensajes.', 'pmo');
    } else {
      const fecha = new Date(info.creadoEn).toLocaleString('es-MX', { timeZone: 'America/Hermosillo' });
      encolarRespuesta(
        `PMO — Sesión activa\n\n` +
        `🕐 Creada: ${fecha}\n` +
        `⏳ Expira en: ${info.restanteMin} min\n` +
        `💬 Mensajes: ${info.mensajes}\n` +
        `📦 Proyectos tocados: ${info.proyectos.length > 0 ? info.proyectos.join(', ') : '(ninguno aún)'}\n\n` +
        `Claude recuerda TODO lo que has hablado en esta sesión.\n` +
        `Para empezar de cero: !pmo nueva sesion`,
        'pmo'
      );
    }
    return;
  }

  // Comando: resetear sesión
  if (textoLower === 'nueva sesion' || textoLower === 'reset' || textoLower === 'nuevo contexto') {
    resetSesion();
    encolarRespuesta('PMO — Sesión reseteada. El próximo mensaje creará un contexto nuevo.', 'pmo');
    return;
  }

  // Comando: estado de ejecuciones
  if (textoLower === 'estado' || textoLower === 'status') {
    const db = obtenerDb();
    const recientes = db.prepare(`
      SELECT tipo, proyecto, estado, ts_inicio, ts_fin
      FROM pmo_ejecuciones ORDER BY ts_inicio DESC LIMIT 5
    `).all();

    if (recientes.length === 0) {
      encolarRespuesta('PMO — Sin ejecuciones recientes.', 'pmo');
      return;
    }

    const lineas = recientes.map(r => {
      const fecha = new Date(r.ts_inicio).toLocaleString('es-MX', { timeZone: 'America/Hermosillo' });
      const icon = r.estado === 'completado' ? '✅' : r.estado === 'ejecutando' ? '🔄' : '❌';
      return `${icon} [${r.tipo}] ${r.proyecto} — ${fecha}`;
    });

    encolarRespuesta(
      `PMO — Últimas ejecuciones:\n\n` + lineas.join('\n') +
      `\n\nActivas: ${ejecutando}/${MAX_CONCURRENT}`,
      'pmo'
    );
    return;
  }

  const proyecto = identificarProyecto(texto);

  if (!proyecto) {
    encolarRespuesta(
      'PMO — No pude identificar el proyecto. Proyectos disponibles:\n' +
      Object.keys(PROYECTOS).map(p => `• ${p}`).join('\n') +
      '\n\nEjemplo: !pmo tacos-api: agrega endpoint /health',
      'pmo'
    );
    return;
  }

  if (ejecutando >= MAX_CONCURRENT) {
    encolarRespuesta(`PMO — Ya hay una ejecución en curso. Espera a que termine.`, 'pmo');
    return;
  }

  ejecutando++;
  const ejecId = generarId('pmo-exec');
  const db = obtenerDb();

  // Registrar ejecución
  db.prepare(`
    INSERT INTO pmo_ejecuciones (id, tipo, proyecto, instruccion, estado, ts_inicio)
    VALUES (?, 'instruccion', ?, ?, 'ejecutando', ?)
  `).run(ejecId, proyecto.nombre, texto, Date.now());

  const tsInicio = Date.now();
  log(`Ejecutando instrucción PMO para ${proyecto.nombre}: ${texto.slice(0, 80)}...`);
  encolarRespuesta(`🚀 PMO [${proyecto.nombre}] — Iniciando...\n\n📋 "${texto.slice(0, 200)}"`, 'pmo');

  // Control de progreso: enviar updates a Telegram sin repetir el mismo mensaje
  let ultimaFase = '';
  function onProgress(fase) {
    if (fase === ultimaFase) return;
    ultimaFase = fase;
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`  [${proyecto.nombre}] ${fase} (${elapsed}s)`);
    encolarRespuesta(`${fase}\n⏱️ ${proyecto.nombre} — ${elapsed}s`, 'pmo');
  }

  try {
    const resultado = await ejecutarClaude({
      promptFile: 'pmo-instruction.md',
      userPrompt: [
        `Proyecto: ${proyecto.nombre}`,
        `PM2: ${proyecto.config.pm2}`,
        `Directorio: ${proyecto.config.root}`,
        proyecto.config.puerto ? `Puerto HTTP: ${proyecto.config.puerto}` : '',
        `MCP Server: ${proyecto.config.mcp}`,
        '',
        'Instrucción del administrador:',
        texto,
        '',
        `IMPORTANTE: Usa SOLO las herramientas del MCP server "${proyecto.config.mcp}" para operar en este proyecto.`,
      ].filter(Boolean).join('\n'),
      projectName: proyecto.config.mcp,
      cwd: proyecto.config.root,
      onProgress,
    });

    const elapsed = Math.round((Date.now() - tsInicio) / 1000);

    // Guardar resultado
    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = ?, ts_fin = ? WHERE id = ?
    `).run(resultado.output.slice(0, 10000), resultado.ok ? 'completado' : 'error', Date.now(), ejecId);

    // Enviar reporte al admin con info de sesión
    const icon = resultado.ok ? '✅' : '❌';
    const sesInfo = getSesionInfo();
    const sesTag = sesInfo ? `\n🔗 Sesión: msg #${sesInfo.mensajes}, ${sesInfo.restanteMin}min restantes` : '';
    const reporte = resultado.ok
      ? `${icon} PMO [${proyecto.nombre}] — Completado (${elapsed}s)${sesTag}\n\n${resultado.output.slice(0, 3700)}`
      : `${icon} PMO [${proyecto.nombre}] — Error (${elapsed}s)${sesTag}\n\n${resultado.output.slice(0, 3700)}`;

    encolarRespuesta(reporte, 'pmo');
    log(`Instrucción PMO completada: ${resultado.ok ? 'OK' : 'ERROR'} (${elapsed}s)`);

  } catch (err) {
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`Error en instrucción PMO: ${err.message}`);
    encolarRespuesta(`❌ PMO [${proyecto.nombre}] — ERROR INTERNO (${elapsed}s)\n\n${err.message}`, 'pmo');
    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = 'error', ts_fin = ? WHERE id = ?
    `).run(err.message, Date.now(), ejecId);
  } finally {
    ejecutando--;
  }
}

// ── Procesar autocorrección (trigger del monitor) ─────────────────────────

async function procesarAutocorrect(item) {
  // item viene de mensajes_queue con origen='autocorrect'
  // mensaje formato: "AUTOCORRECT|<proyecto>|<error_details>"
  const partes = item.mensaje.split('|');
  if (partes.length < 3) {
    log(`Autocorrect: formato inválido — ${item.mensaje.slice(0, 100)}`);
    return;
  }

  const proyectoNombre = partes[1].trim();
  const errorDetails   = partes.slice(2).join('|').trim();
  const config         = PROYECTOS[proyectoNombre];

  if (!config) {
    log(`Autocorrect: proyecto desconocido — ${proyectoNombre}`);
    encolarRespuesta(`AUTOCORRECT — Proyecto "${proyectoNombre}" no reconocido`, 'pmo');
    return;
  }

  if (enCooldown(proyectoNombre)) {
    log(`Autocorrect: ${proyectoNombre} en cooldown, ignorando`);
    return;
  }

  if (ejecutando >= MAX_CONCURRENT) {
    log(`Autocorrect: ya hay ejecución en curso, posponiendo`);
    return; // Se reintentará en el siguiente ciclo
  }

  ejecutando++;
  cooldowns.set(proyectoNombre, Date.now());

  const ejecId = generarId('autocorrect');
  const db = obtenerDb();

  db.prepare(`
    INSERT INTO pmo_ejecuciones (id, tipo, proyecto, instruccion, estado, ts_inicio)
    VALUES (?, 'autocorrect', ?, ?, 'ejecutando', ?)
  `).run(ejecId, proyectoNombre, errorDetails.slice(0, 5000), Date.now());

  const tsInicio = Date.now();
  log(`Autocorrect iniciado para ${proyectoNombre}`);
  encolarRespuesta(`🔧 AUTOCORRECT [${proyectoNombre}] — Iniciando diagnóstico...\n\n⚠️ Error: ${errorDetails.slice(0, 200)}`, 'pmo');

  let ultimaFase = '';
  function onProgress(fase) {
    if (fase === ultimaFase) return;
    ultimaFase = fase;
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`  [autocorrect:${proyectoNombre}] ${fase} (${elapsed}s)`);
    encolarRespuesta(`${fase}\n⏱️ autocorrect ${proyectoNombre} — ${elapsed}s`, 'pmo');
  }

  try {
    const resultado = await ejecutarClaude({
      promptFile: 'autocorrect.md',
      userPrompt: [
        `Proyecto: ${proyectoNombre}`,
        `PM2: ${config.pm2}`,
        `Directorio: ${config.root}`,
        config.puerto ? `Puerto HTTP: ${config.puerto}` : '',
        `MCP Server: ${config.mcp}`,
        `Crítico: ${config.critico ? 'SÍ' : 'No'}`,
        '',
        'Error detectado por el monitor:',
        errorDetails,
        '',
        `IMPORTANTE: Usa SOLO las herramientas del MCP server "${config.mcp}" para operar en este proyecto.`,
      ].filter(Boolean).join('\n'),
      projectName: config.mcp,
      cwd: config.root,
      onProgress,
    });

    const elapsed = Math.round((Date.now() - tsInicio) / 1000);

    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = ?, ts_fin = ? WHERE id = ?
    `).run(resultado.output.slice(0, 10000), resultado.ok ? 'completado' : 'error', Date.now(), ejecId);

    const icon = resultado.ok ? '✅' : '❌';
    const reporte = `${icon} AUTOCORRECT [${proyectoNombre}] — ${resultado.ok ? 'Completado' : 'Fallo'} (${elapsed}s)\n\n${resultado.output.slice(0, 3800)}`;
    encolarRespuesta(reporte, 'pmo');
    log(`Autocorrect completado: ${resultado.ok ? 'OK' : 'ERROR'} (${elapsed}s)`);

  } catch (err) {
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`Error en autocorrect: ${err.message}`);
    encolarRespuesta(`❌ AUTOCORRECT [${proyectoNombre}] — ERROR INTERNO (${elapsed}s)\n\n${err.message}`, 'pmo');
    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = 'error', ts_fin = ? WHERE id = ?
    `).run(err.message, Date.now(), ejecId);
  } finally {
    ejecutando--;
  }
}

// ── Ciclo principal ───────────────────────────────────────────────────────

async function procesarCola() {
  if (ejecutando >= MAX_CONCURRENT) return;

  const db = obtenerDb();

  // 1. Buscar instrucciones PMO del admin (mensajes_responses con id que empieza con 'pmo')
  const instrucciones = db.prepare(`
    SELECT rowid, * FROM mensajes_responses
    WHERE id LIKE 'pmo%' AND procesado = 0
    ORDER BY ts ASC LIMIT 1
  `).all();

  for (const instr of instrucciones) {
    try {
      await procesarInstruccionPMO(instr.texto);
    } catch (err) {
      log(`Error procesando instrucción PMO: ${err.message}`);
      encolarRespuesta(`❌ PMO — Error interno: ${err.message}`, 'pmo');
    } finally {
      // Marcar procesado DESPUÉS de ejecutar (exitoso o no) para no re-procesar
      db.prepare(`UPDATE mensajes_responses SET procesado = 1 WHERE rowid = ?`).run(instr.rowid);
    }
  }

  // 2. Buscar autocorrecciones del monitor (mensajes_queue con origen='autocorrect')
  const autocorrects = db.prepare(`
    SELECT * FROM mensajes_queue
    WHERE origen = 'autocorrect' AND enviado = 0
    ORDER BY ts ASC LIMIT 1
  `).all();

  for (const item of autocorrects) {
    try {
      await procesarAutocorrect(item);
    } catch (err) {
      log(`Error procesando autocorrect: ${err.message}`);
      encolarRespuesta(`❌ AUTOCORRECT — Error interno: ${err.message}`, 'pmo');
    } finally {
      db.prepare(`UPDATE mensajes_queue SET enviado = 1 WHERE id = ?`).run(item.id);
    }
  }
}

// ── Inicio ────────────────────────────────────────────────────────────────

function iniciar() {
  // Crear directorio de estado
  fs.mkdirSync(STATE_DIR, { recursive: true });

  log('Iniciando...');
  log(`DB: ${MENSAJES_DB}`);
  log(`Proyectos: ${Object.keys(PROYECTOS).join(', ')}`);
  log(`Poll: cada ${POLL_INTERVAL_MS / 1000}s`);
  log(`Cooldown: ${COOLDOWN_MS / 1000}s entre correcciones del mismo servicio`);

  // Inicializar DB
  obtenerDb();

  // Ciclo de polling
  setInterval(async () => {
    try {
      await procesarCola();
    } catch (err) {
      log(`Error en ciclo: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  // Primer ciclo inmediato
  procesarCola().catch(err => log(`Error en primer ciclo: ${err.message}`));
}

iniciar();
