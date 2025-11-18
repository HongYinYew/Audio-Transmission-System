const languageInput = document.getElementById('language');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusDiv = document.getElementById('status');

let ws;
let mediaRecorder;
let stream;

startBtn.addEventListener('click', async () => {
    const lang = languageInput.value.trim();
    if (!lang) {
        statusDiv.textContent = 'Please enter a language';
        return;
    }
    statusDiv.textContent = 'Connecting...';
    ws = new WebSocket('ws://' + window.location.host + '/ws/transmitter');
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
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const options = { mimeType: 'audio/webm;codecs=opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            options.mimeType = 'audio/webm';
        }
        mediaRecorder = new MediaRecorder(stream, options);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && ws.readyState === WebSocket.OPEN) {
                ws.send(event.data);
            }
        };
        mediaRecorder.start(100); // Send chunks every 100ms
    } catch (err) {
        statusDiv.textContent = 'Error accessing microphone: ' + err.message;
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
