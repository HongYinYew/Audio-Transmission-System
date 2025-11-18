const refreshBtn = document.getElementById('refresh');
const channelsSelect = document.getElementById('channels');
const joinBtn = document.getElementById('join');
const leaveBtn = document.getElementById('leave');
const statusDiv = document.getElementById('status');
const audioElement = document.getElementById('audio');

let ws;
let mediaSource;
let sourceBuffer;
let queue = [];      // queued audio chunks
let ready = false;

refreshBtn.addEventListener('click', async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        ws = new WebSocket('ws://' + window.location.host + '/ws/client');
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            statusDiv.textContent = 'Connected to Server';
            // Request channel list only after connection is open
            try { ws.send('list_channels'); } catch {}
        };
        ws.onmessage = async (event) => {
            if (typeof event.data === 'string') {
                try {
                    const data = JSON.parse(event.data);
                    channelsSelect.innerHTML = '';
                    data.forEach(lang => {
                        const opt = document.createElement('option');
                        opt.value = lang;
                        opt.textContent = lang;
                        channelsSelect.appendChild(opt);
                    });
                } catch { /* not JSON – ignore */ }
            } else {
                // Handle binary audio chunks (ArrayBuffer or Blob)
                let arrayBuffer;
                try {
                    if (event.data instanceof ArrayBuffer) {
                        arrayBuffer = event.data;
                    } else if (event.data instanceof Blob) {
                        arrayBuffer = await event.data.arrayBuffer();
                    } else if (ArrayBuffer.isView(event.data)) {
                        arrayBuffer = event.data.buffer;
                    }
                    if (arrayBuffer) {
                        queue.push(arrayBuffer);
                        processQueue();
                    }
                } catch (e) {
                    console.warn('Failed to handle binary data:', e);
                }
            }
        };
        ws.onclose = () => {
            statusDiv.textContent = 'Disconnected';
            joinBtn.disabled = false;
            leaveBtn.disabled = true;
            if (mediaSource && mediaSource.readyState === 'open') {
                mediaSource.endOfStream();
            }
        };
    }
});

joinBtn.addEventListener('click', async () => {
    const lang = channelsSelect.value;
    if (lang && ws) {
        await initMediaSource();
        ws.send('join ' + lang);
        joinBtn.disabled = true;
        leaveBtn.disabled = false;
        statusDiv.textContent = 'Joined ' + lang;
    }
});

leaveBtn.addEventListener('click', () => {
    if (ws) {
        ws.send('leave');
        joinBtn.disabled = false;
        leaveBtn.disabled = true;
        statusDiv.textContent = 'Left channel';
        cleanupMedia();
    }
});

function initMediaSource() {
    return new Promise((resolve) => {
        queue = [];
        ready = false;
        // Feature-detect MSE support for Opus in WebM
        const preferred = 'audio/webm; codecs=opus';
        const fallback = 'audio/webm';
        const mimeType = (window.MediaSource && MediaSource.isTypeSupported(preferred))
            ? preferred
            : (window.MediaSource && MediaSource.isTypeSupported(fallback)) ? fallback : null;

        if (!window.MediaSource || !mimeType) {
            statusDiv.textContent = 'Playback not supported: MediaSource WebM/Opus not available in this browser.';
            return resolve();
        }

        mediaSource = new MediaSource();
        audioElement.src = URL.createObjectURL(mediaSource);
        mediaSource.addEventListener('sourceopen', () => {
            sourceBuffer = mediaSource.addSourceBuffer(mimeType);
            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', processQueue);
            // delay start ~2 s to buffer a few chunks
            setTimeout(() => { ready = true; processQueue(); }, 200);
            resolve();
        });
    });
}

function processQueue() {
    if (!ready || !sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
    const chunk = queue.shift();
    try {
        sourceBuffer.appendBuffer(chunk);
    } catch (err) {
        console.warn('Append error:', err);
        queue = [];
    }
}

function cleanupMedia() {
    if (mediaSource) {
        try { mediaSource.endOfStream(); } catch {}
        mediaSource = null;
        sourceBuffer = null;
    }
    audioElement.removeAttribute('src');
    audioElement.load();
}
