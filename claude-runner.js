'use strict';

/**
 * claude-runner.js — Ejecuta claude -p con plan Max (sin API key)
 *
 * Optimizaciones (inspiradas en orquestador/monitor):
 *   1. MCP config dinámico: solo carga el server del proyecto target (no los 6)
 *   2. Cache de system prompts: lee .md una vez, invalida por mtime
 *   3. Sesiones de 1 hora con --session-id / --resume
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

// ── Sesiones (1 hora de vida) ─────────────────────────────────────────────

const SESSION_TTL_MS = 60 * 60 * 1000;
const sesionesActivas = new Map();

function obtenerOCrearSesion() {
  const key = 'global';
  const ahora = Date.now();
  const existente = sesionesActivas.get(key);

  if (existente && (ahora - existente.creadoEn) < SESSION_TTL_MS) {
    existente.ultimoUso = ahora;
    return { sessionId: existente.sessionId, esNueva: false, sesion: existente };
  }

  const sessionId = crypto.randomUUID();
  const nueva = { sessionId, creadoEn: ahora, ultimoUso: ahora, proyectos: new Set(), mensajes: 0 };
  sesionesActivas.set(key, nueva);
  return { sessionId, esNueva: true, sesion: nueva };
}

function getSesionInfo() {
  const existente = sesionesActivas.get('global');
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

function resetSesion() {
  sesionesActivas.delete('global');
}

// ── Guard anti-reentrancia ────────────────────────────────────────────────

let _ejecutando = false;
let _pidActual = null;

function estaEjecutando() { return _ejecutando; }

// ── Cleanup de procesos huérfanos ─────────────────────────────────────────

function limpiarProcesoHuerfano() {
  if (_pidActual) {
    try { process.kill(_pidActual, 'SIGTERM'); } catch {}
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
    const { sessionId, esNueva, sesion } = obtenerOCrearSesion();
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

    const sessionArg = esNueva
      ? ['--session-id', sessionId]
      : ['--resume', sessionId];

    const claudeArgs = [
      '/c', 'claude', '-p',
      '--output-format', 'text',
      '--model', 'sonnet',
      ...sessionArg,
      '--mcp-config', mcpConfigPath,
      '--permission-mode', 'bypassPermissions',
      '--max-budget-usd', '2.00',
    ];

    progress('🧠 Pensando...');

    // ── Spawn ───────────────────────────────────────────────────────────
    return await new Promise((resolve) => {
      let output   = '';
      let stderrBuf = '';
      let finished = false;
      let lastProgressAt = Date.now();
      let hasOutput = false;

      const proc = spawn(comspec, claudeArgs, {
        cwd,
        windowsHide: true,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      _pidActual = proc.pid;

      // Enviar prompt por stdin
      proc.stdin.write(fullPrompt);
      proc.stdin.end();

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        output += chunk;

        if (!hasOutput) {
          hasOutput = true;
          progress('✏️ Escribiendo...');
        }

        const now = Date.now();
        if (now - lastProgressAt > 8000) {
          lastProgressAt = now;
          const lower = output.toLowerCase();
          if (lower.includes('edit_file') || lower.includes('editando')) {
            progress('✏️ Editando código...');
          } else if (lower.includes('read_file') || lower.includes('leyendo')) {
            progress('📂 Leyendo archivos...');
          } else if (lower.includes('search_code') || lower.includes('buscando')) {
            progress('🔍 Buscando...');
          } else if (lower.includes('restart') || lower.includes('reinici')) {
            progress('🔄 Reiniciando...');
          } else if (lower.includes('commit')) {
            progress('📝 Commit...');
          } else if (lower.includes('test')) {
            progress('🧪 Tests...');
          } else {
            const kb = Math.round(output.length / 1024);
            const secs = Math.round((now - (sesion.ultimoUso)) / 1000);
            progress(`⏳ ${secs}s (${kb}KB)`);
          }
        }
      });

      proc.stderr.on('data', (data) => {
        stderrBuf += data.toString();
      });

      const timer = setTimeout(() => {
        if (!finished) {
          finished = true;
          try { proc.kill('SIGTERM'); } catch {}
          _pidActual = null;
          resolve({
            ok: false,
            output: (output || stderrBuf).trim() + `\n\nTIMEOUT: ${timeoutMs / 1000}s`,
            exitCode: -2,
            sessionId,
          });
        }
      }, timeoutMs);

      proc.on('close', (code) => {
        if (!finished) {
          finished = true;
          clearTimeout(timer);
          _pidActual = null;
          let finalOutput = output.trim();
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
          clearTimeout(timer);
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

module.exports = { ejecutarClaude, getSesionInfo, resetSesion, estaEjecutando };
