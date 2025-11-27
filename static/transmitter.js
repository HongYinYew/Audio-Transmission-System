const languageInput = document.getElementById('language');
const startBtn = document.getElementById('start');
const stopBtn = document.getElementById('stop');
const statusDiv = document.getElementById('status');
const clientCountDiv = document.getElementById('client-count');

let ws = null;
let pc = null;
let localStream = null;

startBtn.addEventListener('click', async () => {
    const lang = languageInput.value.trim();
    if (!lang) {
        statusDiv.textContent = 'Please enter a language';
        return;
    }

    startBtn.disabled = true;
    statusDiv.textContent = 'Initializing...';
    clientCountDiv.textContent = 'Connected listeners: 0';

    try {
        // Fetch Audio Stream
        localStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        });

        // Connect to Websocket
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        ws = new WebSocket(protocol + '://' + window.location.host + '/ws/transmitter');

        ws.onopen = async () => {
            // Create Channel
            ws.send(JSON.stringify({ type: "config", value: lang }));

            pc = new RTCPeerConnection();
            
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'failed') stopTransmission();
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
                statusDiv.textContent = `Transmitting in ${lang}`;
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

stopBtn.addEventListener('click', stopTransmission);

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