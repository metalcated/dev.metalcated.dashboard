import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../assets/web/js/widgets/camera-live.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

class Target {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, detail = {}) { for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ type, ...detail }); }
  count(type) { return this.listeners.get(type)?.size ?? 0; }
}

class Element extends Target {
  constructor(tag = 'div', className = '', text = '') {
    super(); this.tagName = tag; this.className = className; this.textContent = text;
    this.children = []; this.attributes = new Map(); this.srcObject = null; this.playCalls = 0;
    const classes = new Set(className.split(/\s+/).filter(Boolean));
    this.classList = { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains: (name) => classes.has(name) };
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  play() { this.playCalls += 1; return Promise.resolve(); }
  find(className) { return this.children.find((node) => node.className.split(/\s+/).includes(className))
    ?? this.children.map((node) => node.find(className)).find(Boolean); }
}

async function camera({ completeIce = false, constructorFailures = 0 } = {}) {
  const peers = [], timers = new Map(), visibility = new Set(), calls = [], gates = {};
  let visible = true, nextTimer = 1, failedConstructors = constructorFailures;
  const document = new Target();
  const state = { client: null };
  const client = (name) => ({ base: `https://${name}.homey.test`, name,
    api(method, path, body) {
      calls.push({ client: name, method, path, body });
      if (path.endsWith('/offer')) return gates.offer?.promise ?? Promise.resolve({ answerSdp: 'answer-sdp', streamId: `${name}-stream` });
      return gates.keepAlive?.promise ?? Promise.resolve({});
    },
  });
  state.client = client('first');
  class Peer extends Target {
    constructor() {
      super();
      if (failedConstructors-- > 0) throw new Error('WebRTC is unavailable in this browser');
      this.iceGatheringState = completeIce ? 'complete' : 'gathering';
      this.connectionState = 'new'; this.closed = 0; this.localCalls = []; this.remoteCalls = []; this.transceivers = [];
      peers.push(this);
    }
    addTransceiver(...args) { this.transceivers.push(args); }
    createOffer() { return gates.createOffer?.promise ?? Promise.resolve({ type: 'offer', sdp: 'offer-sdp' }); }
    setLocalDescription(description) { this.localDescription = description; this.localCalls.push(description); return gates.local?.promise ?? Promise.resolve(); }
    setRemoteDescription(description) { this.remoteCalls.push(description); return gates.remote?.promise ?? Promise.resolve(); }
    close() { this.closed += 1; this.connectionState = 'closed'; }
    completeIce() { this.iceGatheringState = 'complete'; this.emit('icegatheringstatechange'); }
    fail() { this.connectionState = 'failed'; this.emit('connectionstatechange'); }
  }
  class Stream { tracks = []; getTracks() { return this.tracks; } addTrack(track) { this.tracks.push(track); } }
  const device = { name: 'Office camera', videos: [{ id: 'live', title: 'Live', videoObj: { id: 'video-one' } }], images: [] };
  const imports = {
    '../devices.js': { findDevice: () => device },
    '../dom.js': { el: (...args) => new Element(...args), note: (body, text) => body.append(new Element('p', 'note', text)) },
    '../embedded.js': { isDashboardVisible: () => visible,
      subscribeDashboardVisibility: (listener) => { visibility.add(listener); return () => visibility.delete(listener); } },
    '../icons.js': { COLLAPSE_ICON: 'collapse', EXPAND_ICON: 'expand' },
    '../state.js': { state },
  };
  const schedule = (callback, delay, repeat) => { const id = nextTimer++; timers.set(id, { callback, delay, repeat }); return id; };
  const context = vm.createContext({ document, console, AbortController, MediaStream: Stream, RTCPeerConnection: Peer,
    setTimeout: (callback, delay) => schedule(callback, delay, false), clearTimeout: (id) => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, true), clearInterval: (id) => timers.delete(id),
  });
  // Keep the installed module unchanged. The local export exposes its shared
  // transport in the same VM used by the actual widget mount function.
  const module = new vm.SourceTextModule(`${source}\nexport { liveStream };`, { context, identifier: 'camera-live.js' });
  await module.link((specifier) => {
    const values = imports[specifier];
    assert.ok(values, `unexpected camera dependency ${specifier}`);
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [name, value] of Object.entries(values)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  const host = {
    peers, timers, visibility, calls, gates, state, document, client, device, Element, Stream,
    live: (id = 'video-one') => module.namespace.liveStream(id),
    offerCalls: () => calls.filter((entry) => entry.path.endsWith('/offer')),
    keepAliveCalls: () => calls.filter((entry) => entry.path.endsWith('/keep-alive')),
    async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    async setVisible(value) { visible = value; for (const listener of [...visibility]) listener(value); await this.flush(); },
    timerCount(delay) { return [...timers.values()].filter((entry) => delay == null || entry.delay === delay).length; },
    async fire(delay) {
      const pending = [...timers.entries()].filter(([, entry]) => entry.delay === delay);
      for (const [id, entry] of pending) { if (!entry.repeat) timers.delete(id); entry.callback(); }
      await this.flush();
    },
    mount(data = {}) {
      const body = new Element();
      const cleanup = module.namespace.mountCameraLive({ body, widget: { data: { deviceId: 'office', deviceVideoId: 'live', ...data } } });
      return { body, cleanup, player: body.children[0]?.children[0], status: body.find('camera-status') };
    },
  };
  return host;
}

test('duplicate visible notifications and retries keep one negotiating peer and one shared camera transport', async () => {
  const host = await camera();
  const shared = host.live();
  const first = shared.subscribe(() => {});
  await host.flush();
  assert.equal(host.peers.length, 1);
  const peer = host.peers[0];
  const second = host.live().subscribe(() => {});
  shared.retry(); await host.setVisible(true); await host.setVisible(true);
  assert.equal(host.peers.length, 1);
  assert.equal(peer.closed, 0);
  assert.equal(peer.count('icegatheringstatechange'), 1);
  peer.completeIce(); await host.flush();
  assert.equal(host.offerCalls().length, 1);
  assert.equal(host.timerCount(3000), 0, 'gathering completion clears its timeout');
  assert.equal(peer.count('icegatheringstatechange'), 0);
  assert.equal(host.timerCount(30000), 1);
  first();
  assert.equal(peer.closed, 0, 'a highlight copy keeps the shared stream subscribed');
  second();
  assert.equal(peer.closed, 1);
  assert.equal(host.timers.size, 0);
  assert.equal(host.visibility.size, 0);
});

test('hiding or removing the final subscriber during ICE cancels gathering and sends no late offer', async () => {
  for (const action of ['hide', 'unsubscribe']) {
    const host = await camera();
    const unsubscribe = host.live().subscribe(() => {});
    await host.flush();
    const peer = host.peers[0];
    if (action === 'hide') await host.setVisible(false); else unsubscribe();
    assert.equal(peer.closed, 1);
    assert.equal(peer.count('icegatheringstatechange'), 0);
    assert.equal(host.timerCount(3000), 0);
    peer.completeIce(); await host.fire(3000);
    assert.equal(host.offerCalls().length, 0);
    assert.equal(host.keepAliveCalls().length, 0);
    unsubscribe();
    assert.equal(host.visibility.size, 0);
    assert.equal(host.timers.size, 0);
  }
});

test('visibility loss between offer creation and local description never advances negotiation', async () => {
  for (const phase of ['createOffer', 'local']) {
    const host = await camera();
    const gate = deferred(); host.gates[phase] = gate;
    const unsubscribe = host.live().subscribe(() => {});
    await host.flush();
    const peer = host.peers[0];
    await host.setVisible(false);
    gate.resolve({ type: 'offer', sdp: 'late-offer' }); await host.flush();
    if (phase === 'createOffer') assert.equal(peer.localCalls.length, 0);
    assert.equal(host.offerCalls().length, 0);
    assert.equal(host.timers.size, 0);
    unsubscribe();
  }
});

test('an offer response arriving after hide or unmount cannot install an answer or keep the stream alive', async () => {
  for (const action of ['hide', 'unsubscribe']) {
    const host = await camera({ completeIce: true });
    host.gates.offer = deferred();
    const unsubscribe = host.live().subscribe(() => {});
    await host.flush();
    assert.equal(host.offerCalls().length, 1);
    if (action === 'hide') await host.setVisible(false); else unsubscribe();
    host.gates.offer.resolve({ answerSdp: 'late-answer', streamId: 'late-stream' }); await host.flush();
    assert.equal(host.peers[0].remoteCalls.length, 0);
    assert.equal(host.timerCount(30000), 0);
    await host.fire(30000);
    assert.equal(host.keepAliveCalls().length, 0);
    unsubscribe();
  }
});

test('remote-description completion after removal cannot create a keep-alive interval', async () => {
  const host = await camera({ completeIce: true });
  host.gates.remote = deferred();
  const unsubscribe = host.live().subscribe(() => {});
  await host.flush();
  assert.equal(host.peers[0].remoteCalls.length, 1);
  unsubscribe();
  host.gates.remote.resolve(); await host.flush();
  assert.equal(host.peers[0].closed, 1);
  assert.equal(host.timers.size, 0);
  assert.equal(host.visibility.size, 0);
  await host.fire(30000);
  assert.equal(host.keepAliveCalls().length, 0);
});

test('keep-alive is pinned to its client and a late old unsubscribe cannot evict the replacement transport', async () => {
  const host = await camera({ completeIce: true });
  const old = host.live();
  const unsubscribeOld = old.subscribe(() => {});
  await host.flush();
  const oldTick = [...host.timers.values()].find((entry) => entry.delay === 30000).callback;
  await host.fire(30000);
  assert.equal(host.keepAliveCalls()[0].client, 'first');
  host.state.client = host.client('second');
  oldTick(); await host.flush();
  assert.equal(host.keepAliveCalls().length, 1, 'a queued callback cannot call a replacement client');
  const replacement = host.live();
  const unsubscribeNew = replacement.subscribe(() => {});
  await host.flush();
  assert.equal(host.peers[0].closed, 1);
  assert.equal(host.peers.length, 2);
  unsubscribeOld();
  assert.equal(host.live() === replacement, true);
  assert.equal(host.peers.length, 2);
  await host.fire(30000);
  assert.equal(host.keepAliveCalls().at(-1).client, 'second');
  unsubscribeNew();
  assert.equal(host.timers.size, 0);
  assert.equal(host.visibility.size, 0);
});

test('constructor failures show a useful error, permit a deliberate retry, and do not retry while hidden', async () => {
  const host = await camera({ constructorFailures: 1 });
  const shared = host.live();
  const statuses = [];
  const unsubscribe = shared.subscribe(({ status }) => statuses.push(status));
  await host.flush();
  assert.match(statuses.at(-1), /No live video:.*WebRTC is unavailable/);
  assert.equal(host.timerCount(10000), 1);
  shared.retry(); await host.flush();
  assert.equal(host.peers.length, 1);
  assert.equal(host.timerCount(10000), 0, 'manual retry retires the scheduled retry');
  host.peers[0].fail(); await host.flush();
  assert.equal(host.timerCount(10000), 1);
  await host.setVisible(false);
  assert.equal(statuses.at(-1), 'Paused');
  assert.equal(host.timers.size, 0);
  await host.fire(10000);
  assert.equal(host.peers.length, 1);
  unsubscribe();
});

test('manual camera widgets remain click-to-play and mounted copies release the stream only after the last cleanup', async () => {
  const host = await camera({ completeIce: true });
  const original = host.mount({ autoplay: false });
  await host.flush();
  assert.equal(original.status.textContent, 'Play live video');
  assert.equal(host.peers.length, 0);
  assert.equal(host.visibility.size, 0);
  // A normal double-click must retain the first in-flight offer. Deliberate
  // recovery after an accepted connection is covered separately below.
  original.status.emit('click'); original.status.emit('click'); await host.flush();
  assert.equal(host.peers.length, 1);
  const highlightedCopy = host.mount({ autoplay: false });
  highlightedCopy.status.emit('click'); await host.flush();
  assert.equal(host.peers.length, 1);
  assert.equal(host.document.count('fullscreenchange'), 2);
  const track = new Target(); track.kind = 'video'; track.muted = false;
  const stream = new host.Stream(); stream.addTrack(track);
  host.peers[0].emit('track', { streams: [stream], track });
  assert.equal(original.player.srcObject, stream);
  assert.equal(highlightedCopy.player.srcObject, stream);
  assert.equal(original.status.textContent, 'Live');
  original.cleanup();
  assert.equal(host.peers[0].closed, 0);
  assert.equal(original.player.srcObject, null);
  assert.equal(host.document.count('fullscreenchange'), 1);
  highlightedCopy.cleanup();
  assert.equal(host.peers[0].closed, 1);
  assert.equal(highlightedCopy.player.srcObject, null);
  assert.equal(host.document.count('fullscreenchange'), 0);
  assert.equal(host.document.count('webkitfullscreenchange'), 0);
  assert.equal(host.visibility.size, 0);
  assert.equal(host.timers.size, 0);
});

test('a deliberate retry still recovers an accepted camera connection that delivers no media', async () => {
  const host = await camera({ completeIce: true });
  host.gates.offer = deferred();
  const shared = host.live();
  const unsubscribe = shared.subscribe(() => {});
  await host.flush();
  shared.retry(); shared.retry(); await host.setVisible(true);
  assert.equal(host.peers.length, 1, 'an in-flight request remains idempotent');
  host.gates.offer.resolve({ answerSdp: 'accepted', streamId: 'quiet-stream' }); await host.flush();
  assert.equal(shared.status, 'Connecting…');
  await host.setVisible(true);
  assert.equal(host.peers.length, 1, 'visibility does not restart a settled connection');
  delete host.gates.offer;
  shared.retry(); shared.retry(); await host.flush();
  assert.equal(host.peers.length, 2, 'one deliberate retry restarts a stream that never produced frames');
  assert.equal(host.peers[0].closed, 1);
  assert.equal(host.peers[1].closed, 0);
  assert.equal(host.timerCount(30000), 1);
  unsubscribe();
});

test('a late old answer cannot mark a newer negotiation idle or start old keep-alives', async () => {
  const host = await camera({ completeIce: true });
  const oldRemote = deferred(); host.gates.remote = oldRemote;
  const shared = host.live();
  const unsubscribe = shared.subscribe(() => {});
  await host.flush();
  await host.setVisible(false);
  const newRemote = deferred(); host.gates.remote = newRemote;
  await host.setVisible(true);
  assert.equal(host.peers.length, 2);
  oldRemote.resolve(); await host.flush();
  shared.retry(); await host.flush();
  assert.equal(host.peers.length, 2, 'the old finally block must not unlock a newer in-flight attempt');
  assert.equal(host.timerCount(30000), 0);
  newRemote.resolve(); await host.flush();
  assert.equal(host.timerCount(30000), 1);
  unsubscribe();
});

test('a queued retry from a previous client cannot use the replacement connection', async () => {
  const host = await camera({ completeIce: true });
  const unsubscribe = host.live().subscribe(() => {});
  await host.flush();
  host.peers[0].fail(); await host.flush();
  const oldRetry = [...host.timers.values()].find((entry) => entry.delay === 10000).callback;
  host.state.client = host.client('second');
  oldRetry(); await host.flush();
  assert.equal(host.peers.length, 1);
  assert.equal(host.offerCalls().length, 1);
  assert.equal(host.calls.some((entry) => entry.client === 'second'), false);
  unsubscribe();
  assert.equal(host.timers.size, 0);
});

test('queued media events can mark Live only for the current nonempty stream', async () => {
  const host = await camera({ completeIce: true });
  const shared = host.live();
  const unsubscribe = shared.subscribe(() => {});
  await host.flush();
  const oldTrack = new Target(); oldTrack.kind = 'video'; oldTrack.muted = true;
  const oldStream = new host.Stream(); oldStream.addTrack(oldTrack);
  host.peers[0].emit('track', { streams: [oldStream], track: oldTrack });
  shared.playing(oldStream);
  assert.equal(shared.status, '');
  host.peers[0].fail(); await host.fire(10000);
  assert.equal(shared.status, 'Connecting…');
  shared.playing(null); shared.playing(oldStream); oldTrack.emit('unmute');
  assert.equal(shared.status, 'Connecting…');
  const track = new Target(); track.kind = 'video'; track.muted = true;
  const stream = new host.Stream(); stream.addTrack(track);
  host.peers[1].emit('track', { streams: [stream], track });
  shared.playing(oldStream);
  assert.equal(shared.status, 'Connecting…');
  shared.playing(stream);
  assert.equal(shared.status, '');
  const tick = [...host.timers.values()].find((entry) => entry.delay === 30000).callback;
  await host.setVisible(false);
  shared.playing(stream); tick(); await host.flush();
  assert.equal(shared.status, 'Paused');
  assert.equal(host.keepAliveCalls().length, 0);
  unsubscribe();
});

test('the first-media deadline closes a silent camera and waits for a deliberate retry without a visibility retry loop', async () => {
  const host = await camera({ completeIce: true });
  const widget = host.mount({ autoplay: false });
  widget.status.emit('click'); await host.flush();
  assert.equal(host.timerCount(60000), 1);
  const oldDeadline = [...host.timers.values()].find((entry) => entry.delay === 60000).callback;
  const oldKeepAlive = [...host.timers.values()].find((entry) => entry.delay === 30000).callback;
  await host.fire(60000);
  assert.equal(widget.status.textContent, 'Camera did not send video. Tap to retry.');
  assert.equal(host.peers[0].closed, 1);
  assert.equal(host.timers.size, 0, 'deadline expiry stops both keep-alive and automatic retry timers');
  await host.setVisible(true); await host.setVisible(false); await host.setVisible(true);
  await host.fire(10000); await host.fire(60000);
  oldKeepAlive(); await host.flush();
  assert.equal(host.peers.length, 1);
  assert.equal(host.offerCalls().length, 1);
  assert.equal(host.keepAliveCalls().length, 0);
  assert.equal(widget.status.textContent, 'Camera did not send video. Tap to retry.');

  widget.status.emit('click'); await host.flush();
  assert.equal(host.peers.length, 2, 'a deliberate click starts one fresh attempt');
  assert.equal(host.peers[1].closed, 0);
  assert.equal(host.timerCount(60000), 1);
  oldDeadline(); await host.flush();
  assert.equal(host.peers[1].closed, 0, 'a queued old deadline cannot close the replacement attempt');
  assert.equal(widget.status.textContent, 'Connecting…');
  widget.cleanup();
  assert.equal(host.timers.size, 0);
});

test('the same deadline bounds pending offer creation, ICE, backend offer and remote-description work', async () => {
  for (const phase of ['createOffer', 'ice', 'offer', 'remote']) {
    const host = await camera({ completeIce: phase !== 'ice' });
    const gate = deferred();
    if (phase !== 'ice') host.gates[phase] = gate;
    const shared = host.live();
    const unsubscribe = shared.subscribe(() => {});
    await host.flush();
    const peer = host.peers[0];
    assert.equal(host.timerCount(60000), 1, `${phase} must have a deadline before it resolves`);
    const offered = host.offerCalls().length;
    await host.fire(60000);
    assert.equal(shared.status, 'Camera did not send video. Tap to retry.');
    assert.equal(peer.closed, 1);
    assert.equal(peer.count('icegatheringstatechange'), 0);
    assert.equal(host.timers.size, 0);
    if (phase === 'createOffer') gate.resolve({ type: 'offer', sdp: 'late-offer' });
    else if (phase === 'offer') gate.resolve({ answerSdp: 'late-answer', streamId: 'late-stream' });
    else if (phase === 'remote') gate.resolve();
    else peer.completeIce();
    await host.flush();
    assert.equal(host.offerCalls().length, offered, 'expired work cannot send another offer');
    if (phase !== 'remote') assert.equal(peer.remoteCalls.length, 0);
    assert.equal(host.timerCount(30000), 0);
    await host.fire(10000); await host.fire(60000);
    assert.equal(host.peers.length, 1, 'expiry never schedules an automatic retry');
    unsubscribe();
  }
});

test('video unmute clears the first-media deadline while an audio-only stream cannot claim live video', async () => {
  const host = await camera({ completeIce: true });
  const shared = host.live();
  const unsubscribe = shared.subscribe(() => {});
  await host.flush();
  const audio = new Target(); audio.kind = 'audio'; audio.muted = false;
  const stream = new host.Stream(); stream.addTrack(audio);
  host.peers[0].emit('track', { streams: [stream], track: audio });
  shared.playing(stream);
  assert.equal(shared.status, 'Connecting…');
  assert.equal(host.timerCount(60000), 1, 'audio packets alone cannot satisfy a live-video deadline');
  const track = new Target(); track.kind = 'video'; track.muted = true;
  host.peers[0].emit('track', { streams: [stream], track });
  assert.equal(host.timerCount(60000), 1);
  track.muted = false; track.emit('unmute');
  assert.equal(shared.status, '');
  assert.equal(host.timerCount(60000), 0);
  await host.fire(60000);
  assert.equal(host.peers[0].closed, 0);
  assert.equal(host.timerCount(30000), 1, 'normal live keep-alive continues');
  unsubscribe();
});

test('the real widget loadeddata fallback clears the deadline only for a current video stream', async () => {
  const host = await camera({ completeIce: true });
  const widget = host.mount({ autoplay: false });
  widget.status.emit('click'); await host.flush();
  const audio = new Target(); audio.kind = 'audio'; audio.muted = false;
  const stream = new host.Stream(); stream.addTrack(audio);
  host.peers[0].emit('track', { streams: [stream], track: audio });
  widget.player.emit('loadeddata');
  assert.equal(widget.status.textContent, 'Connecting…');
  assert.equal(host.timerCount(60000), 1);
  const track = new Target(); track.kind = 'video'; track.muted = true;
  host.peers[0].emit('track', { streams: [stream], track });
  widget.player.emit('loadeddata');
  assert.equal(widget.status.textContent, 'Live');
  assert.equal(host.timerCount(60000), 0);
  await host.fire(60000);
  assert.equal(host.peers[0].closed, 0);
  widget.cleanup();
});

test('hiding, final cleanup and client replacement retire their first-media deadline', async () => {
  for (const action of ['hide', 'unsubscribe', 'replace']) {
    const host = await camera({ completeIce: true });
    const shared = host.live();
    const unsubscribe = shared.subscribe(() => {});
    await host.flush();
    const oldDeadline = [...host.timers.values()].find((entry) => entry.delay === 60000).callback;
    let unsubscribeNew;
    if (action === 'hide') await host.setVisible(false);
    else if (action === 'unsubscribe') unsubscribe();
    else {
      host.state.client = host.client('second');
      unsubscribeNew = host.live().subscribe(() => {});
      await host.flush();
    }
    assert.equal(host.peers[0].closed, 1);
    assert.equal(host.timerCount(60000), action === 'replace' ? 1 : 0);
    oldDeadline(); await host.flush();
    assert.equal(shared.status === 'Camera did not send video. Tap to retry.', false, 'retired timer cannot replace the new state with an error');
    if (action === 'replace') assert.equal(host.peers[1].closed, 0);
    unsubscribe(); unsubscribeNew?.();
    assert.equal(host.timers.size, 0);
    assert.equal(host.visibility.size, 0);
  }
});
