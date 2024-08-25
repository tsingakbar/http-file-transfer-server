#!/usr/bin/env node
var formidable = require('formidable'),
    mustache = require('mustache'),
    http = require('http'),
    fs = require('fs'),
    process = require('process'),
    path = require('path');

//const BIND_IP = '0.0.0.0';
const BIND_IP = '::';
const BIND_PORT = 8080;
const INDEX_HTML_TPL = fs.readFileSync(`${__dirname}/index.mustache`).toString();
const SIMPLE_RESPONSIVE_CSS = fs.readFileSync(`${__dirname}/simpleresponsive.css`).toString();
const INDEX_JS = fs.readFileSync(`${__dirname}/index.js`).toString();
const TAIL_F_HTML_TPL = fs.readFileSync(`${__dirname}/tail_f.mustache`).toString();

function parseHttpReqRange(rangeLine, fileSize) {
    // if multiple ranges requested, we only support the first range
    let [, rangeStart, rangeEnd] = rangeLine.trim().match(/bytes=(\d+)?-(\d+)?/);
    rangeStart = parseInt(rangeStart);
    rangeEnd = parseInt(rangeEnd);
    if (isNaN(rangeStart)) {
        if (isNaN(rangeEnd)) {
            return [NaN, NaN];
        }
        // something like Range: -500
        if (rangeEnd >= fileSize) {
            return [NaN, NaN];
        }
        return [fileSize - rangeEnd, fileSize - 1];
    }
    if (rangeStart >= fileSize) {
        return [NaN, NaN];
    }
    if (isNaN(rangeEnd)) {
        // something like Range: 999-
        return [rangeStart, fileSize - 1];
    }
    // something like Range:600-700
    if (rangeEnd >= fileSize) {
        return [NaN, NaN];
    }
    return [rangeStart, rangeEnd];
}

function mkStatPromise(dirPath, fileName) {
    return new Promise((resolve) => {
        const fileRelPath = path.join(dirPath, fileName);
        fs.stat(fileRelPath, (err, stat) => {
            if (err != null) {
                console.warn(`directory: stat(${fileRelPath}) failed: ${err.message}`);
                resolve({
                    'name': fileName,
                    'size': 0,
                });
            } else {
                const href = encodeURI(path.join('/', dirPath, fileName));
                if (stat.isDirectory()) {
                    fileName = `📁${fileName}/`;
                }
                resolve({
                    'name': fileName,
                    'href': href,
                    'tailFAvail' : stat.isFile() && fileName.toLowerCase().endsWith('.log'),
                    'mtime': stat.mtime.toLocaleString('sv', { timeZoneName: 'short' }),
                    'size': stat.size,
                });
            }
        })
    });
}

async function parseUriToFileStat(uri) {
    const file = {};
    uri = new URL(uri, 'scheme://host');
    file.decodedUrlPath = decodeURI(uri.pathname);
    file.isTailFPage = (uri.searchParams.has("tail_f"));
    // now: decodedUrlPath possible values(tailing slash is not always carried): '/', '/foo', '/foo/', '/bar.txt'
    if (file.decodedUrlPath.endsWith('/')) {
        // make sure there is no trailing slash, resulting like: '', '/foo', '/bar.txt'
        file.decodedUrlPath = file.decodedUrlPath.substring(0, file.decodedUrlPath.length - 1);
    }
    file.relPath = path.normalize(path.join('.', file.decodedUrlPath));
    // now: file.relPath possible values: '.', 'foo', 'bar.txt'
    // path.resolve(file.relPath) possible values(tailing slash is never carried): '/cwd', '/cwd/foo', '/cwd/bar.txt'
    if (path.resolve(file.relPath) != path.join(path.resolve(process.cwd()), file.decodedUrlPath)) {
        return [null, {
            code: 403,
            header: { 'Content-Type': "text/plain; charset=UTF-8" },
            message: "Not allowed to break the jail",
        }];
    }
    let [err, fileStat] = await new Promise((resolve) => {
        fs.stat(file.relPath, (err, stat) => { resolve([err, stat]); });
    });
    file.stat = fileStat;
    if (err == null) {
        err = await new Promise((resolve) => fs.access(file.relPath, fs.R_OK, (err) => { resolve(err); }));
    }
    if (err) {
        return [null, {
            code: 404,
            header: { 'Content-Type': "text/plain; charset=UTF-8" },
            message: err.message,
        }];
    }
    return [file, null];
}

function filterHandleDatestampReq(req, rsp) {
    if (req.method.toLowerCase() != 'get') {
        return false;
    }
    if (req.url != "/?stamp=now") {
        return false;
    }
    rsp.writeHead(200, { 'Content-Type': "text/plain; charset=UTF-8" });
    rsp.end((new Date).toISOString());
    return true;
}

const httpServer = http.createServer();

httpServer.on('request', async function (req, rsp) {
    if (filterHandleDatestampReq(req, rsp)) return;

    const [file, errRsp] = await parseUriToFileStat(req.url);
    if (errRsp) {
        rsp.writeHead(errRsp.code, errRsp.header);
        rsp.end(errRsp.message);
        return;
    }

    if (req.method.toLowerCase() == 'get') {
        // "GET" is used for directory listing and file downloading
        if (file.stat.isDirectory()) {
            const [err, subFileNameList] = await new Promise((resolve) => {
                fs.readdir(file.relPath, (err, list) => { resolve([err, list]); });
            });
            if (err) {
                rsp.writeHead(404, { 'Content-Type': "text/plain; charset=UTF-8" });
                rsp.end(err.message);
                return;
            }
            let stat_promises = [];
            for (const subFileName of subFileNameList) {
                stat_promises.push(mkStatPromise(file.relPath, subFileName));
            }
            const subFileStats = await Promise.all(stat_promises);
            const index_html = mustache.render(INDEX_HTML_TPL, {
                'data': {
                    'simpleResponsiveCSS': SIMPLE_RESPONSIVE_CSS,
                    'indexJS': INDEX_JS,
                    'title': file.decodedUrlPath + '/',
                    'stringifiedFileList': JSON.stringify(subFileStats),
                }
            });
            rsp.writeHead(200, { 'Content-Type': "text/html; charset=UTF-8" });
            rsp.end(index_html, 'utf-8');
        } else if (file.stat.isFile()) {
            if (file.isTailFPage) {
                rsp.writeHead(200, { 'Content-Type': "text/html; charset=UTF-8" });
                rsp.end(mustache.render(TAIL_F_HTML_TPL, {
                    "data": {
                        'title': file.decodedUrlPath,
                        'pathWebsocket': JSON.stringify(encodeURI(path.join('/', file.relPath))),
                    }
                }), 'utf-8');
                return;
            }
            let fileStream = null;
            if (req.headers.range) {
                const [rangeStart, rangeEnd] = parseHttpReqRange(req.headers.range, file.stat.size);
                if (isNaN(rangeStart)) {
                    rsp.writeHead(416, { 'Content-Type': "text/plain; charset=UTF-8" });
                    rsp.end("Range Not Satisfiable");
                    return;
                }
                fileStream = fs.createReadStream(file.relPath, { start: rangeStart, end: rangeEnd });
                rsp.writeHead(206, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${file.stat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': `${rangeEnd - rangeStart + 1}`,
                });
                console.info(`download: streaming ${file.relPath} range ${rangeStart}-${rangeEnd} to downloader...`);
            } else {
                fileStream = fs.createReadStream(file.relPath);
                rsp.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': file.stat.size,
                });
                console.info(`download: streaming ${file.relPath} to downloader...`);
            }
            fileStream.pipe(rsp);
            // rsp.end() will be called when fileStream emits "end" event
            fileStream.on('error', (err) => {
                console.error(`download: error occurs during piping ${file.relPath} to http response: ${err.message}`);
                fileStream.close();
                rsp.end();
            });
            fileStream.on('close', () => {
                console.info(`download: streaming ${file.relPath} to downloader finished`);
            });
        } else {
            rsp.writeHead(403, { 'Content-Type': "text/plain; charset=UTF-8" });
            rsp.end(`${file.relPath} is neither directory nor regular file.`);
            return;
        }
    } else if (req.method.toLowerCase() == "post") {
        // "POST" is used for file uploading
        if (!file.stat.isDirectory()) {
            rsp.writeHead(403, { 'Content-Type': "text/plain; charset=UTF-8" });
            rsp.end(`File can only be uploaded to a directory, but ${file.relPath} is not.`);
            return;
        }
        let form = new formidable.IncomingForm({
            'keepExtensions ': true,
            'maxFileSize': 100 * 1024 * 1024 * 1024
        });
        form.encoding = 'utf-8';
        // use resolved path as uploadDir, otherwise '.' will accidently trigger formidable's attack detection
        form.uploadDir = path.resolve(file.relPath);
        console.log(`upload: ${file.relPath}/ receiving a new upload...`);
        const [err, upfile] = await new Promise((resolve) => {
            form.parse(req, function (err, fields, upfile) {
                resolve([err, upfile]);
            });
        });
        if (err) {
            console.error(`upload: ${file.relPath}/ failed: ${err.message}`);
            rsp.writeHead(500, { 'content-type': 'text/plain; charset=UTF-8' });
            rsp.end(err.message);
            return;
        }
        if (upfile.up === undefined) {
            rsp.writeHead(403, { 'content-type': 'text/plain; charset=UTF-8' });
            rsp.end("No file selected yet to be uploaded");
            return;
        }
        // rename file back to original name
        const upfileTargetPath = path.normalize(path.join(file.relPath, upfile.up.originalFilename));
        if (path.dirname(path.resolve(upfile.up.filepath)) != path.dirname(path.resolve(upfileTargetPath))) {
            rsp.writeHead(403, { 'Content-Type': "text/plain; charset=UTF-8" });
            rsp.end("Not allowed to break the jail");
            return;
        }
        await new Promise((resolve) => {
            fs.rename(upfile.up.filepath, upfileTargetPath, (err) => {
                resolve(null);
            })
        });
        rsp.writeHead(200, { 'content-type': 'text/plain; charset=UTF-8' });
        rsp.end(`${upfileTargetPath} uploaded.\nAll glory be to https://github.com/node-formidable/formidable`);
        console.log(`upload: finished ${JSON.stringify(upfile, null, 2)}`);
    } else {
        rsp.writeHead(403);
        rsp.end();
        return;
    }
});

httpServer.on('upgrade', async function (req, socket) {
    if (req.headers['upgrade'] !== 'websocket') {
        socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
    }
    const [file, errRsp] = await parseUriToFileStat(req.url);
    if (errRsp || !file.stat.isFile()) {
        socket.end(`HTTP/1.1 403 Forbidden\r\n\r\n`);
        return;
    }
    // Sec-WebSocket-Accept is calculated and responsed for proving this is not a cache
    const secWebsocketAccept = require('crypto')
        .createHash('SHA1')
        .update(req.headers['sec-websocket-key'] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest('base64');
    socket.write(
        "HTTP/1.1 101 Web Socket Protocol Handshake\r\n" +
        "Upgrade: WebSocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + secWebsocketAccept + "\r\n" +
        "\r\n");

    // websocket is ready, now wrap file updating data into websocket frames to send to client.
    const tail = require('child_process').spawn("tail", ["-f", file.relPath]);
    console.log(`launch tail -f ${file.relPath} process ${tail.pid} for websocket connection`);
    tail.on('error', () => {
        console.log(`close websocket for tail -f ${file.relPath} process ${tail.pid} failed to spawn`);
        socket.end();
    });
    tail.on('exit', () => {
        tail.exited = true;
        if (!socket.destroyed) {
            console.log(`close websocket for lost tail -f ${file.relPath} process ${tail.pid}`);
            socket.end();
        }
    });
    socket.on('data', () => {
        // have to register 'data' event for 'end' event to work.
        // we will not parse any incoming frames from client.
    });
    socket.on('end', () => {
        socket.destroy();
        if (!tail.exited) {
            console.log(`kill tail -f ${file.relPath} process ${tail.pid} for closed websocket`);
            tail.kill();
        }
    });
    tail.stdout.on('data', (stdoutChunk) => {
        // websocket frame: https://www.rfc-editor.org/rfc/rfc6455
        let buffer = null;
        let payloadOffset = 0;
        if (stdoutChunk.length < 126) {
            buffer = Buffer.alloc(2);
            buffer.writeUInt8(stdoutChunk.length, 1);
            payloadOffset = 2;
        } else if (stdoutChunk.length <= 65536) {
            buffer = Buffer.alloc(2 + 2);
            buffer.writeUInt8(126, 1);
            buffer.writeUInt16BE(stdoutChunk.length, 2);
            payloadOffset = 4;
        } else {
            buffer = Buffer.alloc(2 + 8);
            buffer.writeUInt8(127, 1);
            buffer.writeBigUint64BE(stdoutChunk.length, 2);
            payloadOffset = 10;
        }
        // Write out the first byte, using opcode `2` to indicate that the message 
        // payload is binary(although most of the time it is pure text)
        buffer.writeUInt8(0b10000010, 0);
        buffer = Buffer.concat([buffer, stdoutChunk]);
        // might return false indicating underlying buffer is full, but it's ok to lose some frames
        socket.write(buffer);
    });
});

console.log(`starting http server at ${BIND_IP}:${BIND_PORT}...`);
httpServer.listen(BIND_PORT, BIND_IP);
