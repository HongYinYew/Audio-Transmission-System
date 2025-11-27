const refreshBtn = document.getElementById('refresh');
const channelsSelect = document.getElementById('channels');
const joinBtn = document.getElementById('join');
const leaveBtn = document.getElementById('leave');
const statusDiv = document.getElementById('status');
const audioElement = document.getElementById('audio');

let ws = null;
let pc = null;

async function refreshChannels() {
    try {
        const res = await fetch('/api/channels');
        const channels = await res.json();
        channelsSelect.innerHTML = '';
        if (channels.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = "-- No Active Channels --";
            channelsSelect.appendChild(opt);
            joinBtn.disabled = true;
        } else {
            channels.forEach(lang => {
                const opt = document.createElement('option');
                opt.value = lang;
                opt.textContent = lang;
                channelsSelect.appendChild(opt);
            });
            joinBtn.disabled = false;
        }
    } catch (err) {
        statusDiv.textContent = 'Failed to load channels';
    }
}

refreshBtn.addEventListener('click', refreshChannels);
refreshChannels();

joinBtn.addEventListener('click', async () => {
    const lang = channelsSelect.value;
    if (!lang || lang.startsWith("--")) return;

    joinBtn.disabled = true;
    statusDiv.textContent = 'Connecting...';

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(protocol + '://' + window.location.host + '/ws/client');

    ws.onopen = async () => {
        ws.send(JSON.stringify({ type: "join", value: lang }));

        pc = new RTCPeerConnection();

        // Detect if network connection drops or server closes PC
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                statusDiv.textContent = 'Connection lost (Network error)';
                cleanup();
            }
        };

        pc.ontrack = (event) => {
            audioElement.srcObject = event.streams[0];
            audioElement.play().catch(e => {
                statusDiv.textContent = "Audio ready. Click Play if silent.";
            });
        };

        pc.addTransceiver('audio', { direction: 'recvonly' });

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
            statusDiv.textContent = `Connected to ${lang}`;
            leaveBtn.disabled = false;
        } 
        else if (msg.type === 'channel_closed') {
            statusDiv.textContent = msg.message;
            cleanup();
            refreshChannels();
        }
        else if (msg.type === 'error') {
            statusDiv.textContent = msg.message;
            cleanup();
        }
    };

    ws.onclose = () => {
        if (statusDiv.textContent.includes('Connected')) {
             statusDiv.textContent = 'Disconnected (Server unreachable)';
        }
        cleanup();
    };
});

leaveBtn.addEventListener('click', () => {
    statusDiv.textContent = 'Left channel';
    cleanup();
});

function cleanup() {
    if (pc) { pc.close(); pc = null; }
    if (ws) { ws.close(); ws = null; }
    audioElement.srcObject = null;
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
}