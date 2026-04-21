const { app, BrowserWindow, session } = require('electron');
const path = require('path');

// Fix for Linux/Ubuntu DGX: Use explicit flags to disable GPU and hardware acceleration
// which prevents both the black screen and the SIGTRAP crash.
// Fix for ARM-based Linux/Ubuntu (e.g. DGX Spark):
// ARM GPUs often have issues with the modern Chromium rendering pipeline (Viz).
// These flags force a more compatible legacy rendering mode.
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('disable-gpu-rasterization');
app.commandLine.appendSwitch('disable-gpu-sandbox');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('disable-features', 'VizDisplayCompositor,UseSkiaRenderer');
// Some ARM systems prefer egl or swiftshader
app.commandLine.appendSwitch('use-gl', 'swiftshader');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

function createWindow() {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'EvigStudio',
        backgroundColor: '#0f1117',
        titleBarStyle: 'hiddenInset',
        autoHideMenuBar: true,
        icon: path.join(__dirname, '../public/app-icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            // Allow File System Access API
            enableBlinkFeatures: 'FileSystemAccess',
        },
    });

    // Remove CORS restrictions so the renderer can call LM Studio directly
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        callback({ requestHeaders: { ...details.requestHeaders, Origin: '*' } });
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
                ...details.responseHeaders,
                'Access-Control-Allow-Origin': ['*'],
                'Access-Control-Allow-Headers': ['*'],
                'Access-Control-Allow-Methods': ['*'],
            },
        });
    });

    if (isDev) {
        // In dev mode, load from Vite dev server
        // Use 127.0.0.1 instead of localhost for better compatibility on Linux
        const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:8080';
        win.loadURL(devUrl).catch(err => {
            console.error('[Electron] Failed to load dev URL:', err);
            // Fallback: try loading the built index.html if server is unreachable
            win.loadFile(path.join(__dirname, '../dist/index.html'));
        });
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        // In production, load the built files
        win.loadFile(path.join(__dirname, '../dist/index.html')).catch(err => {
            console.error('[Electron] Failed to load productivity files:', err);
        });
    }

    win.on('ready-to-show', () => {
        win.show();
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
