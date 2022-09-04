#!/usr/bin/env node
var formidable = require('formidable'),
    mustache = require('mustache'),
    http = require('http'),
    fs = require('fs'),
    process = require('process'),
    path = require('path');
const { stdout } = require('process');

const BIND_IP = '0.0.0.0';
const BIND_PORT = 8080;
const INDEX_HTML_TPL = fs.readFileSync(`${__dirname}/index.mustache`).toString();
const SIMPLE_RESPONSIVE_CSS = fs.readFileSync(`${__dirname}/simpleresponsive.css`).toString();

function humanFileSize(size) {
    if (size == 0) { return '0B'; }
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return (size / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][i];
};

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
                resolve({ 'name': fileName });
            } else {
                if (stat.isDirectory()) {
                    fileName += '/';
                }
                const href = encodeURI(path.join('/', dirPath, fileName));
                resolve({
                    'name': fileName,
                    'href': href,
                    'hrefStringified': (stat.isFile() ? JSON.stringify(href) : null),
                    'mtime': stat.mtime.toLocaleString('sv', { timeZoneName: 'short' }),
                    'size': stat.size,
                    'sizeHumanReadable': humanFileSize(stat.size),
                });
            }
        })
    });
}

async function parseUriToFileStat(uri) {
    let decodedUrlPath = decodeURI((new URL(uri, 'scheme://host')).pathname);
    // now: decodedUrlPath possible values(tailing slash is not always carried): '/', '/foo', '/foo/', '/bar.txt'
    if (decodedUrlPath.endsWith('/')) {
        // make sure there is no trailing slash, resulting like: '', '/foo', '/bar.txt'
        decodedUrlPath = decodedUrlPath.substring(0, decodedUrlPath.length - 1);
    }
    const fileRelPath = path.normalize(path.join('.', decodedUrlPath));
    // now: fileRelPath possible values: '.', 'foo', 'bar.txt'
    // path.resolve(fileRelPath) possible values(tailing slash is never carried): '/cwd', '/cwd/foo', '/cwd/bar.txt'
    if (path.resolve(fileRelPath) != path.join(path.resolve(process.cwd()), decodedUrlPath)) {
        return [null, null, null, {
            code: 403,
            header: { 'Content-Type': "text/plain; charset=UTF-8" },
            message: "Not allowed to break the jail",
        }];
    }
    let [err, fileStat] = await new Promise((resolve) => {
        fs.stat(fileRelPath, (err, stat) => { resolve([err, stat]); });
    });
    if (err == null) {
        err = await new Promise((resolve) => fs.access(fileRelPath, fs.R_OK, (err) => { resolve(err); }));
    }
    if (err) {
        return [null, null, null, {
            code: 404,
            header: { 'Content-Type': "text/plain; charset=UTF-8" },
            message: err.message,
        }];
    }
    return [fileStat, fileRelPath, decodedUrlPath, null];
}

const httpServer = http.createServer();

httpServer.on('request', async function (req, rsp) {
    const [fileStat, fileRelPath, decodedUrlPath, errRsp] = await parseUriToFileStat(req.url);
    if (errRsp) {
        rsp.writeHead(errRsp.code, errRsp.header);
        rsp.end(errRsp.message);
        return;
    }

    if (req.method.toLowerCase() == 'get') {
        // "GET" is used for directory listing and file downloading
        if (fileStat.isDirectory()) {
            const [err, subFileNameList] = await new Promise((resolve) => {
                fs.readdir(fileRelPath, (err, list) => { resolve([err, list]); });
            });
            if (err) {
                rsp.writeHead(404, { 'Content-Type': "text/plain; charset=UTF-8" });
                rsp.end(err.message);
                return;
            }
            let stat_promises = [];
            for (const subFileName of subFileNameList) {
                stat_promises.push(mkStatPromise(fileRelPath, subFileName));
            }
            const subFileStats = await Promise.all(stat_promises);
            const index_html = mustache.render(INDEX_HTML_TPL, {
                'data': {
                    'simpleResponsiveCSS': SIMPLE_RESPONSIVE_CSS,
                    'title': decodedUrlPath + '/',
                    'fileList': subFileStats,
                }
            });
            rsp.writeHead(200, { 'Content-Type': "text/html; charset=UTF-8" });
            rsp.end(index_html, 'utf-8');
        } else if (fileStat.isFile()) {
            let fileStream = null;
            if (req.headers.range) {
                const [rangeStart, rangeEnd] = parseHttpReqRange(req.headers.range, fileStat.size);
                if (isNaN(rangeStart)) {
                    rsp.writeHead(416, { 'Content-Type': "text/plain; charset=UTF-8" });
                    rsp.end("Range Not Satisfiable");
                    return;
                }
                fileStream = fs.createReadStream(fileRelPath, { start: rangeStart, end: rangeEnd });
                rsp.writeHead(206, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Range': `bytes ${rangeStart}-${rangeEnd}/${fileStat.size}`,
                    'Accept-Ranges': 'bytes',
                    'Content-Length': `${rangeEnd - rangeStart + 1}`,
                });
                console.info(`download: streaming ${fileRelPath} range ${rangeStart}-${rangeEnd} to downloader...`);
            } else {
                fileStream = fs.createReadStream(fileRelPath);
                rsp.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': fileStat.size,
                });
                console.info(`download: streaming ${fileRelPath} to downloader...`);
            }
            fileStream.pipe(rsp);
            // rsp.end() will be called when fileStream emits "end" event
            fileStream.on('error', (err) => {
                console.error(`download: error occurs during piping ${fileRelPath} to http response: ${err.message}`);
                fileStream.close();
                rsp.end();
            });
            fileStream.on('close', () => {
                console.info(`download: streaming ${fileRelPath} to downloader finished`);
            });
        } else {
            rsp.writeHead(403, { 'Content-Type': "text/plain; charset=UTF-8" });
            rsp.end(`${fileRelPath} is neither directory nor regular file.`);
            return;
        }
    } else if (req.method.toLowerCase() == "post") {
        // "POST" is used for file uploading
        if (!fileStat.isDirectory()) {
            rsp.writeHead(403, { 'Content-Type': "text/plain; charset=UTF-8" });
            rsp.end(`File can only be uploaded to a directory, but ${fileRelPath} is not.`);
            return;
        }
        let form = new formidable.IncomingForm({
            'keepExtensions ': true,
            'maxFileSize': 100 * 1024 * 1024 * 1024
        });
        form.encoding = 'utf-8';
        // use resolved path as uploadDir, otherwise '.' will accidently trigger formidable's attack detection
        form.uploadDir = path.resolve(fileRelPath);
        console.log(`upload: ${fileRelPath}/ receiving a new upload...`);
        const [err, upfile] = await new Promise((resolve) => {
            form.parse(req, function (err, fields, upfile) {
                resolve([err, upfile]);
            });
        });
        if (err) {
            console.error(`upload: ${fileRelPath}/ failed: ${err.message}`);
            rsp.writeHead(500, { 'content-type': 'text/plain; charset=UTF-8' });
            rsp.end(err.message);
            return;
        }
        // rename file back to original name
        const upfileTargetPath = path.normalize(path.join(fileRelPath, upfile.up.originalFilename));
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
    const [fileStat, fileRelPath, decodedUrlPath, errRsp] = await parseUriToFileStat(req.url);
    if (errRsp || !fileStat.isFile()) {
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
    const tail = require('child_process').spawn("tail", ["-f", fileRelPath]);
    console.log(`launch tail -f ${fileRelPath} process ${tail.pid} for websocket connection`);
    tail.on('error', () => {
        console.log(`close websocket for tail -f ${fileRelPath} process ${tail.pid} failed to spawn`);
        socket.end();
    });
    tail.on('exit', () => {
        tail.exited = true;
        if (!socket.destroyed) {
            console.log(`close websocket for lost tail -f ${fileRelPath} process ${tail.pid}`);
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
            console.log(`kill tail -f ${fileRelPath} process ${tail.pid} for closed websocket`);
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
