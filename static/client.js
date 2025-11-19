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
let mediaSourceURL = null;
const DEBUG = false;

refreshBtn.addEventListener('click', async () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        ws = new WebSocket('wss://' + window.location.host + '/ws/client');
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            statusDiv.textContent = 'Connected to Server';
            if (DEBUG) console.log('[client] WebSocket open to server');
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
                    if (DEBUG && arrayBuffer) console.log('[client] received binary chunk, bytes=', arrayBuffer.byteLength, 'queue=', queue.length);
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
            // Ensure media resources are cleaned up so queued chunks
            // don't try to append to a removed SourceBuffer.
            cleanupMedia();
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
        // create and keep the object URL so we can revoke it on cleanup
        if (mediaSourceURL) {
            try { URL.revokeObjectURL(mediaSourceURL); } catch {}
            mediaSourceURL = null;
        }
        mediaSourceURL = URL.createObjectURL(mediaSource);
        // Mute the audio element initially so Chrome will allow autoplay.
        // User can click the audio element to unmute (we add a handler below).
        try { audioElement.muted = false; } catch (e) {}
        audioElement.src = mediaSourceURL;

        // Allow user to unmute by clicking the audio control
        audioElement.addEventListener('click', () => {
            if (audioElement.muted) {
                audioElement.muted = false;
                audioElement.play().catch(() => {});
                statusDiv.textContent = 'Unmuted';
            }
        }, { once: false });

        mediaSource.addEventListener('sourceopen', (e) => {
            const ms = e.target || mediaSource;
            if (DEBUG) console.log('[client] mediaSource sourceopen, readyState=', ms.readyState);
            // Ensure the MediaSource is actually open before adding buffer
            if (ms.readyState !== 'open') {
                // Try again shortly if this unexpectedly happens
                setTimeout(() => { return initMediaSource().then(resolve); }, 100);
                return;
            }

            try {
                sourceBuffer = ms.addSourceBuffer(mimeType);
            } catch (err) {
                // Some browsers may have race conditions where addSourceBuffer
                // is attempted while the MediaSource isn't yet fully ready.
                console.warn('addSourceBuffer failed, retrying:', err);
                setTimeout(() => {
                    try {
                        sourceBuffer = ms.addSourceBuffer(mimeType);
                    } catch (err2) {
                        console.error('addSourceBuffer retry failed:', err2);
                        return resolve();
                    }
                    sourceBuffer.mode = 'sequence';
                    sourceBuffer.addEventListener('updateend', processQueue);
                    setTimeout(() => { ready = true; processQueue(); }, 200);
                    resolve();
                }, 150);
                return;
            }

            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', processQueue);
            // delay start ~2 s to buffer a few chunks
            setTimeout(() => {
                ready = true;
                if (DEBUG) console.log('[client] ready true; starting processQueue; queue=', queue.length);
                processQueue();
                // Try to play the audio element proactively (muted to satisfy autoplay policy)
                try { audioElement.play().catch(() => { if (DEBUG) console.log('[client] audio.play() blocked'); }); } catch (e) {}
                statusDiv.textContent = 'Joined Channel';
            }, 200);
            resolve();
        });
    });
}

function processQueue() {
    // Basic guards: ensure we're ready, have a sourceBuffer, and mediaSource
    if (!ready || !sourceBuffer || !mediaSource || queue.length === 0) return;
    // Ensure the mediaSource is still open. If it's not open yet,
    // keep queued data and retry shortly — do not drop it.
    if (mediaSource.readyState !== 'open') {
        // schedule a retry; this keeps the queued chunks until the source opens
        setTimeout(processQueue, 100);
        return;
    }
    // Ensure the sourceBuffer is still attached to the mediaSource
    try {
        const sbList = Array.from(mediaSource.sourceBuffers || []);
        if (!sbList.includes(sourceBuffer)) {
            console.warn('SourceBuffer was removed from MediaSource; cleaning up');
            cleanupMedia();
            queue = [];
            return;
        }
    } catch (e) {
        // defensively handle any weird browser states
        console.warn('Error checking sourceBuffers:', e);
    }
    if (sourceBuffer.updating) return;
    const chunk = queue.shift();
    try {
        if (DEBUG) console.log('[client] appending chunk, bytes=', chunk.byteLength);
        sourceBuffer.appendBuffer(chunk);
        // after appending, ensure playback is attempted
        setTimeout(() => { if (audioElement.paused) { audioElement.play().catch(() => { if (DEBUG) console.log('[client] play blocked after append'); }); } }, 50);
        // Log playing state
        audioElement.addEventListener('playing', () => { if (DEBUG) console.log('[client] audio playing'); }, { once: true });
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
    // clear ready state and queued chunks so we don't try appending after teardown
    ready = false;
    queue = [];
    // Revoke previously created object URL and clear source
    try {
        if (mediaSourceURL) {
            URL.revokeObjectURL(mediaSourceURL);
            mediaSourceURL = null;
        }
    } catch (err) { /* ignore */ }
    audioElement.removeAttribute('src');
    audioElement.load();
}
