'use strict';

/**
 * claude-runner.js — Ejecuta claude -p con plan Max (sin API key)
 *
 * Optimizaciones (inspiradas en orquestador/monitor):
 *   1. MCP config dinámico: solo carga el server del proyecto target (no los 6)
 *   2. Cache de system prompts: lee .md una vez, invalida por mtime
 *   3. Sesiones de 1 hora por proyecto con --session-id (create-or-resume)
 *   4. Guard anti-reentrancia
 *   5. Cleanup de procesos huérfanos
 */

const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const os         = require('os');
const crypto     = require('crypto');
const {
  MCP_CONFIG,
  PROMPTS_DIR,
  CLAUDE_TIMEOUT_MS,
} = require('./config');

function log(msg) {
  const ahora = new Date().toLocaleString('es-MX', { timeZone: 'America/Hermosillo' });
  console.log(`[${ahora}] [claude-runner] ${msg}`);
}

// ── Cache de system prompts (invalida por mtime) ─────────────────────────

const promptCache = new Map(); // file → { content, mtime }

function leerPromptCached(filePath) {
  const stat = fs.statSync(filePath);
  const cached = promptCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.content;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  promptCache.set(filePath, { content, mtime: stat.mtimeMs });
  return content;
}

// ── MCP config dinámico por proyecto ──────────────────────────────────────

const mpcConfigCache = new Map(); // projectName → tmpFilePath
const fullMcpConfig = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf-8'));

function getMcpConfigParaProyecto(projectName) {
  // Buscar el server que coincida con el projectName
  const serverEntry = fullMcpConfig.mcpServers[projectName];
  if (!serverEntry) {
    // Fallback: usar config completo
    return MCP_CONFIG;
  }

  // Generar config con solo ese server
  const cacheKey = projectName;
  const cached = mpcConfigCache.get(cacheKey);
  if (cached && fs.existsSync(cached)) {
    return cached;
  }

  const miniConfig = {
    mcpServers: {
      [projectName]: serverEntry,
    },
  };

  const tmpFile = path.join(os.tmpdir(), `pmo-mcp-${projectName}.json`);
  fs.writeFileSync(tmpFile, JSON.stringify(miniConfig, null, 2), 'utf-8');
  mpcConfigCache.set(cacheKey, tmpFile);
  return tmpFile;
}

// ── Sesiones (1 hora de vida, máx 8 mensajes por sesión) ─────────────────

const SESSION_TTL_MS       = 60 * 60 * 1000;
const SESSION_MAX_MENSAJES = 8; // reset al superar este límite (evita budget agotado por contexto acumulado)
const sesionesActivas = new Map();

function obtenerOCrearSesion(projectName) {
  const key = projectName || 'global';
  const ahora = Date.now();
  const existente = sesionesActivas.get(key);

  if (existente &&
      (ahora - existente.creadoEn) < SESSION_TTL_MS &&
      existente.mensajes < SESSION_MAX_MENSAJES) {
    existente.ultimoUso = ahora;
    return { sessionId: existente.sessionId, esNueva: false, sesion: existente };
  }

  const sessionId = crypto.randomUUID();
  const nueva = { sessionId, creadoEn: ahora, ultimoUso: ahora, proyectos: new Set(), mensajes: 0 };
  sesionesActivas.set(key, nueva);
  return { sessionId, esNueva: true, sesion: nueva };
}

function getSesionInfo(projectKey) {
  const existente = sesionesActivas.get(projectKey || 'global');
  if (!existente) return null;
  const ahora = Date.now();
  if ((ahora - existente.creadoEn) >= SESSION_TTL_MS) return null;
  return {
    sessionId: existente.sessionId,
    creadoEn: existente.creadoEn,
    mensajes: existente.mensajes,
    proyectos: [...existente.proyectos],
    restanteMin: Math.round((SESSION_TTL_MS - (ahora - existente.creadoEn)) / 60000),
  };
}

function getAllSesionesInfo() {
  const ahora = Date.now();
  const result = [];
  for (const [key, sesion] of sesionesActivas.entries()) {
    if ((ahora - sesion.creadoEn) < SESSION_TTL_MS) {
      result.push({
        key,
        mensajes: sesion.mensajes,
        restanteMin: Math.round((SESSION_TTL_MS - (ahora - sesion.creadoEn)) / 60000),
      });
    }
  }
  return result;
}

function resetSesion() {
  sesionesActivas.clear();
}

function resetSesionProyecto(projectName) {
  sesionesActivas.delete(projectName || 'global');
}

// ── Parser de eventos stream-json ────────────────────────────────────────

const TOOL_ICONS = {
  read_file: '📂', write_file: '✍️', edit_file: '✏️',
  search_code: '🔍', list_files: '📋', get_project_structure: '🗂️',
  run_command: '⚡', restart_process: '🔄', view_logs: '📜',
  git_commit: '📝', git_diff: '🔀', git_status: '📊',
  run_tests: '🧪', check_health: '💓', start_process: '▶️',
  stop_process: '⏹️', get_status: '📡',
};

function procesarEventoJSON(event, finalOutputRef, progress) {
  try {
    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          const servers = (event.mcp_servers || []).map(s => s.name).join(', ');
          log(`  🔌 MCP: ${servers || '(ninguno)'}`);
        }
        break;

      case 'assistant':
        for (const block of (event.message?.content || [])) {
          if (block.type === 'thinking' && block.thinking) {
            log(`  💭 [thinking] ${block.thinking.slice(0, 400)}`);
          } else if (block.type === 'tool_use') {
            const icon = TOOL_ICONS[block.name] || '🔧';
            const input = JSON.stringify(block.input || {});
            log(`  ${icon} [tool] ${block.name} — ${input.slice(0, 300)}`);
            progress(`${icon} ${block.name}...`);
          } else if (block.type === 'text' && block.text?.trim()) {
            log(`  💬 [text] ${block.text.slice(0, 300)}`);
          }
        }
        break;

      case 'tool_result': {
        const content = Array.isArray(event.content)
          ? event.content.map(c => c.text || '').join('').slice(0, 300)
          : String(event.content || '').slice(0, 300);
        const isError = event.is_error ? ' ❌ ERROR' : '';
        log(`  ↩️ [tool_result]${isError} ${content}`);
        if (event.is_error) progress('⚠️ Error en tool...');
        break;
      }

      case 'result':
        finalOutputRef.value = event.result || '';
        if (event.cost_usd != null) {
          log(`  💰 Costo: $${event.cost_usd.toFixed(4)}`);
        }
        if (event.subtype === 'error_max_turns') {
          log(`  ⚠️ Alcanzó límite de turnos`);
        }
        break;
    }
  } catch {}
}

// ── Guard anti-reentrancia ────────────────────────────────────────────────

let _ejecutando = false;
let _pidActual = null;

function estaEjecutando() { return _ejecutando; }

// ── Matar árbol de procesos en Windows ────────────────────────────────────

function matarArbol(pid) {
  if (!pid) return;
  try {
    require('child_process').execSync(
      `taskkill /F /T /PID ${pid}`,
      { stdio: 'ignore' }
    );
  } catch {}
}

function limpiarProcesoHuerfano() {
  if (_pidActual) {
    matarArbol(_pidActual);
    _pidActual = null;
  }
}

// Limpiar al salir
process.on('exit', limpiarProcesoHuerfano);
process.on('SIGTERM', limpiarProcesoHuerfano);
process.on('SIGINT', limpiarProcesoHuerfano);

// ── Ejecución principal ───────────────────────────────────────────────────

async function ejecutarClaude({ promptFile, userPrompt, projectName, cwd, timeout, onProgress }) {
  const timeoutMs  = timeout || CLAUDE_TIMEOUT_MS;
  const systemFile = path.join(PROMPTS_DIR, promptFile);
  const progress   = onProgress || (() => {});

  // Guard anti-reentrancia
  if (_ejecutando) {
    return { ok: false, output: 'ERROR: Ya hay una ejecución en curso', exitCode: -4 };
  }
  _ejecutando = true;

  try {
    if (!fs.existsSync(systemFile)) {
      return { ok: false, output: `ERROR: Prompt no encontrado: ${systemFile}`, exitCode: -1 };
    }

    // ── Sesión ──────────────────────────────────────────────────────────
    const { sessionId, esNueva, sesion } = obtenerOCrearSesion(projectName);
    sesion.mensajes++;
    if (projectName) sesion.proyectos.add(projectName);

    const restanteMin = Math.round((SESSION_TTL_MS - (Date.now() - sesion.creadoEn)) / 60000);

    if (esNueva) {
      progress(`🆕 Sesión nueva (${restanteMin}min)`);
    } else {
      progress(`🔄 Sesión activa (msg #${sesion.mensajes}, ${restanteMin}min)`);
    }

    // ── MCP config solo del proyecto target ─────────────────────────────
    const mcpConfigPath = getMcpConfigParaProyecto(projectName);
    progress(`📦 Cargando ${projectName}...`);

    // ── Prompt (cached) ─────────────────────────────────────────────────
    const systemContent = leerPromptCached(systemFile);

    let fullPrompt;
    if (esNueva) {
      fullPrompt = `=== INSTRUCCIONES ===\n${systemContent}\n\n=== TAREA ===\n${userPrompt}`;
    } else {
      fullPrompt = userPrompt;
    }

    // ── Args ────────────────────────────────────────────────────────────
    const comspec = process.env.COMSPEC || 'C:\\Windows\\system32\\cmd.exe';

    progress('🧠 Pensando...');

    // ── Escribir prompt + .bat temporal ────────────────────────────────
    const tmpId = crypto.randomBytes(6).toString('hex');
    const tmpPrompt = path.join(os.tmpdir(), `pmo-prompt-${tmpId}.txt`);
    const tmpBat = path.join(os.tmpdir(), `pmo-run-${tmpId}.bat`);

    fs.writeFileSync(tmpPrompt, fullPrompt, 'utf-8');

    // --session-id hace create-or-resume automáticamente, evita hang de --resume con sesión no encontrada
    const sessionFlag = `--session-id ${sessionId}`;

    const batContent = [
      '@echo off',
      `type "${tmpPrompt}" | claude -p ^`,
      `  --output-format stream-json ^`,
      `  --verbose ^`,
      `  --model sonnet ^`,
      `  ${sessionFlag} ^`,
      `  --mcp-config "${mcpConfigPath}" ^`,
      `  --strict-mcp-config ^`,
      `  --permission-mode bypassPermissions ^`,
      `  --max-turns 20 ^`,
      `  --max-budget-usd 2.00`,
    ].join('\r\n');

    fs.writeFileSync(tmpBat, batContent, 'utf-8');

    // procesarEventoJSON definido a nivel de módulo

    // ── Spawn ───────────────────────────────────────────────────────────
    // Watchdog por inactividad: solo dispara si no hay output durante INACTIVITY_MS.
    // Si Claude está trabajando (datos fluyendo), el timer se resetea.
    // Hard cap = timeoutMs para evitar ejecuciones infinitas.
    const INACTIVITY_MS = 3 * 60 * 1000; // 3 min sin ningún byte → atascado

    return await new Promise((resolve) => {
      let rawOutput        = '';
      let lineBuffer       = '';
      let stderrBuf        = '';
      let finished         = false;
      let lastActivityAt   = Date.now();
      const finalOutputRef = { value: '' }; // llenado por el evento 'result'

      const proc = spawn(comspec, ['/c', tmpBat], {
        cwd,
        windowsHide: true,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      _pidActual = proc.pid;

      proc.stdout.on('data', (data) => {
        lastActivityAt = Date.now(); // resetear watchdog con cada byte recibido
        const chunk = data.toString();
        rawOutput  += chunk;
        lineBuffer += chunk;

        // Parsear líneas completas de stream-json
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop(); // conservar línea incompleta
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            procesarEventoJSON(event, finalOutputRef, progress);
          } catch {}
        }
      });

      proc.stderr.on('data', (data) => {
        lastActivityAt = Date.now(); // stderr también cuenta como actividad
        const chunk = data.toString().trim();
        if (chunk) {
          stderrBuf += chunk + '\n';
          log(`  ⚠️ [stderr] ${chunk.slice(0, 300)}`);
        }
      });

      // Watchdog: revisa cada 30s si hubo actividad reciente
      const watchdog = setInterval(() => {
        if (finished) { clearInterval(watchdog); return; }
        const inactivoMs = Date.now() - lastActivityAt;
        if (inactivoMs >= INACTIVITY_MS) {
          clearInterval(watchdog);
          clearTimeout(hardCap);
          finished = true;
          matarArbol(proc.pid);
          cleanup();
          _pidActual = null;
          log(`  ⏱️ Inactividad ${Math.round(inactivoMs / 1000)}s — proceso cortado`);
          resolve({
            ok: false,
            output: (finalOutputRef.value || rawOutput || stderrBuf).trim() +
                    `\n\nTIMEOUT por inactividad: ${Math.round(inactivoMs / 1000)}s sin respuesta`,
            exitCode: -2,
            sessionId,
          });
        }
      }, 30_000);

      // Hard cap: límite absoluto para evitar ejecuciones infinitas
      const hardCap = setTimeout(() => {
        if (!finished) {
          clearInterval(watchdog);
          finished = true;
          matarArbol(proc.pid);
          cleanup();
          _pidActual = null;
          log(`  ⏱️ Hard cap alcanzado (${timeoutMs / 60000}min)`);
          resolve({
            ok: false,
            output: (finalOutputRef.value || rawOutput || stderrBuf).trim() +
                    `\n\nTIMEOUT hard cap: ${timeoutMs / 60000}min`,
            exitCode: -2,
            sessionId,
          });
        }
      }, timeoutMs);

      function cleanup() {
        try { fs.unlinkSync(tmpPrompt); } catch {}
        try { fs.unlinkSync(tmpBat); } catch {}
      }

      proc.on('close', (code) => {
        if (!finished) {
          finished = true;
          clearInterval(watchdog);
          clearTimeout(hardCap);
          cleanup();
          _pidActual = null;
          let finalOutput = finalOutputRef.value.trim();
          if (!finalOutput && stderrBuf.trim()) {
            finalOutput = stderrBuf.trim();
          }
          resolve({
            ok: code === 0 && finalOutput.length > 0,
            output: finalOutput || '(sin respuesta)',
            exitCode: code || 0,
            sessionId,
          });
        }
      });

      proc.on('error', (err) => {
        if (!finished) {
          finished = true;
          clearInterval(watchdog);
          clearTimeout(hardCap);
          _pidActual = null;
          resolve({
            ok: false,
            output: `ERROR spawn: ${err.message}`,
            exitCode: -3,
            sessionId,
          });
        }
      });
    });
  } finally {
    _ejecutando = false;
  }
}

module.exports = { ejecutarClaude, getSesionInfo, getAllSesionesInfo, resetSesion, resetSesionProyecto, estaEjecutando };
