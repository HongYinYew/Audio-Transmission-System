const languageInput = document.getElementById('language');
const processingCheckbox = document.getElementById('processing');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');

const statusBadge = document.getElementById('status');
const clientCountBadge = document.getElementById('client-count');
const setupForm = document.getElementById('setup-form');
const activeControls = document.getElementById('active-controls');
const subtitleText = document.getElementById('subtitle-text');

let ws = null;
let pc = null;
let localStream = null;

// --- UI HELPERS ---

function setUIState(state) {
    if (state === 'ready') {
        setupForm.style.display = 'block';
        activeControls.style.display = 'none';
        subtitleText.textContent = "Setup your channel";
        statusBadge.textContent = "Ready";
        statusBadge.className = "badge";
        clientCountBadge.style.display = 'none';
        languageInput.disabled = false;
    } 
    else if (state === 'transmitting') {
        setupForm.style.display = 'none';
        activeControls.style.display = 'block';
        subtitleText.textContent = "Broadcasting: " + languageInput.value;
        statusBadge.textContent = "Live";
        statusBadge.className = "badge live";
        clientCountBadge.style.display = 'block';
    }
}

// --- CORE LOGIC ---

// 1. Live Processing Toggle
processingCheckbox.addEventListener('change', async () => {
    if (!localStream) return; // Only affects if stream is running
    
    const useProcessing = processingCheckbox.checked;
    const track = localStream.getAudioTracks()[0];
    
    statusBadge.textContent = 'Updating Audio...';
    try {
        await track.applyConstraints({
            echoCancellation: useProcessing,
            noiseSuppression: useProcessing,
            autoGainControl: useProcessing,
        });
        statusBadge.textContent = useProcessing ? "Enhanced Audio" : "Raw Audio";
        setTimeout(() => statusBadge.textContent = "Live", 1500);
    } catch (err) {
        console.error('Failed to toggle processing:', err);
    }
});

// 2. Prevent accidental close
window.addEventListener('beforeunload', () => {
    stopTransmission();
});

// 3. Start Transmission
startBtn.addEventListener('click', async () => {
    const lang = languageInput.value.trim();
    if (!lang) {
        alert("Please enter a language name.");
        return;
    }

    startBtn.disabled = true;
    startBtn.textContent = "Starting...";
    
    const useProcessing = processingCheckbox.checked;

    try {
        // Audio Constraints (Standardized)
        const audioConstraints = {
            audio: {
                channelCount: 2, 
                echoCancellation: useProcessing,
                noiseSuppression: useProcessing,
                autoGainControl: useProcessing
            }
        };

        localStream = await navigator.mediaDevices.getUserMedia(audioConstraints);

        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(protocol + '://' + window.location.host + '/ws/transmitter');

        ws.onopen = async () => {
            ws.send(JSON.stringify({ type: "config", value: lang }));

            pc = new RTCPeerConnection();
            
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed') {
                    statusBadge.textContent = 'Network Error';
                    statusBadge.className = 'badge error';
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
                setUIState('transmitting');
                startBtn.disabled = false;
                startBtn.innerHTML = "<span>●</span> Start Broadcast"; // Reset text for next time
            } 
            else if (msg.type === 'client_count') {
                clientCountBadge.textContent = `${msg.count} Listeners`;
            }
            else if (msg.type === 'error') {
                alert(msg.message);
                stopTransmission();
            }
        };

        ws.onclose = () => {
            stopTransmission();
        };

    } catch (err) {
        console.error(err);
        alert("Microphone Error: " + err.message);
        stopTransmission();
    }
});

// 4. Stop Transmission
stopBtn.addEventListener('click', () => {
    stopTransmission();
});

function stopTransmission() {
    if (pc) { pc.close(); pc = null; }
    if (ws) { ws.close(); ws = null; }
    
    if (localStream) { 
        localStream.getTracks().forEach(t => t.stop()); 
        localStream = null; 
    }
    
    setUIState('ready');
    clientCountBadge.textContent = "0 Listeners";
}