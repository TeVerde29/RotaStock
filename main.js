// RotaStock - Proceso principal de Electron
// Arquitectura local, offline y portable. Persistencia en datos/inventario.json.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────
// RUTAS PORTABLES
// ─────────────────────────────────────────────
// En producción (.exe empaquetado): datos/ y backups/ deben vivir JUNTO
// al ejecutable, no dentro del app.asar (que es de solo lectura).
// En desarrollo: viven en la raíz del proyecto.
function getBasePath() {
  return app.isPackaged
    ? path.dirname(app.getPath('exe'))
    : __dirname;
}

const DATA_DIR   = () => path.join(getBasePath(), 'datos');
const DATA_FILE  = () => path.join(DATA_DIR(), 'inventario.json');
const BACKUP_DIR = () => path.join(getBasePath(), 'backups');

// Estructura por defecto de la base de datos local
function defaultDB() {
  return {
    meta: { version: 1, createdAt: new Date().toISOString() },
    config: {
      metodoCosteo: 'FIFO',
      umbrales: { sana: 7, lenta: 15, muyLenta: 30, dormido: 60 }
    },
    productos: [],
    movimientos: []
  };
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR()))   fs.mkdirSync(DATA_DIR(), { recursive: true });
  if (!fs.existsSync(BACKUP_DIR())) fs.mkdirSync(BACKUP_DIR(), { recursive: true });
}

function loadDB() {
  ensureDirs();
  try {
    if (!fs.existsSync(DATA_FILE())) {
      const db = defaultDB();
      fs.writeFileSync(DATA_FILE(), JSON.stringify(db, null, 2), 'utf-8');
      return db;
    }
    const raw = fs.readFileSync(DATA_FILE(), 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    return defaultDB();
  }
}

let lastBackup = 0;
function saveDB(db) {
  ensureDirs();
  fs.writeFileSync(DATA_FILE(), JSON.stringify(db, null, 2), 'utf-8');
  // Copia de seguridad automática (máx. una cada 60s para no saturar)
  const now = Date.now();
  if (now - lastBackup > 60000) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.writeFileSync(path.join(BACKUP_DIR(), `inventario-${stamp}.json`), JSON.stringify(db, null, 2), 'utf-8');
      lastBackup = now;
    } catch (e) { /* backup no crítico */ }
  }
  return true;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#161816',
    show: false,
    title: 'RotaStock',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show()); // evita destello de color al abrir

  // El frontend se empaqueta dentro del app.asar (__dirname sigue
  // funcionando aquí porque loadFile lee del asar, que sí es válido
  // para lectura de recursos empaquetados).
  win.loadFile(path.join(__dirname, 'frontend', 'index.html'));
}

ipcMain.handle('db:load', () => loadDB());
ipcMain.handle('db:save', (_evt, db) => saveDB(db));

app.whenReady().then(() => {
  ensureDirs();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
