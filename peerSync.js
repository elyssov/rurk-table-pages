// peerSync.js — лёгкий wrapper над PeerJS для cross-device sync RURK Table.
// Подключается из index.html ПОСЛЕ peerjs.min.js. Экспортит window.rurkPeer.

(function () {
  const log = (msg) => console.log('[rurk-peer]', msg);

  const state = {
    peer: null,
    isHost: false,
    roomId: null,
    connections: [],   // host: список dataConnections к игрокам; player: список с одной conn к мастеру
    onSnapshot: null,  // Kotlin callback(snapshotJsonString)
    onStatus: null,    // Kotlin callback(statusString) — connected | disconnected | error | open
    lastSnapshotJson: null,
  };

  function setStatus(s) {
    if (state.onStatus) try { state.onStatus(s); } catch (e) { console.error(e); }
  }

  function broadcastSnapshot(json) {
    state.lastSnapshotJson = json;
    state.connections.forEach((c) => {
      try { if (c.open) c.send({ kind: 'snapshot', json }); }
      catch (e) { console.error('send err', e); }
    });
  }

  function handleIncoming(conn, data) {
    if (!data || !data.kind) return;
    if (data.kind === 'snapshot' && state.onSnapshot) {
      try { state.onSnapshot(data.json); } catch (e) { console.error(e); }
      // если хост получает snapshot от игрока — broadcastим всем (sync state)
      if (state.isHost) {
        state.connections.filter((c) => c !== conn && c.open)
          .forEach((c) => { try { c.send({ kind: 'snapshot', json: data.json }); } catch (e) {} });
      }
    } else if (data.kind === 'hello') {
      log('hello from ' + conn.peer);
      // отправим текущий snapshot сразу
      if (state.lastSnapshotJson) {
        try { conn.send({ kind: 'snapshot', json: state.lastSnapshotJson }); } catch (e) {}
      }
    }
  }

  function setupConnection(conn) {
    conn.on('open', () => {
      log('conn open with ' + conn.peer);
      setStatus('connected');
      // если игрок — пошлём hello чтобы хост ответил snapshot'ом
      if (!state.isHost) {
        try { conn.send({ kind: 'hello' }); } catch (e) {}
      } else if (state.lastSnapshotJson) {
        // если хост — сразу отдаём snapshot новому игроку
        try { conn.send({ kind: 'snapshot', json: state.lastSnapshotJson }); } catch (e) {}
      }
    });
    conn.on('data', (data) => handleIncoming(conn, data));
    conn.on('close', () => {
      log('conn closed ' + conn.peer);
      state.connections = state.connections.filter((c) => c !== conn);
      if (state.connections.length === 0) setStatus('disconnected');
    });
    conn.on('error', (err) => {
      console.error('[rurk-peer] conn err', err);
      setStatus('error');
    });
  }

  window.rurkPeer = {
    start: function (roomId, isHost, onSnapshot, onStatus) {
      if (state.peer) {
        try { state.peer.destroy(); } catch (e) {}
      }
      state.roomId = roomId;
      state.isHost = isHost;
      state.onSnapshot = onSnapshot;
      state.onStatus = onStatus;
      state.connections = [];

      const peerId = isHost ? 'rurk-' + roomId : ('rurk-p-' + roomId + '-' + Math.random().toString(36).slice(2, 8));
      log('starting peer ' + peerId + ' (host=' + isHost + ')');

      const peer = new Peer(peerId, {
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
          ],
        },
      });
      state.peer = peer;

      peer.on('open', (id) => {
        log('peer open ' + id);
        setStatus('open');
        if (!isHost) {
          // подключаемся к хосту
          const conn = peer.connect('rurk-' + roomId, { reliable: true });
          state.connections.push(conn);
          setupConnection(conn);
        }
      });

      peer.on('connection', (conn) => {
        log('incoming conn from ' + conn.peer);
        state.connections.push(conn);
        setupConnection(conn);
      });

      peer.on('error', (err) => {
        console.error('[rurk-peer] peer err', err.type, err);
        setStatus('error:' + err.type);
      });

      peer.on('disconnected', () => {
        log('peer disconnected — пробую reconnect');
        setStatus('disconnected');
        try { peer.reconnect(); } catch (e) {}
      });

      return peerId;
    },

    send: function (snapshotJson) {
      broadcastSnapshot(snapshotJson);
    },

    stop: function () {
      if (state.peer) {
        try { state.peer.destroy(); } catch (e) {}
      }
      state.peer = null;
      state.connections = [];
      setStatus('stopped');
    },

    status: function () {
      return {
        active: !!state.peer,
        isHost: state.isHost,
        roomId: state.roomId,
        connections: state.connections.length,
      };
    },
  };

  log('peerSync ready');
})();
