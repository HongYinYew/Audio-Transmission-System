const channelsSelect = document.getElementById('channels');
const refreshBtn = document.getElementById('refresh-btn');
const playPauseBtn = document.getElementById('play-pause-btn');
const stopBtn = document.getElementById('stop-btn');
const statusBadge = document.getElementById('status');
const audioElement = document.getElementById('audio');
const playerUi = document.getElementById('player-ui');
const channelSetup = document.getElementById('channel-setup');
const currentChannelLabel = document.getElementById('current-channel-name');

let ws = null;
let pc = null;
let wakeLock = null;
let currentLang = "";

// --- 1. Channel Management ---

async function refreshChannels() {
    try {
        const res = await fetch('/api/channels');
        const channels = await res.json();
        channelsSelect.innerHTML = '';
        
        if (channels.length === 0) {
            const opt = document.createElement('option');
            opt.textContent = "-- No Live Channels --";
            channelsSelect.appendChild(opt);
            playPauseBtn.disabled = true;
        } else {
            const defaultOpt = document.createElement('option');
            defaultOpt.textContent = "Select a Language...";
            defaultOpt.disabled = true;
            defaultOpt.selected = true;
            channelsSelect.appendChild(defaultOpt);

            channels.forEach(lang => {
                const opt = document.createElement('option');
                opt.value = lang;
                opt.textContent = lang;
                channelsSelect.appendChild(opt);
            });
            playPauseBtn.disabled = false;
        }
    } catch (err) {
        console.error(err);
        statusBadge.textContent = 'Error loading channels';
    }
}

refreshBtn.addEventListener('click', refreshChannels);
refreshChannels();

// When user selects a channel, we treat it as "Connect & Play"
channelsSelect.addEventListener('change', () => {
    if (channelsSelect.value && !channelsSelect.value.startsWith('--')) {
        connectToChannel(channelsSelect.value);
    }
});


// --- 2. Connection Logic (WebRTC) ---

async function connectToChannel(lang) {
    currentLang = lang;
    
    // Switch UI
    channelSetup.style.display = 'none';
    playerUi.style.display = 'block';
    currentChannelLabel.textContent = lang;
    updateStatus('Connecting...', false);

    // Setup Wake Lock & Audio
    await requestWakeLock();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(protocol + '://' + window.location.host + '/ws/client');

    ws.onopen = async () => {
        ws.send(JSON.stringify({ type: "join", value: lang }));

        pc = new RTCPeerConnection();

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                updateStatus('Connection Failed', false);
                disconnect();
            }
        };

        pc.ontrack = (event) => {
            // Audio Stream Received
            audioElement.srcObject = event.streams[0];
            
            // Attempt Auto-Play
            audioElement.play()
                .then(() => {
                    setupMediaSession(lang); // Setup Notification
                    updatePlayButtonUI(true); // Show Pause Icon
                    updateStatus('Live', true);
                })
                .catch(err => {
                    console.warn("Autoplay blocked, waiting for user interaction", err);
                    updateStatus('Tap Play to Start', false);
                    updatePlayButtonUI(false);
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
        } else if (msg.type === 'channel_closed' || msg.type === 'error') {
            alert(msg.message);
            disconnect();
        }
    };

    ws.onclose = () => {
        if (playerUi.style.display === 'block') {
            updateStatus('Disconnected', false);
        }
    };
}

function disconnect() {
    if (pc) { pc.close(); pc = null; }
    if (ws) { ws.close(); ws = null; }
    
    // Reset Audio
    audioElement.srcObject = null;
    audioElement.load(); // Releases audio resources
    
    // Reset UI
    playerUi.style.display = 'none';
    channelSetup.style.display = 'block';
    updatePlayButtonUI(false);
    updateStatus('Disconnected', false);
    refreshChannels(); // Refresh list to see if channel still exists
}


// --- 3. Player Control Logic ---

// Toggle Play/Pause
playPauseBtn.addEventListener('click', () => {
    if (audioElement.paused) {
        audioElement.play();
    } else {
        audioElement.pause();
    }
});

// Stop / Leave
stopBtn.addEventListener('click', disconnect);

// SYNC: Listen to the actual audio element events
// This ensures that if Android Notification pauses the audio, OUR button updates.
audioElement.addEventListener('play', () => {
    updatePlayButtonUI(true);
    updateStatus('Live', true);
});

audioElement.addEventListener('pause', () => {
    updatePlayButtonUI(false);
    updateStatus('Paused', false);
});


// --- 4. Helper Functions ---

function updatePlayButtonUI(isPlaying) {
    if (isPlaying) {
        playPauseBtn.textContent = "❚❚"; // Pause Icon
        playPauseBtn.classList.add('playing');
    } else {
        playPauseBtn.textContent = "▶"; // Play Icon
        playPauseBtn.classList.remove('playing');
    }
}

function updateStatus(text, isLive) {
    statusBadge.textContent = text;
    if (isLive) {
        statusBadge.classList.add('live');
    } else {
        statusBadge.classList.remove('live');
    }
}

// --- 5. Android Integration (Media Session & Wake Lock) ---

function setupMediaSession(channelName) {
    if ('mediaSession' in navigator) {
        if ('mediaSession' in navigator) {
            console.log("✅ Success: Media Session API is supported and active!");
        } else {
            alert("❌ Error: Media Session API is disabled. You are likely not on HTTPS.");
            console.log("Media Session API missing. Check HTTPS/Secure Context.");
        }
        navigator.mediaSession.metadata = new MediaMetadata({
            title: channelName + " Interpretation",
            artist: "9MCLC Live",
            album: "Sunday Service",
            artwork: [
                { src: '/static/logo.png', sizes: '512x512', type: 'image/png' }
            ]
        });

        // Binds Lock Screen Buttons to Audio Element
        navigator.mediaSession.setActionHandler('play', () => audioElement.play());
        navigator.mediaSession.setActionHandler('pause', () => audioElement.pause());
        navigator.mediaSession.setActionHandler('stop', () => disconnect());
    }
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
        }
    } catch (err) {
        console.log("Wake Lock not supported or rejected");
    }
}

// Re-acquire Wake Lock if tab becomes visible again (it releases on minimize)
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') {
        await requestWakeLock();
    }
});