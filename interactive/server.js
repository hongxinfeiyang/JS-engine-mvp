/**
 * 交互式执行追踪 — HTTP 服务器
 *
 * 提供两个端点：
 *   GET  /                        → 返回交互式可视化页面 (interactive.html)
 *   POST /api/execute              → 接收 { code }，返回步骤化执行轨迹
 *
 * 启动方式：
 *   node server.js
 *   然后浏览器打开 http://localhost:3456
 *
 * 设计决策：
 *   - 使用 Node.js 内置 http 模块，零外部依赖
 *     Why：保持项目零依赖原则，与 MVP 定位一致
 *   - POST 而非 GET 传递代码
 *     Why：代码可能很长，POST body 无长度限制
 *   - 服务器每次收到 /api/execute 都创建新的 JSEngine 实例
 *     Why：隔离不同次执行，避免全局状态污染
 *
 * @module server
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureSteps } from '../src/stepper.js';

const PORT = 3456;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── MIME 类型映射 ───
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
};

/**
 * 读取请求 body（JSON）
 * @param {http.IncomingMessage} req
 * @returns {Promise<object>}
 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * 发送 JSON 响应
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {object} data
 */
function sendJSON(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

// ─── 创建 HTTP 服务器 ───
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ─── CORS 头（允许本地开发） ───
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // ─── POST /api/execute — 执行代码并返回步骤轨迹 ───
    if (req.method === 'POST' && url.pathname === '/api/execute') {
        try {
            const body = await readBody(req);
            const code = body.code || '';

            if (!code.trim()) {
                sendJSON(res, 400, { error: '代码不能为空' });
                return;
            }

            const startTime = Date.now();
            const result = captureSteps(code);
            const duration = Date.now() - startTime;

            sendJSON(res, 200, {
                ...result,
                duration,
                stepCount: result.steps.length,
            });
        } catch (e) {
            sendJSON(res, 500, { error: e.message });
        }
        return;
    }

    // ─── GET / — 返回交互式页面 ───
    let filePath = url.pathname === '/' ? '/interactive.html' : url.pathname;
    filePath = path.join(__dirname, path.normalize(filePath));

    // 安全检查：防止路径穿越
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    try {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not Found');
    }
});

server.listen(PORT, () => {
    console.log(`\n  JS Engine 交互式执行追踪已启动`);
    console.log(`  打开浏览器访问: http://localhost:${PORT}\n`);
});
