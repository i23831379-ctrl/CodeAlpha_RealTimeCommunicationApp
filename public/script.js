// Client-side logic for chat, video, and whiteboard using Socket.io
const socket = io();
let localStream = null;

// -------------------------------------------------
// UI bootstrap – build the full app layout dynamically
// -------------------------------------------------
function buildLayout() {
  const joinScreen = document.createElement('div');
  joinScreen.id = 'joinScreen';
  joinScreen.className = 'overlay';
  joinScreen.innerHTML = `
    <div class="join-panel">
      <h2>REAL‑TIME COMMUNICATION</h2>
      <p>Connect. Communicate. Collaborate.</p>
      <input type="text" id="usernameInput" placeholder="Username" autocomplete="off" />
      <input type="text" id="roomInput" placeholder="Room ID (optional)" autocomplete="off" />
      <button id="joinBtn">JOIN ROOM</button>
    </div>`;
  document.body.appendChild(joinScreen);

  const app = document.createElement('div');
  app.id = 'app';
  app.className = 'hidden';
  app.innerHTML = `
    <header class="app-header"><h1>LiveChat</h1><span id="connectionStatus" class="status-dot"></span></header>
    <main class="app-main">
      <aside class="participants-panel"><h3>PARTICIPANTS</h3><ul id="participantsList"></ul></aside>
      <section class="main-area">
        <section class="video-panel"><video id="localVideo" autoplay muted playsinline class="video-box"></video><video id="remoteVideo" autoplay playsinline class="video-box"></video></section>
        <section class="whiteboard-panel"><canvas id="whiteboard"></canvas><div class="wb-tools"><input type="color" id="colorPicker" value="#ff0000"/><input type="range" id="brushSize" min="1" max="10" value="3"/><button id="clearBtn">Clear</button></div></section>
        <section class="chat-section"><div class="chat-window" id="chatWindow"></div><footer class="chat-input"><input type="text" id="messageInput" placeholder="Type a message..." autocomplete="off"/><button id="sendBtn">Send</button></footer></section>
      </section>
    </main>
    <footer class="control-bar"><button id="muteBtn" aria-label="Mute/Unmute Microphone">🎤</button><button id="cameraBtn" aria-label="Enable/Disable Camera">📹</button><button id="screenShareBtn" aria-label="Screen Share">🖥️</button><button id="leaveBtn" aria-label="Leave Room">🚪</button></footer>`;
  document.body.appendChild(app);
}
buildLayout();
// Store current room and username
let currentRoomId = null;
let currentUsername = null;

// ---------- Join Logic ----------
function initJoinLogic() {
  const joinBtn = document.getElementById('joinBtn');
  const usernameInput = document.getElementById('usernameInput');
  const roomInput = document.getElementById('roomInput');

  joinBtn.addEventListener('click', () => {
    const username = usernameInput.value.trim() || 'Anonymous';
    const roomId = roomInput.value.trim() || (`room-${Math.random().toString(36).substr(2, 9)}`);
    currentRoomId = roomId;
    currentUsername = username;

    // Emit join request
    socket.emit('join-room', { roomId, username });
    // Start video after joining the room
    startVideo();

    // UI transition
    document.getElementById('joinScreen').classList.add('hidden');
    const appEl = document.getElementById('app');
    appEl.classList.remove('hidden');
  });

  // Receive participant list
  socket.on('room-users', participants => {
    const list = document.getElementById('participantsList');
    list.innerHTML = '';
    participants.forEach(p => {
      const li = document.createElement('li');
      li.id = `p-${p.socketId}`;
      li.textContent = p.username;
      list.appendChild(li);
    });
  });

  // New participant joined
  socket.on('user-joined', data => {
    const li = document.createElement('li');
    li.id = `p-${data.socketId}`;
    li.textContent = data.username;
    document.getElementById('participantsList').appendChild(li);
    addChatMessage(`${data.username} joined the room`, 'system');
  });

  // Participant left
  socket.on('user-left', data => {
    const li = document.getElementById(`p-${data.socketId}`);
    if (li) li.remove();
    addChatMessage(`${data.username} left the room`, 'system');
  });

  // Typing indicator handling
  const typingStatus = document.createElement('div');
  typingStatus.id = 'typingStatus';
  typingStatus.className = 'typing';
  document.getElementById('chatWindow').appendChild(typingStatus);

  let typingTimeout;
  messageInput.addEventListener('input', () => {
    socket.emit('typing', { roomId: currentRoomId, username: currentUsername, typing: true });
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      socket.emit('typing', { roomId: currentRoomId, username: currentUsername, typing: false });
    }, 1500);
  });

  socket.on('typing', ({ username, typing }) => {
    typingStatus.textContent = typing ? `${username} is typing...` : '';
  });

  // Media control buttons
  const muteBtn = document.getElementById('muteBtn');
  const cameraBtn = document.getElementById('cameraBtn');
  const screenBtn = document.getElementById('screenShareBtn');
  const leaveBtn = document.getElementById('leaveBtn');

  muteBtn.addEventListener('click', () => {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    muteBtn.textContent = audioTrack.enabled ? '🎤' : '🔇';
  });

  cameraBtn.addEventListener('click', () => {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    cameraBtn.textContent = videoTrack.enabled ? '📹' : '📷';
  });

  screenBtn.addEventListener('click', async () => {
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = screenStream.getVideoTracks()[0];
      // Replace track in peer connection
      const sender = peerConn.getSenders().find(s => s.track.kind === 'video');
      if (sender) sender.replaceTrack(screenTrack);
      // When screen sharing ends, revert to webcam
      screenTrack.onended = async () => {
        const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
        const camTrack = camStream.getVideoTracks()[0];
        const sender2 = peerConn.getSenders().find(s => s.track.kind === 'video');
        if (sender2) sender2.replaceTrack(camTrack);
      };
    } catch (e) {
      console.error('Screen share failed', e);
    }
  });

  leaveBtn.addEventListener('click', () => {
    socket.disconnect();
    window.location.reload();
  });
}

initJoinLogic();

// ------- Chat UI -------
const chatWindow = document.getElementById('chatWindow');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');

function addChatMessage(text, author = 'self') {
  const msgEl = document.createElement('div');
  msgEl.className = `message ${author}`;
  msgEl.textContent = text;
  chatWindow.appendChild(msgEl);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

function sendChatMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  socket.emit('chat', { text, sender: socket.id });
  addChatMessage(text, 'self');
  messageInput.value = '';
}

sendBtn.addEventListener('click', sendChatMessage);
messageInput.addEventListener('keypress', e => {
  if (e.key === 'Enter') sendChatMessage();
});

// Update connection status UI
socket.on('connect', () => {
  const statusDot = document.getElementById('connectionStatus');
  if (statusDot) {
    statusDot.style.background = 'limegreen';
    statusDot.title = 'Connected';
    statusDot.style.width = '12px';
    statusDot.style.height = '12px';
    statusDot.style.borderRadius = '50%';
    statusDot.style.display = 'inline-block';
  }
});

socket.on('disconnect', () => {
  const statusDot = document.getElementById('connectionStatus');
  if (statusDot) {
    statusDot.style.background = 'orangered';
    statusDot.title = 'Disconnected';
  }
});
socket.on('chat', data => {
  if (data.sender === socket.id) return; // ignore own
  addChatMessage(data.text, 'peer');
});

// ------- Video Call -------
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
let peerConn = null;
const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

async function startVideo() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream = stream;
    localVideo.srcObject = stream;
    setupPeerConnection(stream);
  } catch (err) {
    console.error('Failed to get media', err);
  }
}

function setupPeerConnection(stream) {
  peerConn = new RTCPeerConnection(config);
  if (stream) {
    stream.getTracks().forEach(t => peerConn.addTrack(t, stream));
  }

  peerConn.onicecandidate = event => {
    if (event.candidate) {
      socket.emit('signal', { target: null, candidate: event.candidate, roomId: currentRoomId });
    }
  };

  peerConn.ontrack = event => {
    remoteVideo.srcObject = event.streams[0];
  };

  // Create offer if we are the initiator
  peerConn.createOffer()
    .then(offer => peerConn.setLocalDescription(offer))
    .then(() => {
      socket.emit('signal', { target: null, description: peerConn.localDescription, roomId: currentRoomId });
    })
    .catch(console.error);
}

socket.on('signal', async data => {
  if (data.description) {
    if (!peerConn) peerConn = new RTCPeerConnection(config);
    await peerConn.setRemoteDescription(new RTCSessionDescription(data.description));
    if (data.description.type === 'offer') {
      const answer = await peerConn.createAnswer();
      await peerConn.setLocalDescription(answer);
      socket.emit('signal', { target: null, description: peerConn.localDescription, roomId: currentRoomId });
    }
  } else if (data.candidate) {
    if (peerConn) peerConn.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

// startVideo() will be called after successful join

// ------- Whiteboard -------
const canvas = document.getElementById('whiteboard');
const ctx = canvas.getContext('2d');
let drawing = false;
const colorPicker = document.getElementById('colorPicker');
const brushSize = document.getElementById('brushSize');
const clearBtn = document.getElementById('clearBtn');

function drawLine(x0, y0, x1, y1, color, size, emit) {
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.closePath();

  if (!emit) return;
  const w = canvas.width;
  const h = canvas.height;
  socket.emit('draw', {
    x0: x0 / w,
    y0: y0 / h,
    x1: x1 / w,
    y1: y1 / h,
    color,
    size,
  });
}

canvas.addEventListener('mousedown', e => {
  drawing = true;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  canvas.lastX = x;
  canvas.lastY = y;
});

canvas.addEventListener('mousemove', e => {
  if (!drawing) return;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  drawLine(canvas.lastX, canvas.lastY, x, y, colorPicker.value, brushSize.value, true);
  canvas.lastX = x;
  canvas.lastY = y;
});

canvas.addEventListener('mouseup', () => (drawing = false));
canvas.addEventListener('mouseleave', () => (drawing = false));

clearBtn.addEventListener('click', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  socket.emit('clear');
});

socket.on('draw', data => {
  const w = canvas.width;
  const h = canvas.height;
  drawLine(data.x0 * w, data.y0 * h, data.x1 * w, data.y1 * h, data.color, data.size);
});

socket.on('clear', () => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
});
