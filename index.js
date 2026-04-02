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

const { execSync } = require('child_process');

// ── Historial de cambios ──────────────────────────────────────────────────
const CHANGELOG_DIR = 'C:/SesionBot/changelogs';

function obtenerCambiosRecientes(limit = 15) {
  try {
    if (!fs.existsSync(CHANGELOG_DIR)) return '';
    const files = fs.readdirSync(CHANGELOG_DIR).filter(f => f.endsWith('.jsonl'));
    const entries = [];
    for (const file of files) {
      const lines = fs.readFileSync(path.join(CHANGELOG_DIR, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch {}
      }
    }
    entries.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    const recent = entries.slice(0, limit);
    if (recent.length === 0) return '';
    return recent.map(e =>
      `[${e.ts}] ${e.agente} (${e.origen}): ${e.titulo} | ${e.desc?.slice(0, 120)} | tags: ${(e.tags||[]).join(',')}`
    ).join('\n');
  } catch {
    return '';
  }
}

function contarEntradasDesde(tsInicio) {
  try {
    if (!fs.existsSync(CHANGELOG_DIR)) return 0;
    const files = fs.readdirSync(CHANGELOG_DIR).filter(f => f.endsWith('.jsonl'));
    let count = 0;
    for (const file of files) {
      const lines = fs.readFileSync(path.join(CHANGELOG_DIR, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line);
          if (e.ts && new Date(e.ts).getTime() >= tsInicio) count++;
        } catch {}
      }
    }
    return count;
  } catch {
    return 0;
  }
}
const { ejecutarClaude, getSesionInfo, getAllSesionesInfo, resetSesion, resetSesionProyecto, estaEjecutando, limpiarProcesoHuerfano } = require('./claude-runner');
const {
  PROYECTOS,
  TOPICS,
  MENSAJES_DB,
  STATE_DIR,
  POLL_INTERVAL_MS,
  MAX_CONCURRENT,
  COOLDOWN_MS,
  APROBACION_CRITICO_MS,
  APROBACION_NO_CRIT_MS,
  CLAUDE_TIMEOUT_INSTRUCCION_MS,
  CLAUDE_TIMEOUT_DIAGNOSTICO_MS,
  CLAUDE_TIMEOUT_FIX_MS,
  MAX_ERROR_DETAILS_CHARS,
  MIN_DIAGNOSTICO_CHARS,
  MAX_FILES_PER_FIX,
} = require('./config');

// ── Relay de mensajes de otros agentes → PMO ──────────────────────────────

const PREFIJOS_RELAY = {
  orquestador: '⚙️ [Orquestador]',
  cfo:         '💰 [CFO]',
};

// ── Estado ────────────────────────────────────────────────────────────────

let ejecutando            = 0;
const proyectosEjecutando = new Set(); // proyectos con ejecución activa
const cooldowns           = new Map(); // proyecto → timestamp último fix

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

// ── Seguridad auto-healing ─────────────────────────────────────────────────

// Capa 1: Sanitizar texto externo antes de mandarlo al modelo.
// Evita inyecciones de prompt en errorDetails del monitor y en mensajes del admin.
function sanitizarTexto(raw, maxChars) {
  let s = String(raw || '').slice(0, maxChars);
  s = s.replace(/={3,}/g, '---');                                    // Romper delimitadores de sección
  s = s.replace(/\[(INSTRUCCIONES?|TAREA|SISTEMA)\]/gi, '[INFO]');   // Neutralizar palabras clave de prompt
  s = s.replace(/\x00/g, '');                                        // Eliminar null bytes
  return s.trim();
}

// Alias específico para errorDetails del monitor
function sanitizarErrorDetails(raw) {
  return sanitizarTexto(raw, MAX_ERROR_DETAILS_CHARS);
}

// Capa 5: Validar diagnóstico estructurado.
// El prompt de diagnóstico exige formato: DIAGNOSTICO|severidad|archivo|linea|desc|fix
// Si el modelo no lo respeta o la severidad es BAJO, no se propone fix automático.
const RE_DIAGNOSTICO = /DIAGNOSTICO\|(CRITICO|ALTO|MEDIO|BAJO)\|([^|]+)\|(\d+)\|([^|]+)\|(.+)/i;

function parsearDiagnostico(texto) {
  const match = texto.match(RE_DIAGNOSTICO);
  if (!match) return null;
  return {
    severidad:    match[1].toUpperCase(),
    archivo:      match[2].trim(),
    linea:        parseInt(match[3], 10),
    descripcion:  match[4].trim(),
    fixPropuesto: match[5].trim(),
  };
}

function diagnosticoValido(texto) {
  if (!texto || texto.length < MIN_DIAGNOSTICO_CHARS) return false;
  // Si tiene el formato estructurado, es válido (incluso BAJO, lo manejamos aparte)
  if (RE_DIAGNOSTICO.test(texto)) return true;
  // Fallback: texto libre con palabras técnicas (compatibilidad)
  const lower = texto.toLowerCase();
  const PALABRAS = ['causa', 'error', 'fix', 'cambio', 'archivo', 'línea', 'problema', 'soluci', 'fallo', 'log'];
  return PALABRAS.some(p => lower.includes(p));
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

// ── Procesar mensaje de un topic del grupo ────────────────────────────────

async function procesarMensajeTopic(topicId, textoRaw) {
  const texto = sanitizarTexto(textoRaw, 4000); // Capa 1: sanitizar input del admin
  const topicConfig = TOPICS[topicId];
  if (!topicConfig) {
    log(`Topic desconocido: ${topicId}`);
    encolarRespuesta(`Topic ${topicId} no configurado.`, 'pmo');
    return;
  }

  const { proyecto: proyectoNombre, prompt: promptFile, nombre: topicNombre } = topicConfig;

  // Si no tiene proyecto asignado (General), usar el flujo PMO normal
  if (!proyectoNombre) {
    return procesarInstruccionPMO(texto);
  }

  const config = PROYECTOS[proyectoNombre];
  if (!config) {
    log(`Proyecto no encontrado para topic ${topicNombre}: ${proyectoNombre}`);
    encolarRespuesta(`Proyecto ${proyectoNombre} no configurado.`, 'pmo');
    return;
  }

  if (ejecutando >= MAX_CONCURRENT) {
    encolarRespuesta(`⏳ Hay una ejecución en curso. Tu mensaje en ${topicNombre} se procesará cuando termine.`, 'pmo');
    return;
  }

  ejecutando++;
  proyectosEjecutando.add(proyectoNombre);
  const ejecId = generarId('topic');
  const db = obtenerDb();

  db.prepare(`
    INSERT INTO pmo_ejecuciones (id, tipo, proyecto, instruccion, estado, ts_inicio)
    VALUES (?, 'topic', ?, ?, 'ejecutando', ?)
  `).run(ejecId, proyectoNombre, texto, Date.now());

  const tsInicio = Date.now();
  log(`[${topicNombre}] Procesando: ${texto.slice(0, 80)}...`);
  encolarRespuesta(`🧠 [${topicNombre}] Procesando...\n\n"${texto.slice(0, 200)}"`, 'pmo');

  let ultimaFase = '';
  function onProgress(fase) {
    if (fase === ultimaFase) return;
    ultimaFase = fase;
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`  [${topicNombre}] ${fase} (${elapsed}s)`);
    encolarRespuesta(`${fase}\n⏱️ ${topicNombre} — ${elapsed}s`, 'pmo');
  }

  try {
    const resultado = await ejecutarClaude({
      promptFile,
      userPrompt: [
        `Proyecto: ${proyectoNombre}`,
        `PM2: ${config.pm2}`,
        `Directorio: ${config.root}`,
        config.puerto ? `Puerto HTTP: ${config.puerto}` : '',
        `MCP Server: ${config.mcp}`,
        '',
        'Mensaje del administrador:',
        texto,
        '',
        `Usa las herramientas del MCP server "${config.mcp}" para operar en este proyecto.`,
      ].filter(Boolean).join('\n'),
      projectName: config.mcp,
      cwd: config.root,
      timeout: CLAUDE_TIMEOUT_INSTRUCCION_MS,
      onProgress,
    });

    const elapsed = Math.round((Date.now() - tsInicio) / 1000);

    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = ?, ts_fin = ? WHERE id = ?
    `).run(resultado.output.slice(0, 10000), resultado.ok ? 'completado' : 'error', Date.now(), ejecId);

    const icon = resultado.ok ? '✅' : '❌';
    const sesInfo = getSesionInfo(config.mcp);
    const sesTag = sesInfo ? `\n🔗 Sesión: msg #${sesInfo.mensajes}, ${sesInfo.restanteMin}min` : '';
    encolarRespuesta(
      `${icon} [${topicNombre}] — ${resultado.ok ? 'Completado' : 'Error'} (${elapsed}s)${sesTag}\n\n${resultado.output.slice(0, 3700)}`,
      'pmo'
    );
    log(`[${topicNombre}] Completado: ${resultado.ok ? 'OK' : 'ERROR'} (${elapsed}s)`);

  } catch (err) {
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`[${topicNombre}] Error: ${err.message}`);
    encolarRespuesta(`❌ [${topicNombre}] — ERROR (${elapsed}s)\n\n${err.message}`, 'pmo');
    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = 'error', ts_fin = ? WHERE id = ?
    `).run(err.message, Date.now(), ejecId);
  } finally {
    ejecutando--;
    proyectosEjecutando.delete(proyectoNombre);
  }
}

// ── Procesar instrucción PMO del admin ────────────────────────────────────

async function procesarInstruccionPMO(textoRaw) {
  const texto = sanitizarTexto(textoRaw, 4000); // Capa 1: sanitizar input del admin
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
    const sesiones = getAllSesionesInfo();
    if (sesiones.length === 0) {
      encolarRespuesta('PMO — No hay sesiones activas. Se creará una nueva con tu próximo mensaje.\n\nLas sesiones duran 1 hora por proyecto.', 'pmo');
    } else {
      const lineas = sesiones.map(s => `📦 ${s.key}: msg #${s.mensajes}, ${s.restanteMin}min restantes`);
      encolarRespuesta(
        `PMO — Sesiones activas (${sesiones.length})\n\n` +
        lineas.join('\n') +
        `\n\nCada proyecto mantiene su propio contexto.\n` +
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

  // Comando: responder a propuesta de autocorrect
  const matchAuto = textoLower.match(/^aplicar\s+(\S+)|^ignorar\s+(\S+)|^revertir\s+(\S+)/);
  if (matchAuto) {
    const propIdCorto = matchAuto[1] || matchAuto[2] || matchAuto[3];
    const accion = matchAuto[1] ? 'aplicar' : matchAuto[2] ? 'ignorar' : 'revertir';
    procesarRespuestaAutocorrect(propIdCorto, accion);
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
  proyectosEjecutando.add(proyecto.nombre);
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
    const cambiosRecientes = obtenerCambiosRecientes(15);
    const argsEjecutar = {
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
        cambiosRecientes ? `\n## Cambios recientes del ecosistema (últimos 15)\n${cambiosRecientes}` : '',
      ].filter(Boolean).join('\n'),
      projectName: proyecto.config.mcp,
      cwd: proyecto.config.root,
      timeout: CLAUDE_TIMEOUT_INSTRUCCION_MS,
      onProgress,
    };

    let resultado = await ejecutarClaude(argsEjecutar);

    // Si la sesión estaba ocupada (exitCode -5), reintentar una vez.
    // La sesión fue invalidada en claude-runner → next call crea UUID nuevo → sin conflicto.
    if (resultado.exitCode === -5) {
      log(`  🔄 [${proyecto.nombre}] Sesión ocupada — reintentando con sesión nueva...`);
      encolarRespuesta(`🔄 PMO [${proyecto.nombre}] — Sesión ocupada, reintentando...`, 'pmo');
      resultado = await ejecutarClaude(argsEjecutar);
    }

    const elapsed = Math.round((Date.now() - tsInicio) / 1000);

    // Guardar resultado
    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = ?, ts_fin = ? WHERE id = ?
    `).run(resultado.output.slice(0, 10000), resultado.ok ? 'completado' : 'error', Date.now(), ejecId);

    // Enviar reporte al admin con info de sesión
    const icon = resultado.ok ? '✅' : '❌';
    const sesInfo = getSesionInfo(proyecto.config.mcp);
    const sesTag = sesInfo ? `\n🔗 Sesión: msg #${sesInfo.mensajes}, ${sesInfo.restanteMin}min restantes` : '';
    const reporte = resultado.ok
      ? `${icon} PMO [${proyecto.nombre}] — Completado (${elapsed}s)${sesTag}\n\n${resultado.output.slice(0, 3700)}`
      : `${icon} PMO [${proyecto.nombre}] — Error (${elapsed}s)${sesTag}\n\n${resultado.output.slice(0, 3700)}`;

    encolarRespuesta(reporte, 'pmo');
    log(`Instrucción PMO completada: ${resultado.ok ? 'OK' : 'ERROR'} (${elapsed}s)`);

    // Verificación post: detectar si Claude olvidó llamar log_change
    if (resultado.ok) {
      const nuevasEntradas = contarEntradasDesde(tsInicio);
      if (nuevasEntradas === 0) {
        log(`⚠️ PMO terminó sin registrar en changelog (puede ser consulta sin cambios)`);
      }
    }

  } catch (err) {
    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    log(`Error en instrucción PMO: ${err.message}`);
    encolarRespuesta(`❌ PMO [${proyecto.nombre}] — ERROR INTERNO (${elapsed}s)\n\n${err.message}`, 'pmo');
    db.prepare(`
      UPDATE pmo_ejecuciones SET resultado = ?, estado = 'error', ts_fin = ? WHERE id = ?
    `).run(err.message, Date.now(), ejecId);
  } finally {
    ejecutando--;
    proyectosEjecutando.delete(proyecto.nombre);
  }
}

// ── Sistema de propuestas de autocorrección ───────────────────────────────

const propuestasPendientes = new Map(); // propuestaId → { proyecto, diagnostico, ejecId, timer, config }

function procesarRespuestaAutocorrect(propId, accion) {
  const prop = propuestasPendientes.get(propId);
  if (!prop) {
    log(`Propuesta ${propId} no encontrada o ya expiró`);
    return;
  }

  clearTimeout(prop.timer);
  // Gap 1 fix: borrar ambas claves (larga y corta) para evitar double-action
  propuestasPendientes.delete(prop.propId     || propId);
  propuestasPendientes.delete(prop.propIdCorto || propId);

  if (accion === 'aplicar') {
    log(`[autocorrect] ${prop.proyecto} — Admin aprobó. Aplicando fix...`);
    aplicarFix(prop).catch(err => log(`Error aplicando fix: ${err.message}`));
  } else if (accion === 'ignorar') {
    log(`[autocorrect] ${prop.proyecto} — Admin ignoró la propuesta`);
    encolarRespuesta(`🚫 AUTOCORRECT [${prop.proyecto}] — Ignorado por admin`, 'pmo');
    const db = obtenerDb();
    db.prepare(`UPDATE pmo_ejecuciones SET estado = 'ignorado', ts_fin = ? WHERE id = ?`).run(Date.now(), prop.ejecId);
  } else if (accion === 'revertir') {
    log(`[autocorrect] ${prop.proyecto} — Admin pidió revertir`);
    revertirFix(prop).catch(err => log(`Error revirtiendo: ${err.message}`));
  }
}

async function aplicarFix(prop) {
  const { proyecto: proyectoNombre, config, diagnostico, ejecId, errorDetails } = prop;

  // Capa 3: Git stash antes de cualquier cambio (independiente de la IA)
  let stashLabel = null;
  try {
    // Gap 3 fix: no interpolar variables en el string de shell — usar timestamp fijo
    const stashMsg = `pmo-autocorrect-${Date.now()}`;
    const stashOut = execSync(
      `git stash push -u -m "${stashMsg}"`,
      { cwd: config.root, timeout: 15000, encoding: 'utf8', stdio: 'pipe' }
    ).trim();
    stashLabel = stashMsg;
    prop.stashLabel = stashLabel; // guardar en propData para que revertirFix pueda usarlo
    log(`[aplicarFix] ${proyectoNombre} — git stash: ${stashOut.slice(0, 100)}`);
  } catch (err) {
    log(`[aplicarFix] ${proyectoNombre} — sin stash (puede no ser repo git): ${err.message.slice(0, 80)}`);
  }

  // Nueva sesión para el fix — evita "Session ID already in use" del diagnóstico previo
  resetSesionProyecto(config.mcp);

  ejecutando++;
  proyectosEjecutando.add(proyectoNombre);
  encolarRespuesta(`🔧 AUTOCORRECT [${proyectoNombre}] — Aplicando fix...`, 'pmo');

  try {
    const resultado = await ejecutarClaude({
      promptFile: 'autocorrect.md',
      userPrompt: [
        `Proyecto: ${proyectoNombre}`,
        `PM2: ${config.pm2}`,
        `Directorio: ${config.root}`,
        config.puerto ? `Puerto HTTP: ${config.puerto}` : '',
        `MCP Server: ${config.mcp}`,
        '',
        'Diagnóstico previo:',
        diagnostico,
        '',
        'Error original:',
        errorDetails,
        '',
        `APLICA el fix descrito en el diagnóstico. Usa las herramientas del MCP server "${config.mcp}".`,
      ].filter(Boolean).join('\n'),
      projectName: config.mcp,
      cwd: config.root,
      timeout: CLAUDE_TIMEOUT_FIX_MS,
    });

    const db = obtenerDb();
    db.prepare(`UPDATE pmo_ejecuciones SET resultado = ?, estado = ?, ts_fin = ? WHERE id = ?`)
      .run(resultado.output.slice(0, 10000), resultado.ok ? 'completado' : 'error', Date.now(), ejecId);

    const icon = resultado.ok ? '✅' : '❌';

    // Capa 7: Contar archivos modificados vs estado previo al fix.
    // Si Claude hizo commit (caso normal): comparar HEAD contra el stash (estado original).
    // Si no hay stash: comparar working tree vs HEAD (cambios sin commitear).
    let alertaArchivos = '';
    if (resultado.ok) {
      try {
        const diffCmd = stashLabel
          ? 'git diff --stat stash@{0} HEAD 2>&1'   // cambios vs estado pre-fix
          : 'git diff --stat HEAD 2>&1';             // fallback: sin commit
        const diffStat = execSync(
          diffCmd,
          { cwd: config.root, timeout: 10000, encoding: 'utf8', stdio: 'pipe' }
        ).trim();
        const changedFiles = diffStat.split('\n').filter(l => l.includes('|')).length;
        if (changedFiles > MAX_FILES_PER_FIX) {
          alertaArchivos = `\n\n⚠️ ${changedFiles} archivos modificados (máx esperado: ${MAX_FILES_PER_FIX}). Revisa:\n${diffStat.slice(0, 600)}`;
          log(`[aplicarFix] ${proyectoNombre} — ALERTA: ${changedFiles} archivos modificados`);
        }
      } catch {}
    }

    const revertirInfo = stashLabel
      ? `Para revertir todo: git stash pop (stash: ${stashLabel.slice(-30)})`
      : `Para revertir: responde "revertir ${proyectoNombre}"`;

    encolarRespuesta(
      `${icon} AUTOCORRECT [${proyectoNombre}] — ${resultado.ok ? 'Fix aplicado' : 'Error al aplicar'}\n\n` +
      `${resultado.output.slice(0, 3000)}${alertaArchivos}\n\n` +
      revertirInfo,
      'pmo'
    );

  } catch (err) {
    encolarRespuesta(`❌ AUTOCORRECT [${proyectoNombre}] — Error aplicando fix: ${err.message}`, 'pmo');
  } finally {
    ejecutando--;
    proyectosEjecutando.delete(proyectoNombre);
  }
}

async function revertirFix(prop) {
  const { proyecto: proyectoNombre, config, stashLabel } = prop;
  log(`[revertir] ${proyectoNombre} — Revirtiendo cambios...`);
  encolarRespuesta(`🔄 Revirtiendo cambios en ${proyectoNombre}...`, 'pmo');

  // Si el fix hizo git stash (Layer 3), revertir con stash pop — no depende de la IA
  if (stashLabel) {
    try {
      const out = execSync(
        'git stash pop',
        { cwd: config.root, timeout: 15000, encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      log(`[revertir] ${proyectoNombre} — git stash pop OK`);
      encolarRespuesta(`✅ Revertir [${proyectoNombre}]: cambios revertidos via git stash pop\n\n${out.slice(0, 800)}`, 'pmo');
      return;
    } catch (err) {
      log(`[revertir] ${proyectoNombre} — git stash pop falló: ${err.message.slice(0, 100)}`);
      encolarRespuesta(`⚠️ git stash pop falló (${err.message.slice(0, 80)}). Intentando con Claude...`, 'pmo');
    }
  }

  // Fallback: pedir a Claude que revierta
  resetSesionProyecto(config.mcp);
  try {
    const resultado = await ejecutarClaude({
      promptFile: 'pmo-instruction.md',
      userPrompt: [
        `Proyecto: ${proyectoNombre}`,
        `PM2: ${config.pm2}`,
        `Directorio: ${config.root}`,
        `MCP Server: ${config.mcp}`,
        '',
        'INSTRUCCIÓN: Revierte TODOS los cambios no commiteados con git checkout . y reinicia el proceso.',
        'Si no tiene git, reporta qué archivos fueron modificados.',
      ].join('\n'),
      projectName: config.mcp,
      cwd: config.root,
    });
    encolarRespuesta(`${resultado.ok ? '✅' : '❌'} Revertir [${proyectoNombre}]: ${resultado.output.slice(0, 3000)}`, 'pmo');
  } catch (err) {
    encolarRespuesta(`❌ Error revirtiendo ${proyectoNombre}: ${err.message}`, 'pmo');
  }
}

// ── Procesar autocorrección (trigger del monitor) ─────────────────────────

async function procesarAutocorrect(item) {
  const partes = item.mensaje.split('|');
  if (partes.length < 3) {
    log(`Autocorrect: formato inválido — ${item.mensaje.slice(0, 100)}`);
    return;
  }

  const proyectoNombre = partes[1].trim();
  const errorDetails   = sanitizarErrorDetails(partes.slice(2).join('|')); // Capa 1
  const config         = PROYECTOS[proyectoNombre];

  if (!config) {
    log(`Autocorrect: proyecto desconocido — ${proyectoNombre}`);
    encolarRespuesta(`AUTOCORRECT — Proyecto "${proyectoNombre}" no reconocido`, 'pmo');
    return true; // procesado (error, no reintentar)
  }

  if (enCooldown(proyectoNombre)) {
    log(`Autocorrect: ${proyectoNombre} en cooldown, ignorando`);
    return false; // NO procesado, reintentar después
  }

  if (ejecutando >= MAX_CONCURRENT) {
    log(`Autocorrect: ya hay ejecución en curso, posponiendo`);
    return false; // NO procesado, reintentar después
  }

  ejecutando++;
  proyectosEjecutando.add(proyectoNombre);
  cooldowns.set(proyectoNombre, Date.now());

  const ejecId = generarId('autocorrect');
  const db = obtenerDb();

  db.prepare(`
    INSERT INTO pmo_ejecuciones (id, tipo, proyecto, instruccion, estado, ts_inicio)
    VALUES (?, 'autocorrect', ?, ?, 'diagnosticando', ?)
  `).run(ejecId, proyectoNombre, errorDetails.slice(0, 5000), Date.now());

  const tsInicio = Date.now();
  log(`[autocorrect] ${proyectoNombre} — Fase 1: Diagnosticando...`);
  encolarRespuesta(`🔍 AUTOCORRECT [${proyectoNombre}] — Diagnosticando...\n\n⚠️ Error: ${errorDetails.slice(0, 200)}`, 'pmo');

  try {
    // ── FASE 1: Solo diagnosticar, NO corregir ──────────────────────────
    const resultado = await ejecutarClaude({
      promptFile: 'autocorrect-diagnostico.md',
      userPrompt: [
        `Proyecto: ${proyectoNombre}`,
        `PM2: ${config.pm2}`,
        `Directorio: ${config.root}`,
        config.puerto ? `Puerto HTTP: ${config.puerto}` : '',
        `MCP Server: ${config.mcp}`,
        '',
        'Error detectado:',
        errorDetails,
        '',
        `Usa las herramientas del MCP server "${config.mcp}" para diagnosticar.`,
      ].filter(Boolean).join('\n'),
      projectName: config.mcp,
      cwd: config.root,
      timeout: CLAUDE_TIMEOUT_DIAGNOSTICO_MS,
    });

    const elapsed = Math.round((Date.now() - tsInicio) / 1000);
    const diagnostico = resultado.output || '(sin diagnóstico)';

    log(`[autocorrect] ${proyectoNombre} — Diagnóstico completado (${elapsed}s)`);

    // Capa 5: Abortar si el diagnóstico no tiene contenido útil (alucinación)
    if (!diagnosticoValido(diagnostico)) {
      log(`[autocorrect] ${proyectoNombre} — Diagnóstico inválido o vacío. Abortando.`);
      encolarRespuesta(
        `⚠️ AUTOCORRECT [${proyectoNombre}] — Diagnóstico insuficiente (${diagnostico.length} chars).\n` +
        `El modelo no identificó causa concreta. Revisa manualmente.\n\n` +
        `Respuesta: ${diagnostico.slice(0, 400)}`,
        'pmo'
      );
      db.prepare(`UPDATE pmo_ejecuciones SET resultado = ?, estado = 'abortado', ts_fin = ? WHERE id = ?`)
        .run(diagnostico.slice(0, 10000), Date.now(), ejecId);
      return true;
    }

    // Guardar diagnóstico
    db.prepare(`UPDATE pmo_ejecuciones SET resultado = ?, estado = 'propuesta' WHERE id = ?`)
      .run(diagnostico.slice(0, 10000), ejecId);

    // ── FASE 2: Proponer con timeout ────────────────────────────────────
    const timeoutMs = config.critico ? APROBACION_CRITICO_MS : APROBACION_NO_CRIT_MS;
    const timeoutMin = Math.round(timeoutMs / 60000);
    const propId = generarId('prop');

    // Capa 5b: parsear formato estructurado y bloquear severidad BAJO
    const diagParseado = parsearDiagnostico(diagnostico);
    if (diagParseado && diagParseado.severidad === 'BAJO') {
      log(`[autocorrect] ${proyectoNombre} — Severidad BAJO. No se propone fix automático.`);
      encolarRespuesta(
        `ℹ️ AUTOCORRECT [${proyectoNombre}] — Severidad BAJO\n\n` +
        `${diagParseado.descripcion}\n\nFix sugerido: ${diagParseado.fixPropuesto}\n\n` +
        `No se aplica automáticamente. Usa !pmo si quieres proceder.`,
        'pmo'
      );
      db.prepare(`UPDATE pmo_ejecuciones SET resultado = ?, estado = 'bajo_severidad', ts_fin = ? WHERE id = ?`)
        .run(diagnostico.slice(0, 10000), Date.now(), ejecId);
      return true;
    }

    // Capa 6: propIdCorto incluye prefijo del proyecto para evitar confusión cruzada
    const abrevProyecto = proyectoNombre.replace(/[^a-zA-Z0-9]/g, '').slice(0, 5).toUpperCase();
    const propIdCorto = `${abrevProyecto}-${propId.slice(-6)}`;

    const diagLimpio = diagnostico.replace(/```[\s\S]*?```/g, '').replace(/`/g, '').replace(/[*_\[]/g, '').slice(0, 2500);

    // Capa 4: Mensaje distinto según criticidad
    const autoAplicaMsg = config.critico
      ? `⏱️ Auto-aplica en ${timeoutMin} min si no respondes (servicio crítico).`
      : `⚠️ Servicio NO crítico — NO se aplica automáticamente. Responde para actuar.`;

    encolarRespuesta(
      `🔍 AUTOCORRECT [${proyectoNombre}] — Propuesta #${propIdCorto}\n\n` +
      `${diagLimpio}\n\n` +
      `${autoAplicaMsg}\n` +
      `!!!AUTOCORRECT_BOTONES:${propIdCorto}!!!`,
      'pmo'
    );

    // Programar timeout
    const timer = setTimeout(() => {
      if (!config.critico) {
        // Capa 4: No-crítico → NO auto-aplicar, solo notificar expiración
        log(`[autocorrect] ${proyectoNombre} — Timeout ${timeoutMin}min. No crítico → NO auto-aplicando`);
        encolarRespuesta(
          `⏰ AUTOCORRECT [${proyectoNombre}] — Propuesta #${propIdCorto} expiró sin respuesta.\n` +
          `Servicio no crítico: no se aplicó automáticamente.\n` +
          `Para aplicar: !pmo aplicar ${propIdCorto}`,
          'pmo'
        );
        propuestasPendientes.delete(propId);
        propuestasPendientes.delete(propIdCorto);
        db.prepare(`UPDATE pmo_ejecuciones SET estado = 'expirado', ts_fin = ? WHERE id = ?`).run(Date.now(), ejecId);
        return;
      }
      // Crítico → auto-aplicar
      log(`[autocorrect] ${proyectoNombre} — Timeout ${timeoutMin}min. Auto-aplicando...`);
      encolarRespuesta(`⏰ AUTOCORRECT [${proyectoNombre}] — Timeout. Aplicando automáticamente...`, 'pmo');
      propuestasPendientes.delete(propId);
      propuestasPendientes.delete(propIdCorto);
      aplicarFix({ proyecto: proyectoNombre, config, diagnostico, ejecId, errorDetails })
        .catch(err => log(`Error auto-aplicando: ${err.message}`));
    }, timeoutMs);

    // Guardar propuesta — almacenamos ambas claves en propData para poder borrarlas ambas al responder
    const propData = {
      proyecto: proyectoNombre,
      config,
      diagnostico,
      ejecId,
      errorDetails,
      timer,
      creadoEn: Date.now(),
      propId,       // clave larga (para cleanup)
      propIdCorto,  // clave corta (para cleanup)
    };
    propuestasPendientes.set(propId, propData);
    propuestasPendientes.set(propIdCorto, propData); // Capa 6: clave con prefijo de proyecto

    log(`[autocorrect] ${proyectoNombre} — Propuesta ${propIdCorto} creada. Timeout: ${timeoutMin}min`);

  } catch (err) {
    log(`Error en diagnóstico: ${err.message}`);
    encolarRespuesta(`❌ AUTOCORRECT [${proyectoNombre}] — Error diagnóstico: ${err.message}`, 'pmo');
    db.prepare(`UPDATE pmo_ejecuciones SET resultado = ?, estado = 'error', ts_fin = ? WHERE id = ?`)
      .run(err.message, Date.now(), ejecId);
  } finally {
    ejecutando--;
    proyectosEjecutando.delete(proyectoNombre);
  }

  return true; // procesado
}

// ── Relay: interceptar mensajes de agentes y re-etiquetar como 'pmo' ─────
//
// PMO reclama atomicamente los mensajes de orquestador/monitor/cfo antes
// de que el dispatcher los envíe al admin. Los re-inserta con el mismo id
// y origen='pmo', preservando los botones inline (detectarOrch/detectarMonitor
// usan el texto y el id — ambos se conservan).
//
// Si el dispatcher llega primero (race condition): el mensaje se envía solo
// al mirror del grupo (no al admin), que es el comportamiento aceptable.

function relayarMensajesAgentes(db) {
  const claimed = db.transaction(() => {
    const items = db.prepare(`
      SELECT * FROM mensajes_queue
      WHERE origen IN ('orquestador', 'cfo')
        AND enviado = 0
      ORDER BY ts ASC
      LIMIT 5
    `).all();

    for (const item of items) {
      db.prepare('DELETE FROM mensajes_queue WHERE id = ?').run(item.id);
    }
    return items;
  })();

  for (const item of claimed) {
    const prefijo  = PREFIJOS_RELAY[item.origen] || `[${item.origen}]`;
    const msgRelay = `${prefijo}\n\n${item.mensaje || ''}`.slice(0, 4096);
    const capRelay = item.caption
      ? `${prefijo}\n${item.caption}`.slice(0, 1024)
      : null;

    db.prepare(`
      INSERT INTO mensajes_queue (id, tipo, mensaje, file_path, caption, origen, enviado, ts)
      VALUES (?, ?, ?, ?, ?, 'pmo', 0, ?)
    `).run(item.id, item.tipo, msgRelay, item.file_path || null, capRelay, Date.now());

    log(`  📡 Relay: [${item.origen}] ${item.id}`);
  }
}

// ── Ciclo principal ───────────────────────────────────────────────────────

async function procesarCola() {
  const db = obtenerDb();

  // 1. Buscar hasta 5 instrucciones PMO del admin y lanzarlas en paralelo por proyecto
  if (ejecutando < MAX_CONCURRENT) {
    const instrucciones = db.prepare(`
      SELECT rowid, * FROM mensajes_responses
      WHERE id LIKE 'pmo%' AND procesado = 0
      ORDER BY ts ASC LIMIT 5
    `).all();

    for (const instr of instrucciones) {
      if (ejecutando >= MAX_CONCURRENT) break;

      // Detectar proyecto para evitar lanzar dos ejecuciones del mismo proyecto
      const topicMatch = instr.id.match(/^pmo-t(\d+)-/);
      let proyectoNombre = null;
      if (topicMatch) {
        const topicConfig = TOPICS[parseInt(topicMatch[1])];
        proyectoNombre = topicConfig?.proyecto;
      } else {
        const p = identificarProyecto(instr.texto);
        proyectoNombre = p?.nombre;
      }

      // Saltar si ese proyecto ya tiene una ejecución activa
      if (proyectoNombre && proyectosEjecutando.has(proyectoNombre)) continue;

      // Marcar como procesado antes de lanzar para no re-tomarlo en el próximo poll
      db.prepare(`UPDATE mensajes_responses SET procesado = 1 WHERE rowid = ?`).run(instr.rowid);

      // Lanzar sin await — ejecución paralela real
      if (topicMatch) {
        procesarMensajeTopic(parseInt(topicMatch[1]), instr.texto)
          .catch(err => {
            log(`Error procesando topic: ${err.message}`);
            encolarRespuesta(`❌ PMO — Error interno: ${err.message}`, 'pmo');
          });
      } else {
        procesarInstruccionPMO(instr.texto)
          .catch(err => {
            log(`Error procesando instrucción PMO: ${err.message}`);
            encolarRespuesta(`❌ PMO — Error interno: ${err.message}`, 'pmo');
          });
      }
    }
  }

  // 2. Buscar autocorrecciones del monitor (mensajes_queue con origen='autocorrect')
  if (ejecutando < MAX_CONCURRENT) {
    const autocorrects = db.prepare(`
      SELECT * FROM mensajes_queue
      WHERE origen = 'autocorrect' AND enviado = 0
      ORDER BY ts ASC LIMIT 1
    `).all();

    for (const item of autocorrects) {
      if (ejecutando >= MAX_CONCURRENT) break;
      try {
        const procesado = await procesarAutocorrect(item);
        if (procesado) {
          db.prepare(`UPDATE mensajes_queue SET enviado = 1 WHERE id = ?`).run(item.id);
        }
        // Si no se procesó (cooldown/concurrencia), dejarlo pendiente para reintento
      } catch (err) {
        log(`Error procesando autocorrect: ${err.message}`);
        encolarRespuesta(`❌ AUTOCORRECT — Error interno: ${err.message}`, 'pmo');
        db.prepare(`UPDATE mensajes_queue SET enviado = 1 WHERE id = ?`).run(item.id);
      }
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
  const db = obtenerDb();

  // Recovery: marcar ejecuciones que quedaron colgadas en un reinicio anterior
  const colgadas = db.prepare(`
    SELECT id FROM pmo_ejecuciones
    WHERE estado IN ('ejecutando', 'diagnosticando')
  `).all();
  if (colgadas.length > 0) {
    db.prepare(`
      UPDATE pmo_ejecuciones SET estado = 'interrumpido', ts_fin = ?
      WHERE estado IN ('ejecutando', 'diagnosticando')
    `).run(Date.now());
    log(`Recovery: ${colgadas.length} ejecución(es) interrumpidas por reinicio`);
    encolarRespuesta(
      `⚠️ PMO reiniciado. ${colgadas.length} ejecución(es) quedaron incompletas — re-envía tus órdenes si es necesario.`,
      'pmo'
    );
  }

  // Relay rápido: corre cada 2s (igual que el dispatcher) para minimizar
  // la ventana en que el dispatcher puede ganar la race condition.
  const RELAY_INTERVAL_MS = 2000;
  setInterval(() => {
    try {
      relayarMensajesAgentes(obtenerDb());
    } catch (err) {
      log(`Error en relay: ${err.message}`);
    }
  }, RELAY_INTERVAL_MS);

  // Cancel watcher: detecta /pmo_cancelar desde Telegram cada 2s.
  // Mata el proceso en curso sin esperar al watchdog (respuesta en <4s).
  setInterval(() => {
    try {
      const db = obtenerDb();
      const cancelCmd = db.prepare(`
        SELECT rowid, * FROM mensajes_responses
        WHERE id LIKE 'pmo-cancel%' AND procesado = 0
        ORDER BY ts ASC LIMIT 1
      `).get();
      if (!cancelCmd) return;

      db.prepare('UPDATE mensajes_responses SET procesado = 1 WHERE rowid = ?').run(cancelCmd.rowid);

      if (!estaEjecutando()) {
        encolarRespuesta('ℹ️ PMO — no hay ejecución en curso.', 'pmo');
        return;
      }

      log('🛑 Cancelación solicitada por admin — matando proceso en curso...');
      limpiarProcesoHuerfano();
      encolarRespuesta('🛑 PMO — ejecución cancelada por el admin.', 'pmo');

      // Marcar ejecución activa como cancelada en DB
      db.prepare(`
        UPDATE pmo_ejecuciones SET estado = 'cancelado', ts_fin = ?
        WHERE estado IN ('ejecutando', 'diagnosticando')
      `).run(Date.now());
    } catch (err) {
      log(`Error en cancel watcher: ${err.message}`);
    }
  }, RELAY_INTERVAL_MS);

  // Ciclo principal de polling (instrucciones PMO + autocorrect)
  setInterval(async () => {
    try {
      await procesarCola();
    } catch (err) {
      log(`Error en ciclo: ${err.message}`);
    }
  }, POLL_INTERVAL_MS);

  // Primer ciclo inmediato
  relayarMensajesAgentes(obtenerDb());
  procesarCola().catch(err => log(`Error en primer ciclo: ${err.message}`));
}

iniciar();
