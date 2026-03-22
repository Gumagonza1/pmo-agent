'use strict';

const path = require('path');

// ── Mapa de proyectos PM2 → MCP server name + directorio ──────────────────
// Copiar este archivo como config.js y ajustar las rutas a tu entorno.

const PROYECTOS = {
  'mi-bot': {
    mcp: 'project-mi-bot',
    root: 'C:\\ruta\\a\\mi-bot',       // Ruta absoluta al proyecto
    pm2: 'mi-bot',                      // Nombre en PM2
    puerto: 3003,                        // Puerto HTTP (null si no tiene)
    critico: true,                       // ¿Es crítico para el negocio?
    descripcion: 'Bot WhatsApp — pedidos con IA',
  },
  'mi-api': {
    mcp: 'project-mi-api',
    root: 'C:\\ruta\\a\\mi-api',
    pm2: 'mi-api',
    puerto: 3001,
    critico: true,
    descripcion: 'API REST — ventas, facturación',
  },
};

// ── Rutas ──────────────────────────────────────────────────────────────────

const PROMPTS_DIR = path.join(__dirname, 'prompts');
const MCP_CONFIG  = path.join(__dirname, 'mcp-projects.json');
const MENSAJES_DB = 'C:\\ruta\\a\\datos\\mensajes.db';  // DB SQLite compartida
const STATE_DIR   = path.join(__dirname, 'state');

// ── Tiempos ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS       = 10_000;    // Revisar cola cada 10s
const VERIFY_WAIT_MS         = 15_000;    // Esperar 15s post-fix antes de verificar
const CLAUDE_TIMEOUT_MS      = 1_200_000; // Timeout para claude -p (20 min)
const MAX_CONCURRENT         = 1;         // Solo 1 corrección a la vez
const COOLDOWN_MS            = 300_000;   // 5 min entre correcciones del mismo servicio

module.exports = {
  PROYECTOS,
  PROMPTS_DIR,
  MCP_CONFIG,
  MENSAJES_DB,
  STATE_DIR,
  POLL_INTERVAL_MS,
  VERIFY_WAIT_MS,
  CLAUDE_TIMEOUT_MS,
  MAX_CONCURRENT,
  COOLDOWN_MS,
};
