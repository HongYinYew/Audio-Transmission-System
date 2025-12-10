const refreshBtn = document.getElementById('refresh');
const channelsSelect = document.getElementById('channels');
const joinBtn = document.getElementById('join');
const leaveBtn = document.getElementById('leave');
const statusDiv = document.getElementById('status');
const audioElement = document.getElementById('audio');

let ws = null;
let pc = null;
let wakeLock = null;
let currentLang = "";

// 1. Fetch Channels
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

// 2. Join Channel Logic
joinBtn.addEventListener('click', async () => {
    const lang = channelsSelect.value;
    if (!lang || lang.startsWith("--")) return;

    currentLang = lang;
    joinBtn.disabled = true;
    statusDiv.textContent = 'Connecting...';
    
    // Request Wake Lock immediately on user interaction
    await requestWakeLock();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(protocol + '://' + window.location.host + '/ws/client');

    ws.onopen = async () => {
        ws.send(JSON.stringify({ type: "join", value: lang }));

        pc = new RTCPeerConnection();

        // FIX 1: Don't kill connection on "disconnected". Only on "failed".
        // "disconnected" happens often on mobile (WiFi->4G switch) and recovers automatically.
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                statusDiv.textContent = 'Connection failed (Network blocked)';
                cleanup();
            }
        };

        pc.ontrack = (event) => {
            // High Performance Mode
            const receiver = event.receiver;
            if (receiver.playoutDelayHint !== undefined) {
                receiver.playoutDelayHint = 0;
            }
            
            audioElement.srcObject = event.streams[0];
            
            // FIX 2: Only setup the Media Notification AFTER audio starts playing
            audioElement.play()
                .then(() => {
                    console.log("Audio started playing");
                    setupMediaSession(currentLang); // <--- MOVED HERE
                    statusDiv.textContent = `Connected to ${lang}`;
                    leaveBtn.disabled = false;
                })
                .catch(e => {
                    console.error("Autoplay failed", e);
                    statusDiv.textContent = "Tap Play manually to start";
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
    
    // Clear the notification
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = null;
    }

    audioElement.srcObject = null;
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
}

// FIX 3: Robust Media Session Setup
function setupMediaSession(channelName) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: "Live Interpretation",
            artist: channelName + " Channel",
            album: "9MCLC Live",
            artwork: [{ src: '/static/logo.png', sizes: '512x512', type: 'image/png' }]
        });
        
        // These handlers keep the notification alive
        navigator.mediaSession.setActionHandler('play', () => { audioElement.play(); });
        navigator.mediaSession.setActionHandler('pause', () => { audioElement.pause(); });
        navigator.mediaSession.setActionHandler('stop', () => cleanup());
    }
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Screen Wake Lock Active');
        }
    } catch (err) {
        console.log('Wake Lock skipped');
    }
}

// Re-acquire Wake Lock if the user switches apps and comes back
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});