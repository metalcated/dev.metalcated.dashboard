// Live camera (device_camera_live). Homey Pro converts the camera's stream (RTSP, HLS, …) to WebRTC with go2rtc, so the
// browser plays it directly: it sends a WebRTC offer to the Homey and keeps the stream alive. The stream stops while
// the page is hidden and starts again when it is shown.
// Every widget showing the same camera video shares one stream. A new stream only starts at the camera's next keyframe,
// which can take seconds (the camera ignores the browser's requests for one), so a second widget for a camera that is
// already live (a highlight's copy, when this screen's dashboard has the camera too) plays at once instead of standing
// still on the snapshot.

import { findDevice } from '../devices.js';
import { el, note } from '../dom.js';
import { isDashboardVisible, subscribeDashboardVisibility } from '../embedded.js';
import { COLLAPSE_ICON, EXPAND_ICON } from '../icons.js';
import { state } from '../state.js';

const KEEP_ALIVE = 30_000; // Homey drops a stream after two minutes without one.
const RETRY = 10_000;
const FIRST_MEDIA = 60_000;

// video id → connection owner and shared stream, while any widget shows it.
const streams = new Map();

function iceGathered(pc, timeout, signal) {
  if (pc.iceGatheringState === 'complete' || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let finished = false;
    let timer;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const check = () => pc.iceGatheringState === 'complete' && done();
    pc.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', done, { once: true });
    timer = setTimeout(done, timeout);
    check();
  });
}

// The stream of one camera video: { stream, status } for its widgets, where status is '' once frames arrive, else
// what to show instead of "Live". subscribe(fn) calls fn with it on every change and returns an unsubscribe; the stream
// runs while anyone is subscribed.
function liveStream(videoId) {
  const client = state.client;
  const existing = streams.get(videoId);
  if (existing?.client === client) return existing.shared;
  existing?.retire();
  const listeners = new Set();
  const shared = { stream: null, status: 'Connecting…' };
  let pc = null;
  let keepAlive = null;
  let retry = null;
  let firstMedia = null;
  let stopWatchingVisibility = null;
  let gathering = null;
  let generation = 0;
  let retired = false;
  let negotiating = false;
  let manualRetryRequired = false;
  const api = (path, payload) => client.api('POST', `/api/manager/videos/video/${videoId}${path}`, payload);
  const canRun = () => !retired && listeners.size > 0 && state.client === client && isDashboardVisible();
  const emit = () => listeners.forEach((listener) => listener(shared));
  const showStatus = (text) => {
    if (text === '') {
      clearTimeout(firstMedia);
      firstMedia = null;
    }
    shared.status = text;
    emit();
  };

  function stop() {
    generation += 1;
    clearInterval(keepAlive);
    clearTimeout(retry);
    clearTimeout(firstMedia);
    keepAlive = null;
    retry = null;
    firstMedia = null;
    negotiating = false;
    gathering?.abort();
    gathering = null;
    const connection = pc;
    pc = null;
    shared.stream = null;
    connection?.close();
  }

  function retryLater(message) {
    stop();
    showStatus(message);
    if (canRun()) retry = setTimeout(start, RETRY);
  }

  async function start() {
    if (manualRetryRequired) return;
    if (!canRun()) {
      showStatus('Paused');
      return;
    }
    // Parent and document visibility can both announce the same transition.
    // Repeated taps while negotiating must keep the existing peer as well.
    if (pc) return;
    clearTimeout(retry);
    retry = null;
    const run = ++generation;
    negotiating = true;
    let connection;
    const ownsAttempt = () => generation === run && canRun();
    const current = () => ownsAttempt() && pc === connection;
    showStatus('Connecting…');
    try {
      connection = new RTCPeerConnection();
      pc = connection;
      firstMedia = setTimeout(() => {
        if (!current() || shared.status === '') return;
        manualRetryRequired = true;
        stop();
        showStatus('Camera did not send video. Tap to retry.');
      }, FIRST_MEDIA);
      connection.addTransceiver('video', { direction: 'recvonly' });
      connection.addTransceiver('audio', { direction: 'recvonly' });
      connection.addEventListener('track', (event) => {
        if (!current()) return;
        const stream = shared.stream ?? event.streams[0] ?? new MediaStream();
        if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
        shared.stream = stream;
        // A remote track stays muted until its first packets arrive, which is when there is something to show.
        if (event.track.kind === 'video') {
          const live = () => current() && shared.status !== '' && showStatus('');
          event.track.addEventListener('unmute', live);
          if (!event.track.muted) live();
        }
        emit();
      });
      connection.addEventListener('connectionstatechange', () => {
        if (!current()) return;
        if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') retryLater('Reconnecting…');
      });
      const offer = await connection.createOffer();
      if (!current()) return;
      await connection.setLocalDescription(offer);
      if (!current()) return;
      const controller = new AbortController();
      gathering = controller;
      await iceGathered(connection, 3000, controller.signal);
      if (gathering === controller) gathering = null;
      if (!current()) return;
      const { answerSdp, streamId } = await api('/offer', { offer: connection.localDescription.sdp });
      if (!current()) return;
      await connection.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (!current()) return;
      if (streamId) keepAlive = setInterval(() => {
        if (current()) api('/keep-alive', { streamId }).catch(() => {});
      }, KEEP_ALIVE);
    } catch (error) {
      if (ownsAttempt()) retryLater(`No live video: ${error.message}`);
    } finally {
      if (generation === run) negotiating = false;
    }
  }

  const onVisibility = () => {
    if (canRun()) start();
    else {
      stop();
      if (!manualRetryRequired) showStatus('Paused');
    }
  };

  shared.subscribe = (listener) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      stopWatchingVisibility = subscribeDashboardVisibility(onVisibility);
      start();
    } else {
      listener(shared);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      retired = true;
      stopWatchingVisibility?.();
      stopWatchingVisibility = null;
      stop();
      if (streams.get(videoId)?.shared === shared) streams.delete(videoId);
    };
  };
  // After an error, a tap on the status tries again.
  shared.retry = () => {
    if (shared.status === '') return;
    manualRetryRequired = false;
    // Keep an in-flight offer, but retain the manual recovery action when an
    // accepted connection never delivers video.
    if (pc && !negotiating) stop();
    start();
  };
  // A widget saw a frame; covers browsers that don't report the track unmuting.
  shared.playing = (stream) => {
    if (canRun() && pc != null && stream != null && stream === shared.stream
      && stream.getTracks().some((track) => track.kind === 'video') && shared.status === 'Connecting…') showStatus('');
  };
  streams.set(videoId, { client, shared, retire() {
    retired = true;
    stopWatchingVisibility?.();
    stopWatchingVisibility = null;
    stop();
    showStatus('Paused');
  } });
  return shared;
}

export function mountCameraLive({ body, widget }) {
  const device = findDevice(body, widget.data?.deviceId);
  if (device == null) return;
  const video = device.videos?.find((candidate) => candidate.id === widget.data?.deviceVideoId) ?? device.videos?.[0];
  const videoId = video?.videoObj?.id;
  if (videoId == null) return note(body, `${device.name} has no live video.`);

  const frame = el('div', 'snapshot camera-live');
  const player = el('video');
  player.muted = true;
  player.playsInline = true;
  player.autoplay = true;
  // Show the saved camera preview until the stream plays. Cache-busting reloads that image; it does not request a
  // new capture. Skip it when another widget already plays this stream, whose next frame is a moment away.
  const snapshot = device.images?.find((image) => image.type === 'camera')?.imageObj?.url;
  const existing = streams.get(videoId);
  if (snapshot && (existing?.client !== state.client || existing.shared.status !== '')) player.poster = `${state.client.base}${snapshot}?v=${Date.now()}`;
  // Like the app: the name and the stream's title over the picture, a red "Live" once it plays, a full-screen button.
  const overlay = el('div', 'camera-overlay');
  overlay.append(el('div', 'camera-name', `${widget.title ?? device.name} - ${video.title ?? 'Live'}`));
  const status = el('button', 'camera-status');
  status.type = 'button';
  overlay.append(status);
  const fullscreen = el('button', 'camera-fullscreen');
  fullscreen.type = 'button';
  // The same button leaves full screen again: a kiosk has no Esc key.
  const isFullscreen = () => (document.fullscreenElement ?? document.webkitFullscreenElement) === frame;
  const onFullscreenChange = () => {
    fullscreen.innerHTML = isFullscreen() ? COLLAPSE_ICON : EXPAND_ICON;
    fullscreen.setAttribute('aria-label', isFullscreen() ? 'Exit full screen' : 'Full screen');
  };
  onFullscreenChange();
  fullscreen.addEventListener('click', () => {
    if (isFullscreen()) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
      else document.webkitExitFullscreen?.();
    } else if (frame.requestFullscreen) frame.requestFullscreen().catch(() => {});
    else if (frame.webkitRequestFullscreen) frame.webkitRequestFullscreen();
    else player.webkitEnterFullscreen?.();
  });
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);
  frame.append(player, overlay, fullscreen);
  body.append(frame);

  const showStatus = (text) => {
    status.textContent = text || 'Live';
    status.classList.toggle('is-live', !text);
  };
  let shared = null;
  let unsubscribe = null;
  const update = ({ stream, status: text }) => {
    if (player.srcObject !== stream) {
      player.srcObject = stream;
      if (stream) player.play().catch(() => {});
    }
    showStatus(text);
  };
  player.addEventListener('loadeddata', () => shared?.playing(player.srcObject));
  const play = () => {
    if (unsubscribe) return shared.retry();
    shared = liveStream(videoId);
    unsubscribe = shared.subscribe(update);
  };

  status.addEventListener('click', play);
  if (widget.data?.autoplay === false) {
    showStatus('Play live video');
  } else {
    play();
  }
  return () => {
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    document.removeEventListener('webkitfullscreenchange', onFullscreenChange);
    unsubscribe?.();
    player.srcObject = null;
  };
}
