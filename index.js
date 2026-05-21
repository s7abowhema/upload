const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const baseDataFile = path.resolve(__dirname, 'servers_db.json');

// قاعدة بيانات مصغرة لحفظ السيرفرات المنشأة ومواردها
let db = { servers: [] };
if (fs.existsSync(baseDataFile)) {
    db = JSON.parse(fs.readFileSync(baseDataFile, 'utf8'));
} else {
    fs.writeFileSync(baseDataFile, JSON.stringify(db, null, 2));
}

function saveDB() {
    fs.writeFileSync(baseDataFile, JSON.stringify(db, null, 2));
}

// إعداد الرفع الذكي داخل مجلد السيرفر الخاص ببايثون
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { serverId } = req.query;
        const targetDir = path.resolve(__dirname, 'servers', serverId);
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        cb(null, targetDir);
    },
    filename: (req, file, cb) => {
        const safeName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, safeName);
    }
});
const upload = multer({ storage: storage });

let runningProcesses = {};
let serverStatuses = {};

// [1] إنشاء سيرفر بايثون جديد وتخصيص الموارد
app.post('/api/admin/create-server', (req, res) => {
    const { name, memory, disk } = req.body;
    const id = 'py_' + Math.random().toString(36).substr(2, 9);
    
    const newServer = { id, name, memory, disk, createdAt: new Date().toISOString() };
    db.servers.push(newServer);
    saveDB();

    const srvDir = path.resolve(__dirname, 'servers', id);
    if (!fs.existsSync(srvDir)) fs.mkdirSync(srvDir, { recursive: true });

    res.json({ status: 'success', server: newServer });
});

// [2] جلب قائمة السيرفرات وحالتها الحالية
app.get('/api/servers', (req, res) => {
    const list = db.servers.map(s => ({
        ...s,
        status: serverStatuses[s.id] || 'OFFLINE'
    }));
    res.json({ status: 'success', servers: list });
});

// [3] إدارة واستعراض ملفات البوت
app.get('/api/files', (req, res) => {
    const { serverId } = req.query;
    const srvDir = path.resolve(__dirname, 'servers', serverId);
    
    if (!fs.existsSync(srvDir)) fs.mkdirSync(srvDir, { recursive: true });

    try {
        const files = fs.readdirSync(srvDir).map(file => {
            const filePath = path.join(srvDir, file);
            const stats = fs.statSync(filePath);
            const isDir = stats.isDirectory();
            return {
                name: file + (isDir ? '/' : ''),
                isFolder: isDir,
                size: isDir ? '-' : (stats.size / (1024 * 1024)).toFixed(2) + " MB",
                time: stats.mtime.toLocaleString('en-US', { hour12: false })
            };
        });
        files.sort((a, b) => b.isFolder - a.isFolder);
        res.json({ status: 'success', files });
    } catch (err) {
        res.status(500).json({ status: 'error' });
    }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => res.json({ status: 'success' }));

// [4] فك الضغط الآمن والحذف بدون مشاكل ترميز
app.post('/api/files/action', (req, res) => {
    const { action, fileName, serverId } = req.body;
    const srvDir = path.resolve(__dirname, 'servers', serverId);
    const filePath = path.join(srvDir, decodeURIComponent(fileName));

    if (!fs.existsSync(filePath)) return res.status(400).json({ status: 'error', message: 'الملف غير موجود' });

    if (action === 'unarchive') {
        try {
            const zip = new AdmZip(filePath);
            zip.extractAllTo(srvDir, true);
            fs.unlinkSync(filePath);
            return res.json({ status: 'success' });
        } catch (e) {
            return res.status(500).json({ status: 'error', message: 'الملف المضغوط تالف' });
        }
    }

    if (action === 'delete') {
        try {
            if (fs.statSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(filePath);
            }
            return res.json({ status: 'success' });
        } catch (err) {
            return res.status(500).json({ status: 'error' });
        }
    }
});

// [5] نظام البث الحي للكونسول (SSE)
let logClients = [];
app.get('/api/console/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    logClients.push({ res, serverId: req.query.serverId });
    
    const currentStatus = serverStatuses[req.query.serverId] || 'OFFLINE';
    res.write(`data: ${JSON.stringify({ status: currentStatus })}\n\n`);

    req.on('close', () => { logClients = logClients.filter(c => c.res !== res); });
});

function emitLog(serverId, msg) {
    logClients.forEach(c => {
        if (c.serverId === serverId) {
            c.res.write(`data: ${JSON.stringify({ log: msg, status: serverStatuses[serverId] })}\n\n`);
        }
    });
}

// دالة التنقيب التلقائي الذكي عن سكريبت البايثون الأساسي للتشغيل
function findPythonScript(srvDir) {
    if (!fs.existsSync(srvDir)) return null;
    const files = fs.readdirSync(srvDir);
    const pyFiles = files.filter(f => f.endsWith('.py') && !fs.statSync(path.join(srvDir, f)).isDirectory());
    
    if (pyFiles.length === 0) return null;
    // يفضل main.py أو bot.py، وإلا يسحب أول ملف بايثون يجده (حتى لو كان رمزاً)
    return pyFiles.find(f => f === 'main.py' || f === 'bot.py') || pyFiles[0];
}

// [6] معالج تشغيل خوادم البايثون الفردية وتثبيت المتطلبات تلقائياً
app.post('/api/bot/control', (req, res) => {
    const { action, serverId } = req.body;
    const srvDir = path.resolve(__dirname, 'servers', serverId);

    if (action === 'start' && !runningProcesses[serverId]) {
        serverStatuses[serverId] = 'STARTING';
        emitLog(serverId, `\n\x1b[36m[OptikLink Python Daemon]:\x1b[0m Checking virtual disk structure...`);

        if (!fs.existsSync(srvDir) || fs.readdirSync(srvDir).length === 0) {
            serverStatuses[serverId] = 'OFFLINE';
            emitLog(serverId, `\n\x1b[31m❌ [Error]: المجلد فارغ! يرجى رفع ملفات البوت وفك الضغط أولاً.\x1b[0m`);
            return res.json({ status: 'success' });
        }

        const scriptToRun = findPythonScript(srvDir);
        if (!scriptToRun) {
            serverStatuses[serverId] = 'OFFLINE';
            emitLog(serverId, `\n\x1b[31m❌ [Error]: لم يتم العثور على أي ملف تشغيل بصيغة .py داخل السيرفر!\x1b[0m`);
            return res.json({ status: 'success' });
        }

        // فحص تلقائي وتثبيت للمكتبات المفقودة عبر requirements.txt
        const hasRequirements = fs.existsSync(path.join(srvDir, 'requirements.txt'));
        if (hasRequirements) {
            emitLog(serverId, `\n\x1b[33m[OptikLink]: Found requirements.txt. Installing dependencies via pip...\x1b[0m\n`);
            exec('pip install -r requirements.txt', { cwd: srvDir }, (err, stdout, stderr) => {
                if(err) emitLog(serverId, `\n\x1b[31m[Pip Warning]: Some packages failed to install.\x1b[0m\n`);
                executePythonProcess(srvDir, scriptToRun, serverId);
            });
        } else {
            executePythonProcess(srvDir, scriptToRun, serverId);
        }
    }

    if (action === 'stop' && runningProcesses[serverId]) {
        runningProcesses[serverId].kill();
        serverStatuses[serverId] = 'OFFLINE';
        emitLog(serverId, `\n\x1b[31m[System]: Server process stopped manually.\x1b[0m`);
        delete runningProcesses[serverId];
    }

    res.json({ status: 'success' });
});

function executePythonProcess(srvDir, script, serverId) {
    serverStatuses[serverId] = 'RUNNING';
    emitLog(serverId, `\n\x1b[32m[OptikLink]: Booting instance [python3 ${script}]...\x1b[0m\n`);

    // تشغيل البايثون مع معامل الـ -u لمنع حجز الـ Logs وبثها حية فوراً للكونسول
    const proc = spawn('python3', ['-u', script], { cwd: srvDir });
    runningProcesses[serverId] = proc;

    proc.stdout.on('data', (d) => emitLog(serverId, d.toString()));
    proc.stderr.on('data', (d) => emitLog(serverId, d.toString()));
    
    proc.on('close', (code) => {
        serverStatuses[serverId] = 'OFFLINE';
        emitLog(serverId, `\n\x1b[31m[System]: Python environment exited with code ${code}.\x1b[0m`);
        delete runningProcesses[serverId];
    });
}

app.post('/api/console/command', (req, res) => {
    const { command, serverId } = req.body;
    if (runningProcesses[serverId] && command) {
        runningProcesses[serverId].stdin.write(command + '\n');
    }
    res.json({});
});

app.listen(PORT, () => console.log(`منصة استضافة بوتات البايثون تعمل على منفذ ${PORT}`));
