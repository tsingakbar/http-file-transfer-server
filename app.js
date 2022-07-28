#!/usr/bin/env node
var formidable = require('formidable'),
    mustache = require('mustache'),
    http = require('http'),
    fs = require('fs'),
    process = require('process'),
    path = require('path');

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
        const fileRelePath = path.join(dirPath, fileName);
        fs.stat(fileRelePath, (err, stat) => {
            if (err != null) {
                console.warn(`directory: stat(${fileRelePath}) failed: ${err.message}`);
                resolve({ 'name': fileName });
            } else {
                if (stat.isDirectory()) {
                    fileName += '/';
                }
                resolve({
                    'name': fileName,
                    'href': encodeURI(path.join('/', dirPath, fileName)),
                    'mtime': stat.mtime.toLocaleString( 'sv', { timeZoneName: 'short' } ),
                    'size': stat.size,
                    'sizeHumanReadable': humanFileSize(stat.size),
                });
            }
        })
    });
}

console.log(`starting http server at ${BIND_IP}:${BIND_PORT}...`);
http.createServer(async function (req, rsp) {
    // possible values(tailing slash is not always carried): '/', '/foo', '/foo/', '/bar.txt'
    let decodedUrlPath = decodeURI((new URL(req.url, 'scheme://host')).pathname);
    if (decodedUrlPath.endsWith('/')) {
        // make sure there is no trailing slash, like: '', '/foo', '/bar.txt'
        decodedUrlPath = decodedUrlPath.substring(0, decodedUrlPath.length - 1);
    }
    // possible values: '.', 'foo', 'bar.txt'
    const fileRelPath = path.normalize(path.join('.', decodedUrlPath));
    // possible values(tailing slash is never carried): '/cwd', '/cwd/foo', '/cwd/bar.txt'
    if (path.resolve(fileRelPath) != path.join(path.resolve(process.cwd()), decodedUrlPath)) {
        rsp.writeHead(403, { 'Content-Type': "text/plain; charset=UTF-8" });
        rsp.end("Not allowed to break the jail");
        return;
    }
    const [err, fileStat] = await new Promise((resolve) => {
        fs.stat(fileRelPath, (err, stat) => { resolve([err, stat]); });
    });
    if (err) {
        rsp.writeHead(404, { 'Content-Type': "text/plain; charset=UTF-8" });
        rsp.end(err.message);
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
        form.uploadDir = fileRelPath;
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
}).listen(BIND_PORT, BIND_IP);
