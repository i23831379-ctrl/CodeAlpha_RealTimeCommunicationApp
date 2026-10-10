import React, { useCallback, useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import "./styles.css";

type Participant = { socketId: string; username: string };
type ChatMessage = { text: string; author: "self" | "peer" | "system"; id: string };

const socket = io({ autoConnect: true });
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

const App: React.FC = () => {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const roomIdRef = useRef("");
  const usernameRef = useRef("");
  const makingOfferRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const screenTrackRef = useRef<MediaStreamTrack | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);

  const [username, setUsername] = useState("");
  const [roomId, setRoomId] = useState("");
  const [joined, setJoined] = useState(false);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [typingStatus, setTypingStatus] = useState("");
  const [activeTab, setActiveTab] = useState<"participants" | "chat">("chat");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [socketStatus, setSocketStatus] = useState<"connected" | "disconnected">(
    socket.connected ? "connected" : "disconnected"
  );
  const [callStatus, setCallStatus] = useState("Waiting for someone to join");
  const [screenSharing, setScreenSharing] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const addSystemMessage = useCallback((text: string) => {
    setChatMessages((old) => [
      ...old,
      { text, author: "system", id: `${Date.now()}-${Math.random()}` },
    ]);
  }, []);

  const sendSignal = useCallback((payload: Record<string, unknown>) => {
    socket.emit("signal", { ...payload, target: null, roomId: roomIdRef.current });
  }, []);

  const closePeerConnection = useCallback(() => {
    if (peerConnRef.current) {
      peerConnRef.current.ontrack = null;
      peerConnRef.current.onicecandidate = null;
      peerConnRef.current.onconnectionstatechange = null;
      peerConnRef.current.close();
      peerConnRef.current = null;
    }
    pendingCandidatesRef.current = [];
    setRemoteStream(null);
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
  }, []);

  const createPeerConnection = useCallback(() => {
    if (peerConnRef.current && peerConnRef.current.signalingState !== "closed") {
      return peerConnRef.current;
    }

    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnRef.current = pc;

    const localStream = localStreamRef.current;
    if (localStream) {
      localStream.getTracks().forEach((track) => {
        const alreadyAdded = pc.getSenders().some((sender) => sender.track?.id === track.id);
        if (!alreadyAdded) pc.addTrack(track, localStream);
      });
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal({ candidate: event.candidate });
    };

    pc.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (stream) {
        setRemoteStream(stream);
        if (remoteVideoRef.current) remoteVideoRef.current.srcObject = stream;
        setCallStatus("Connected");
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setCallStatus("Connected");
      else if (pc.connectionState === "connecting") setCallStatus("Connecting video…");
      else if (pc.connectionState === "failed") setCallStatus("Connection failed — try rejoining");
      else if (pc.connectionState === "disconnected") setCallStatus("Connection interrupted");
      else if (pc.connectionState === "closed") setCallStatus("Call ended");
    };

    return pc;
  }, [sendSignal]);

  const flushPendingCandidates = useCallback(async (pc: RTCPeerConnection) => {
    if (!pc.remoteDescription) return;
    const candidates = pendingCandidatesRef.current.splice(0);
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn("Could not add queued ICE candidate", error);
      }
    }
  }, []);

  const createOffer = useCallback(async () => {
    const pc = createPeerConnection();
    if (makingOfferRef.current || pc.signalingState !== "stable") return;
    try {
      makingOfferRef.current = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ description: pc.localDescription });
      setCallStatus("Calling…");
    } catch (error) {
      console.error("Could not create WebRTC offer", error);
      setCallStatus("Could not start call");
    } finally {
      makingOfferRef.current = false;
    }
  }, [createPeerConnection, sendSignal]);

  useEffect(() => {
    const onConnect = () => setSocketStatus("connected");
    const onDisconnect = () => setSocketStatus("disconnected");
    const onRoomUsers = (list: Participant[]) => {
      const safeList = Array.isArray(list) ? list : [];
      setParticipants(safeList);
      // Deterministic 1:1 offer rule: only the lexicographically smaller socket ID offers.
      // This prevents both peers from creating offers at the same time.
      const other = safeList.find((p) => p.socketId !== socket.id);
      if (other && socket.id && socket.id.localeCompare(other.socketId) < 0) {
        void createOffer();
      } else if (other) {
        setCallStatus("Waiting for the other participant to connect…");
      }
    };
    const onUserJoined = (data: Participant) => {
      if (!data?.socketId) return;
      setParticipants((old) =>
        old.some((p) => p.socketId === data.socketId) ? old : [...old, data]
      );
      addSystemMessage(`${data.username || "A participant"} joined the room`);
      if (socket.id && socket.id.localeCompare(data.socketId) < 0) {
        void createOffer();
      } else {
        setCallStatus("Waiting for the other participant to connect…");
      }
    };
    const onUserLeft = (data: Participant) => {
      setParticipants((old) => old.filter((p) => p.socketId !== data.socketId));
      addSystemMessage(`${data.username || "A participant"} left the room`);
      closePeerConnection();
      setCallStatus("Waiting for someone to join");
    };
    const onTyping = (data: { username?: string; typing?: boolean }) => {
      setTypingStatus(data?.typing ? `${data.username || "Someone"} is typing…` : "");
    };
    const onChat = (data: { text?: string; sender?: string; username?: string }) => {
      if (data?.sender === socket.id) return;
      if (typeof data?.text !== "string") return;
      setChatMessages((old) => [
        ...old,
        { text: data.text!, author: "peer", id: `${Date.now()}-${Math.random()}` },
      ]);
    };
    const onSignal = async (data: {
      description?: RTCSessionDescriptionInit;
      candidate?: RTCIceCandidateInit;
      sender?: string;
    }) => {
      try {
        if (!data) return;
        if (data.sender && data.sender === socket.id) return;
        const pc = createPeerConnection();
        if (data.description) {
          const description = new RTCSessionDescription(data.description);
          if (description.type === "offer") {
            // With the deterministic offer rule, an incoming offer should normally arrive
            // while this peer is stable. Handle unexpected glare by ignoring it safely.
            if (pc.signalingState !== "stable") {
              console.warn("Ignoring colliding offer; please rejoin if connection does not recover.");
              return;
            }
            await pc.setRemoteDescription(description);
            await flushPendingCandidates(pc);
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal({ description: pc.localDescription });
            setCallStatus("Connecting video…");
          } else if (description.type === "answer") {
            if (pc.signalingState === "have-local-offer") {
              await pc.setRemoteDescription(description);
              await flushPendingCandidates(pc);
            }
          }
        } else if (data.candidate) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          } else {
            pendingCandidatesRef.current.push(data.candidate);
          }
        }
      } catch (error) {
        console.error("WebRTC signaling error", error);
        setCallStatus("Connection error — try leaving and rejoining");
      }
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("room-users", onRoomUsers);
    socket.on("user-joined", onUserJoined);
    socket.on("user-left", onUserLeft);
    socket.on("typing", onTyping);
    socket.on("chat", onChat);
    socket.on("signal", onSignal);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("room-users", onRoomUsers);
      socket.off("user-joined", onUserJoined);
      socket.off("user-left", onUserLeft);
      socket.off("typing", onTyping);
      socket.off("chat", onChat);
      socket.off("signal", onSignal);
    };
  }, [addSystemMessage, closePeerConnection, createOffer, createPeerConnection, flushPendingCandidates, sendSignal]);

  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [joined, cameraEnabled]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      void remoteVideoRef.current.play().catch(() => undefined);
    }
  }, [remoteStream]);

  const handleJoin = async (event?: React.FormEvent) => {
    event?.preventDefault();
    setErrorMessage("");
    const user = username.trim() || "Anonymous";
    const room = roomId.trim() || `room-${Math.random().toString(36).slice(2, 9)}`;
    usernameRef.current = user;
    roomIdRef.current = room;
    setUsername(user);
    setRoomId(room);

    try {
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch (mediaError) {
        console.warn("Camera/microphone unavailable; joining without local media", mediaError);
        setErrorMessage("Camera/microphone access was unavailable. You can still join, but video/audio may be disabled.");
      }
      if (stream) {
        localStreamRef.current = stream;
        cameraTrackRef.current = stream.getVideoTracks()[0] || null;
        audioTrackRef.current = stream.getAudioTracks()[0] || null;
        setCameraEnabled(Boolean(cameraTrackRef.current));
        setAudioEnabled(Boolean(audioTrackRef.current));
      } else {
        setCameraEnabled(false);
        setAudioEnabled(false);
      }
      socket.emit("join-room", { roomId: room, username: user });
      setJoined(true);
      setCallStatus("Waiting for someone to join");
      if (stream && localVideoRef.current) localVideoRef.current.srcObject = stream;
      // Build a peer connection only when a stream is available; otherwise incoming offers
      // can still create one and answer if media is later added.
      if (stream) createPeerConnection();
    } catch (error) {
      console.error("Could not join room", error);
      setErrorMessage("Could not join the room. Check the server and try again.");
    }
  };

  const toggleMute = () => {
    const track = audioTrackRef.current || localStreamRef.current?.getAudioTracks()[0];
    if (!track) {
      setErrorMessage("No microphone track is available. Check browser permissions and rejoin.");
      return;
    }
    track.enabled = !track.enabled;
    setAudioEnabled(track.enabled);
  };

  const toggleCamera = () => {
    const track = cameraTrackRef.current || localStreamRef.current?.getVideoTracks()[0];
    if (!track) {
      setErrorMessage("No camera track is available. Check browser permissions and rejoin.");
      return;
    }
    track.enabled = !track.enabled;
    setCameraEnabled(track.enabled);
  };

  const shareScreen = async () => {
    if (!peerConnRef.current) {
      setErrorMessage("Join a room and connect to another participant before sharing your screen.");
      return;
    }
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const screenTrack = displayStream.getVideoTracks()[0];
      const sender = peerConnRef.current.getSenders().find((item) => item.track?.kind === "video");
      if (!sender || !screenTrack) {
        displayStream.getTracks().forEach((track) => track.stop());
        setErrorMessage("Screen sharing is not available for this connection.");
        return;
      }
      screenTrackRef.current = screenTrack;
      await sender.replaceTrack(screenTrack);
      setScreenSharing(true);
      screenTrack.onended = async () => {
        try {
          const cameraTrack = cameraTrackRef.current;
          if (cameraTrack && peerConnRef.current) {
            await sender.replaceTrack(cameraTrack);
          }
        } catch (error) {
          console.error("Could not restore camera after screen sharing", error);
        } finally {
          screenTrack.stop();
          screenTrackRef.current = null;
          setScreenSharing(false);
        }
      };
    } catch (error) {
      console.error("Screen sharing failed", error);
      setErrorMessage("Screen sharing was cancelled or unavailable.");
    }
  };

  const sendChat = () => {
    const text = chatInput.trim();
    if (!text) return;
    socket.emit("chat", { text, sender: socket.id, username: usernameRef.current });
    setChatMessages((old) => [
      ...old,
      { text, author: "self", id: `${Date.now()}-${Math.random()}` },
    ]);
    setChatInput("");
    socket.emit("typing", { roomId: roomIdRef.current, username: usernameRef.current, typing: false });
  };

  const leaveRoom = () => {
    screenTrackRef.current?.stop();
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    cameraTrackRef.current = null;
    audioTrackRef.current = null;
    closePeerConnection();
    socket.emit("leave-room", { roomId: roomIdRef.current });
    socket.disconnect();
    window.location.reload();
  };

  if (!joined) {
    return (
      <div className="join-screen">
        <form className="join-panel" onSubmit={handleJoin}>
          <div className="brand-mark">RC</div>
          <p className="eyebrow">REAL-TIME COMMUNICATION</p>
          <h1>Meet face to face.</h1>
          <p className="join-subtitle">A simple space to connect, communicate, and collaborate.</p>
          <label htmlFor="username">Your name</label>
          <input id="username" type="text" placeholder="Enter your name" value={username} onChange={(e) => setUsername(e.target.value)} />
          <label htmlFor="roomId">Room ID <span>(optional)</span></label>
          <input id="roomId" type="text" placeholder="Enter an existing room ID" value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          {errorMessage && <div className="inline-notice">{errorMessage}</div>}
          <button className="join-button" type="submit">Join meeting <span>→</span></button>
          <div className="privacy-note"><span className="privacy-dot" /> Your browser may ask for camera and microphone access.</div>
        </form>
      </div>
    );
  }

  const remoteParticipant = participants.find((p) => p.socketId !== socket.id);

  return (
    <div className="app-container livechat-page">
      <header className="app-header">
        <div className="brand-lockup">
          <div className="brand-mark small">RC</div>
          <div><div className="logo">ConnectSpace</div><div className="header-caption">Video meeting</div></div>
        </div>
        <div className="header-middle">
          <div className="room-info"><span className="tiny-label">ROOM</span><strong>{roomIdRef.current}</strong></div>
          <div className="participants-info"><span className="people-icon">♧</span>{participants.length + 1} participant{participants.length === 0 ? "" : "s"}</div>
        </div>
        <div className="connection-pill"><span className={`status-dot ${socketStatus}`} />{socketStatus === "connected" ? "Server connected" : "Reconnecting…"}</div>
      </header>

      {errorMessage && <div className="app-notice"><span>{errorMessage}</span><button onClick={() => setErrorMessage("")} aria-label="Dismiss message">×</button></div>}

      <main className="app-main">
        <section className="main-area">
          <div className="stage-heading"><div><span className="live-indicator" /> LIVE SESSION <span className="stage-room">/ {roomIdRef.current}</span></div><div className="stage-status">{callStatus}</div></div>
          <section className="video-panel video-stage">
            {remoteStream ? (
              <video id="remoteVideo" ref={remoteVideoRef} autoPlay playsInline className="remote-video" />
            ) : (
              <div className="remote-placeholder">
                <div className="waiting-avatar">{remoteParticipant?.username?.charAt(0)?.toUpperCase() || "＋"}</div>
                <h2>{remoteParticipant ? `${remoteParticipant.username} is connecting` : "Your meeting is ready"}</h2>
                <p>{remoteParticipant ? "Waiting for their video stream…" : "Share your room ID with someone to start a call."}</p>
                <div className="waiting-pulse"><span /><span /><span /></div>
              </div>
            )}

            {remoteStream && remoteParticipant && (
              <div className="remote-label"><span className="participant-dot" />{remoteParticipant.username}</div>
            )}

            <div className={`local-preview ${cameraEnabled ? "" : "camera-disabled"}`}>
              {cameraEnabled && localStreamRef.current ? (
                <video id="localVideo" ref={localVideoRef} autoPlay muted playsInline className="local-video" />
              ) : (
                <div className="camera-off"><div className="camera-off-avatar">{(username || "Y").charAt(0).toUpperCase()}</div><span>Camera off</span></div>
              )}
              <div className="local-label"><span className="local-you-dot" />{username || "You"} (You)</div>
            </div>
            <div className="stage-corner-label"><span className="secure-icon">⌑</span> Private meeting</div>
          </section>
          <div className="meeting-footer-note"><span>⌘</span> Keep your microphone muted when you are not speaking.</div>
        </section>

        <aside className="participants-panel">
          <div className="side-panel-header">
            <div><h2>People & chat</h2><p>{participants.length + 1} in this room</p></div>
            <span className="panel-count">{participants.length + 1}</span>
          </div>
          <div className="tabs">
            <button className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>Chat</button>
            <button className={activeTab === "participants" ? "active" : ""} onClick={() => setActiveTab("participants")}>People</button>
          </div>
          {activeTab === "participants" ? (
            <div className="participant-list">
              <div className="participant-row">
                <div className="participant-avatar">{(username || "Y").charAt(0).toUpperCase()}</div>
                <div className="participant-copy"><strong>{username || "You"} <span>(You)</span></strong><small>{audioEnabled ? "Microphone on" : "Microphone muted"}</small></div>
                <span className={`mic-state ${audioEnabled ? "" : "off"}`}>{audioEnabled ? "🎤" : "🔇"}</span>
              </div>
              {participants.filter((p) => p.socketId !== socket.id).map((p) => (
                <div className="participant-row" key={p.socketId}>
                  <div className="participant-avatar peer-avatar">{(p.username || "?").charAt(0).toUpperCase()}</div>
                  <div className="participant-copy"><strong>{p.username}</strong><small>{p.socketId === remoteParticipant?.socketId && remoteStream ? "In the call" : "Joined room"}</small></div>
                  <span className="mic-state unknown" title="Remote microphone state is not available">•</span>
                </div>
              ))}
            </div>
          ) : (
            <section className="chat-section">
              <div className="chat-window" aria-live="polite">
                {chatMessages.length === 0 && <div className="chat-empty"><div className="chat-empty-icon">✉</div><strong>Start the conversation</strong><p>Messages sent here will appear for everyone in this room.</p></div>}
                {chatMessages.map((msg) => (
                  <div key={msg.id} className={`message-row ${msg.author}`}>
                    {msg.author === "peer" && <div className="message-avatar">{(remoteParticipant?.username || "P").charAt(0).toUpperCase()}</div>}
                    <div className={`chat-bubble ${msg.author}`}><span className="message-author">{msg.author === "self" ? "You" : msg.author === "system" ? "Room update" : remoteParticipant?.username || "Participant"}</span><div>{msg.text}</div></div>
                  </div>
                ))}
                {typingStatus && <div className="typing">{typingStatus}</div>}
              </div>
              <form className="chat-input" onSubmit={(e) => { e.preventDefault(); sendChat(); }}>
                <input aria-label="Chat message" type="text" placeholder="Write a message…" value={chatInput} onChange={(e) => { setChatInput(e.target.value); socket.emit("typing", { roomId: roomIdRef.current, username: usernameRef.current, typing: Boolean(e.target.value) }); }} />
                <button type="submit" disabled={!chatInput.trim()} aria-label="Send message">↑</button>
              </form>
            </section>
          )}
        </aside>
      </main>

      <footer className="control-bar">
        <div className="controls-left"><span className="control-room-label">{roomIdRef.current}</span></div>
        <div className="controls-center">
          <button onClick={toggleMute} aria-label={audioEnabled ? "Mute microphone" : "Unmute microphone"} className={`control-button ${audioEnabled ? "" : "muted"}`} title={audioEnabled ? "Mute microphone" : "Unmute microphone"}><span>{audioEnabled ? "🎙" : "🔇"}</span><small>{audioEnabled ? "Mute" : "Unmute"}</small></button>
          <button onClick={toggleCamera} aria-label={cameraEnabled ? "Turn camera off" : "Turn camera on"} className={`control-button ${cameraEnabled ? "" : "muted"}`} title={cameraEnabled ? "Turn camera off" : "Turn camera on"}><span>{cameraEnabled ? "▣" : "◧"}</span><small>{cameraEnabled ? "Camera" : "Camera off"}</small></button>
          <button onClick={shareScreen} aria-label="Share screen" className={`control-button ${screenSharing ? "active" : ""}`} title="Share screen"><span>▱</span><small>{screenSharing ? "Sharing" : "Share"}</small></button>
          <button onClick={() => setActiveTab("chat")} aria-label="Open chat" className="control-button"><span>▤</span><small>Chat</small></button>
          <button onClick={() => setActiveTab("participants")} aria-label="Show participants" className="control-button"><span>♧</span><small>People</small></button>
        </div>
        <div className="controls-right"><button onClick={leaveRoom} aria-label="Leave meeting" className="leave-button" title="Leave meeting"><span>↗</span><small>Leave</small></button></div>
      </footer>
    </div>
  );
};

export default App;
