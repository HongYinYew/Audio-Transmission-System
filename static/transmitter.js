const languageInput = document.getElementById('language');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusDiv = document.getElementById('status');

let ws;
let mediaRecorder;
let stream;
let testAudio;

startBtn.addEventListener('click', async () => {
    const lang = languageInput.value.trim();
    if (!lang) {
        statusDiv.textContent = 'Please enter a language';
        return;
    }
    statusDiv.textContent = 'Connecting...';
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(protocol + '://' + window.location.host + '/ws/transmitter');
    ws.binaryType = 'arraybuffer';
    ws.onopen = async () => {
        statusDiv.textContent = 'Sending language...';
        ws.send(lang);
        try {
            const response = await ws.waitForMessage();
            if (response == 'Channel created') {
                statusDiv.textContent = 'Transmitting...';
                startBtn.disabled = true;
                stopBtn.disabled = false;
                await startRecording();
            } else {
                statusDiv.textContent = response;
                ws.close();
            }
        } catch (err) {
            statusDiv.textContent = 'Error: ' + err.message;
            ws.close();
        }
    };
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
            if (data.type === "client_count") {
                document.getElementById("client-count").textContent =
                    "Connected listeners: " + data.count;
                return;
            }
    };
    ws.onerror = (error) => {
        statusDiv.textContent = 'WebSocket error: ' + error.message;
    };
    ws.onclose = (event) => {
        if (event.code !== 1005) { // Not normal close
            statusDiv.textContent = 'Connection closed: ' + event.reason;
        } else {
            statusDiv.textContent = 'Disconnected';
        }
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
    };
});

stopBtn.addEventListener('click', () => {
    if (ws) ws.close();
});

async function startRecording() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                channelCount: 1,
                sampleRate: 48000,
                sampleSize: 16,
                echoCancellation: true,
                noiseSuppression: false,
                autoGainControl: false
            } 
        });
        const options = { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 128000 };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'audio/webm';
        }
        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                ws.send(event.data);
            }
        };
        mediaRecorder.start(1000); // Send chunks every 100ms
    } catch (err) {
        console.warn('Microphone error:', err);
        statusDiv.textContent = 'Microphone not available. Using test tone.';

        // Stream the test tone through captureStream() and MediaRecorder so the
        // server receives properly framed WebM/Opus blobs (like a real mic).
        const response = await fetch('/static/TestTone.webm');
        const audioData = await response.arrayBuffer();
        try {
            const audioEl = document.createElement('audio');
            audioEl.src = '/static/TestTone.webm';
            audioEl.loop = true;
            audioEl.muted = true; // allow autoplay in many browsers
            audioEl.playsInline = true;
            // Attach to DOM quietly so autoplay policies are friendlier (optional)
            audioEl.style.display = 'none';
            document.body.appendChild(audioEl);
            // Try to start playback; some browsers forbid autoplay unless muted
            try { await audioEl.play(); } catch (playErr) { /* ignore */ }

            // Give it a short time to become ready
            await new Promise(res => {
                if (audioEl.readyState >= 3) return res();
                const t = setTimeout(res, 300);
                audioEl.addEventListener('canplay', () => { clearTimeout(t); res(); }, { once: true });
            });

            // Capture the audio output as a MediaStream and record it
            if (typeof audioEl.captureStream === 'function') {
                stream = audioEl.captureStream();
                const options = { mimeType: 'audio/webm;codecs=opus' };
                if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = 'audio/webm';
                mediaRecorder = new MediaRecorder(stream, options);
                mediaRecorder.ondataavailable = (event) => {
                    if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                        ws.send(event.data);
                    }
                };
                mediaRecorder.start(100); // produce chunks every 100ms like live mic
                testAudio = audioEl; // keep reference so it isn't GC'd
            } else {
                // As a fallback if captureStream isn't available, send the whole
                // file periodically (less ideal but still functional).
                ws.send(audioData);
                setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(audioData); }, 2000);
            }
        } catch (err) {
            console.warn('Test tone fallback failed:', err);
        }
    }
}

// Helper to wait for message with timeout
WebSocket.prototype.waitForMessage = function(timeout = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            this.removeEventListener("message", handler);
            reject(new Error("Timeout waiting for response"));
        }, timeout);

        const handler = (event) => {
            clearTimeout(timer);
            this.removeEventListener("message", handler);
            resolve(event.data);
        };

        this.addEventListener("message", handler);
    });
};
