const languageInput = document.getElementById('language');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusDiv = document.getElementById('status');
const clientCountDiv = document.getElementById('client-count');
const processingCheckbox = document.getElementById('processing'); 

let ws = null;
let pc = null;
let localStream = null;

// --- NEW: Live Toggle Feature ---
processingCheckbox.addEventListener('change', async () => {
    if (!localStream) return;
    const useProcessing = processingCheckbox.checked;
    const track = localStream.getAudioTracks()[0];
    statusDiv.textContent = 'Updating audio settings...';
    try {
        await track.applyConstraints({
            echoCancellation: useProcessing,
            noiseSuppression: useProcessing,
            autoGainControl: useProcessing,
        });
        const mode = useProcessing ? "(Processed)" : "(Raw Audio)";
        statusDiv.textContent = `Transmitting ${mode}`;
    } catch (err) {
        console.error('Failed to apply constraints:', err);
    }
});

// Ensure we clean up if the user closes the tab
window.addEventListener('beforeunload', () => {
    stopTransmission();
});

startBtn.addEventListener('click', async () => {
    const lang = languageInput.value.trim();
    if (!lang) {
        statusDiv.textContent = 'Please enter a language';
        return;
    }

    startBtn.disabled = true;
    statusDiv.textContent = 'Initializing...';
    clientCountDiv.textContent = 'Connected listeners: 0';

    const useProcessing = processingCheckbox.checked;

    try {
        // --- STANDARDIZED AUDIO CONSTRAINTS ---
        // This forces the browser to resample 16kHz/44.1kHz hardware to 48kHz 
        // BEFORE it even reaches your transmission logic.
        const audioConstraints = {
            audio: {
                // 1. Audio Quality Standards
                sampleRate: 48000,      // Standardized Sample Rate
                channelCount: 2,          // Force Stereo (even if mic is mono)
                sampleSize: 16,           // Prefer 16-bit integer
                
                // 2. Processing toggles
                echoCancellation: useProcessing,
                noiseSuppression: useProcessing,
                autoGainControl: useProcessing
            }
        };

        localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);

        // --- VERIFICATION LOG ---
        // This tells you what the browser ACTUALLY managed to get from the hardware
        const track = localStream.getAudioTracks()[0];
        const settings = track.getSettings();
        console.log("--- Audio Source Standardized ---");
        console.log(`Sample Rate: ${settings.sampleRate} Hz`);
        console.log(`Channels: ${settings.channelCount}`);
        console.log(`Latency: ${settings.latency} sec`);
        console.log("---------------------------------");

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(protocol + '://' + window.location.host + '/ws/transmitter');

        ws.onopen = async () => {
            ws.send(JSON.stringify({ type: "config", value: lang }));

            pc = new RTCPeerConnection();
            
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed') {
                    statusDiv.textContent = 'Network connection failed';
                    stopTransmission();
                }
            };

            localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            ws.send(JSON.stringify({
                sdp: pc.localDescription.sdp,
                type: pc.localDescription.type
            }));
        };

        ws.onmessage = async (event) => {
            const msg = JSON.parse(event.data);
            
            if (msg.type === 'answer') {
                await pc.setRemoteDescription(msg);
                const mode = useProcessing ? "(Processed)" : "(Raw Audio)";
                statusDiv.textContent = `Transmitting ${mode}`;
                stopBtn.disabled = false;
            } 
            else if (msg.type === 'client_count') {
                clientCountDiv.textContent = `Connected listeners: ${msg.count}`;
            }
            else if (msg.type === 'error') {
                statusDiv.textContent = msg.message;
                stopTransmission();
            }
        };

        ws.onclose = () => {
            statusDiv.textContent = 'Disconnected from server';
            stopTransmission();
        };

    } catch (err) {
        console.error(err);
        statusDiv.textContent = 'Error: ' + err.message;
        stopTransmission();
    }
});

stopBtn.addEventListener('click', () => {
    statusDiv.textContent = 'Broadcast stopped';
    stopTransmission();
});

function stopTransmission() {
    if (pc) { pc.close(); pc = null; }
    if (ws) { ws.close(); ws = null; }
    if (localStream) { 
        localStream.getTracks().forEach(t => t.stop()); 
        localStream = null; 
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
    clientCountDiv.textContent = '';
}