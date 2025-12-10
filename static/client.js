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
        statusBadge.textContent = 'Error loading channels';
    }
}

refreshBtn.addEventListener('click', refreshChannels);
refreshChannels();

channelsSelect.addEventListener('change', () => {
    if (channelsSelect.value && !channelsSelect.value.startsWith('--')) {
        connectToChannel(channelsSelect.value);
    }
});

// --- 2. Connection Logic ---
async function connectToChannel(lang) {
    currentLang = lang;
    channelSetup.style.display = 'none';
    playerUi.style.display = 'block';
    currentChannelLabel.textContent = lang;
    updateStatus('Connecting...', false);

    await requestWakeLock();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(protocol + '://' + window.location.host + '/ws/client');

    ws.onopen = async () => {
        ws.send(JSON.stringify({ type: "join", value: lang }));

        pc = new RTCPeerConnection();

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') {
                // No Alert: Just update status
                updateStatus('Connection Blocked', false);
                setTimeout(() => disconnect(), 2000);
            }
        };

        pc.ontrack = (event) => {
            const receiver = event.receiver;
            if (receiver.playoutDelayHint !== undefined) {
                receiver.playoutDelayHint = 0;
            }
            audioElement.srcObject = event.streams[0];
            
            audioElement.play().then(() => {
                setupMediaSession(currentLang);
                updatePlayButtonUI(true);
                updateStatus('Live', true);
            }).catch(e => {
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
        } 
        else if (msg.type === 'channel_closed') {
            // NO ALERT: Update UI directly
            updateStatus('Session Ended by Host', false);
            disconnect(false); // false = don't clear status immediately
        }
        else if (msg.type === 'error') {
            updateStatus(msg.message, false);
            setTimeout(() => disconnect(), 2000);
        }
    };

    ws.onclose = () => {
        if (playerUi.style.display === 'block' && statusBadge.textContent === 'Live') {
             updateStatus('Disconnected', false);
        }
    };
}

function disconnect(resetStatus = true) {
    if (pc) { pc.close(); pc = null; }
    if (ws) { ws.close(); ws = null; }
    
    audioElement.srcObject = null;
    audioElement.load();
    
    playerUi.style.display = 'none';
    channelSetup.style.display = 'block';
    updatePlayButtonUI(false);
    
    if (resetStatus) {
        updateStatus('Disconnected', false);
    }
    refreshChannels();
}

playPauseBtn.addEventListener('click', () => {
    if (audioElement.paused) audioElement.play();
    else audioElement.pause();
});

stopBtn.addEventListener('click', () => disconnect(true));

audioElement.addEventListener('play', () => { updatePlayButtonUI(true); updateStatus('Live', true); });
audioElement.addEventListener('pause', () => { updatePlayButtonUI(false); updateStatus('Paused', false); });

function updatePlayButtonUI(isPlaying) {
    if (isPlaying) {
        playPauseBtn.textContent = "❚❚";
        playPauseBtn.classList.add('playing');
    } else {
        playPauseBtn.textContent = "▶";
        playPauseBtn.classList.remove('playing');
    }
}

function updateStatus(text, isLive) {
    statusBadge.textContent = text;
    if (isLive) statusBadge.classList.add('live');
    else statusBadge.classList.remove('live');
}

function setupMediaSession(channelName) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: channelName + " Interpretation",
            artist: "9MCLC Live",
            album: "Sunday Service",
            artwork: [{ src: '/static/logo.png', sizes: '512x512', type: 'image/png' }]
        });
        navigator.mediaSession.setActionHandler('play', () => audioElement.play());
        navigator.mediaSession.setActionHandler('pause', () => audioElement.pause());
        navigator.mediaSession.setActionHandler('stop', () => disconnect());
    }
}

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch (err) {}
}
document.addEventListener('visibilitychange', async () => {
    if (wakeLock !== null && document.visibilityState === 'visible') await requestWakeLock();
});