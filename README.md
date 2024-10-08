# HTTP File Transfer Server
Handy tool to share files with your friends.

With any recent web browser, you can:
* browser files, equipped with a size sorter.
* download files from or upload files to this http server.
* `tail -f <your.log>` in your browser.

![image](screenshot.jpg)

## Frontend Features
* simple responsive html form supported by `simpleresponsive.css`
* ajax file uploading implemented with native frontend javascript(embedded in `index.mustache`)

## Backend Features
* implemented with node.js 
* native node.js to list directory and serve static file downloading
* native node.js to upgrade http connection to websocket, and construct websocket frames
* use `mustache` to render html to frontend
* use `formidable` to process file uploading 

## How to run it

1. clone this repo to places like `~/http-file-transfer-server`, and `npm install` all dependencies.
2. `cd /your/web/root/folder`
3. `node ~/http-file-transfer-server/app.js`, then all download/upload will happen under `/your/web/root/folder`.