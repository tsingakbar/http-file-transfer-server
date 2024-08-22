function humanFileSize(size) {
    if (size == 0) { return '0B'; }
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return (size / Math.pow(1024, i)).toFixed(2) * 1 + ' ' + ['B', 'KiB', 'MiB', 'GiB', 'TiB'][i];
};

function fileSelected() {
    var file = document.getElementById('fileToUpload').files[0];
    if (file) {
        document.getElementById('fileName').innerHTML = file.name;
        document.getElementById('fileSize').innerHTML = humanFileSize(file.size);
        document.getElementById('fileType').innerHTML = file.type;
    }
}

function uploadFile() {
    var fileToUpload = document.getElementById('fileToUpload').files[0];
    if (fileToUpload === undefined) {
        alert("You need to first select the file to be uploaded");
        return;
    }
    var fd = new FormData();
    fd.append('up', fileToUpload);
    var xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", uploadProgress.bind({
        'prevSpeed': '0B/s',
        'prevStamp': Date.now(),
        'prevLoaded': 0,
    }), false);
    xhr.addEventListener("load", uploadComplete, false);
    xhr.addEventListener("error", uploadFailed, false);
    xhr.addEventListener("abort", uploadCanceled, false);
    xhr.open("POST", window.location.pathname);
    xhr.send(fd);
    document.getElementById('uploadButton').setAttribute('disabled', true);
}

function uploadProgress(evt) {
    if (evt.lengthComputable) {
        var stampNowMS = Date.now();
        if (stampNowMS - this.prevStamp > 1000) {
            var loadedInc = evt.loaded - this.prevLoaded;
            this.prevSpeed = humanFileSize(loadedInc / ((stampNowMS - this.prevStamp) / 1000)) + '/s';
            this.prevStamp = stampNowMS;
            this.prevLoaded = evt.loaded;
        }
        document.getElementById('progressNumber').innerHTML =
            Math.round(evt.loaded * 100 / evt.total).toString() + '% ' + this.prevSpeed;
    } else {
        document.getElementById('progressNumber').innerHTML = 'unable to compute';
    }
}

function uploadComplete(evt) {
    /* This event is raised when the server send back a response */
    alert(evt.target.responseText);
    document.getElementById('uploadButton').removeAttribute('disabled');
}

function uploadFailed(evt) {
    alert("There was an error attempting to upload the file.");
    document.getElementById('uploadButton').removeAttribute('disabled');
}

function uploadCanceled(evt) {
    alert("The upload has been canceled by the user or the browser dropped the connection.");
    document.getElementById('uploadButton').removeAttribute('disabled');
}

function fillFileListTable(fileList) {
    const tbFiles = document.getElementById('tbFiles');
    tbFiles.innerHTML = "";
    for (fileInfo of fileList) {
        const tr = document.createElement("tr");
        const hrefName = document.createElement("a");
        var hrefTextName = document.createTextNode(fileInfo.name);
        hrefName.appendChild(hrefTextName);
        hrefName.href = fileInfo.href;
        const tdName = document.createElement("td");
        tdName.appendChild(hrefName);
        tr.appendChild(tdName);
        const tdTailF = document.createElement("td");
        if (fileInfo.tailFAvail) {
            const hrefTailF = document.createElement("a");
            var hrefTextFailF = document.createTextNode("tail -f");
            hrefTailF.appendChild(hrefTextFailF);
            hrefTailF.href = `${fileInfo.href}?tail_f=1`;
            tdTailF.appendChild(hrefTailF);
        }
        tr.append(tdTailF);
        const tdMTime = document.createElement("td");
        tdMTime.textContent = fileInfo.mtime;
        tr.appendChild(tdMTime);
        const tdSizeHuman = document.createElement("td");
        tdSizeHuman.textContent = humanFileSize(fileInfo.size);
        tdSizeHuman.classList.add("td_right");
        tr.appendChild(tdSizeHuman);
        const tdSize = document.createElement("td");
        tdSize.textContent = fileInfo.size;
        tdSize.classList.add("td_right");
        tr.appendChild(tdSize);
        tbFiles.appendChild(tr);
    }
}

document.addEventListener('DOMContentLoaded', function () {
    fillFileListTable(window.fileList);
    const toggleSizeSortHandler = function (ev) {
        if (ev.target.textContent.endsWith('↓')) {
            ev.target.textContent = ev.target.textContent.slice(0, -1);
            fillFileListTable(window.fileList);
        } else {
            ev.target.textContent += '↓';
            fillFileListTable([...window.fileList].sort((a, b) => b.size - a.size));
        }
    };
    document.getElementById('thSizeHuman').addEventListener('click', toggleSizeSortHandler);
    document.getElementById('thSize').addEventListener('click', toggleSizeSortHandler);
});