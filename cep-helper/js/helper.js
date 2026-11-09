"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // apps/cep-helper/src/engine.ts
  var import_node_crypto = __require("node:crypto");

  // apps/cep-helper/src/timecode.ts
  var DISPLAY_FORMATS = {
    100: { fps: 24, dropFrame: false },
    101: { fps: 25, dropFrame: false },
    102: { fps: 30, dropFrame: true },
    // 29.97 drop-frame
    103: { fps: 30, dropFrame: false },
    // 29.97 non-drop
    104: { fps: 30, dropFrame: false },
    105: { fps: 50, dropFrame: false },
    106: { fps: 60, dropFrame: true },
    // 59.94 drop-frame
    107: { fps: 60, dropFrame: false },
    // 59.94 non-drop
    108: { fps: 60, dropFrame: false },
    109: "frames",
    110: { fps: 24, dropFrame: false },
    // 23.976
    113: { fps: 48, dropFrame: false }
  };
  var TimeError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
    code;
  };
  function toTicks(v, what) {
    const s = String(v);
    if (!/^\d+$/.test(s)) throw new TimeError("bad_time", `${what} must be a whole number of ticks`);
    return BigInt(s);
  }
  function snapToFrame(ticks, ticksPerFrame) {
    const t = toTicks(ticks, "time");
    const tpf = toTicks(ticksPerFrame, "timebase");
    if (tpf <= 0n) throw new TimeError("bad_time", "timebase must be positive");
    const frame = (t + tpf / 2n) / tpf;
    const snapped = frame * tpf;
    if (frame > BigInt(Number.MAX_SAFE_INTEGER)) throw new TimeError("bad_time", "time out of range");
    return { frame: Number(frame), ticks: snapped.toString(), snappedBy: (snapped - t).toString() };
  }
  var pad = (n) => String(n).padStart(2, "0");
  function framesToTimecode(frame, fps, dropFrame) {
    if (!Number.isInteger(frame) || frame < 0) throw new TimeError("bad_time", "frame must be >= 0");
    let f = frame;
    if (dropFrame) {
      if (fps !== 30 && fps !== 60) throw new TimeError("bad_time", "drop-frame needs 30 or 60 fps");
      const drop = fps === 30 ? 2 : 4;
      const per10 = fps * 600 - drop * 9;
      const per1 = fps * 60 - drop;
      const d = Math.floor(f / per10);
      const m = f % per10;
      f += drop * 9 * d + (m > drop ? drop * Math.floor((m - drop) / per1) : 0);
    }
    const ff = f % fps;
    const totalSec = Math.floor(f / fps);
    const sep = dropFrame ? ";" : ":";
    return pad(Math.floor(totalSec / 3600)) + sep + pad(Math.floor(totalSec / 60) % 60) + sep + pad(totalSec % 60) + sep + pad(ff);
  }
  function timecodeForDisplay(frame, displayFormat) {
    const fmt = DISPLAY_FORMATS[displayFormat];
    if (!fmt)
      throw new TimeError(
        "unsupported_display_format",
        `sequence display format ${displayFormat} is not a timecode or frame format the helper knows`
      );
    if (fmt === "frames") return String(frame);
    return framesToTimecode(frame, fmt.fps, fmt.dropFrame);
  }

  // packages/core/src/local-paths.ts
  var isWindowsPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\]/.test(p);
  var ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/;
  var isAbsolutePath = (p) => ABSOLUTE_PATH.test(p);
  var sepOf = (p) => isWindowsPath(p) || p.includes("\\") && !p.includes("/") ? "\\" : "/";
  function joinPath(base2, ...parts) {
    const sep = sepOf(base2);
    let out = base2.length > 1 ? base2.replace(/[\\/]+$/, "") : base2;
    for (const part of parts) {
      const p = part.replace(/^[\\/]+|[\\/]+$/g, "").replace(/[\\/]+/g, sep);
      if (p) out += (out.endsWith(sep) ? "" : sep) + p;
    }
    return out;
  }
  var hasParentSegment = (p) => p.split(/[\\/]/).includes("..");
  function goblinsDir(platform, home, env = {}) {
    if (platform === "darwin") return joinPath(home, "Library", "Application Support", "Goblins");
    if (platform === "win32") return joinPath(home, "AppData", "Roaming", "Goblins");
    return joinPath(env.XDG_CONFIG_HOME || joinPath(home, ".config"), "goblins");
  }

  // apps/cep-helper/src/protocol.ts
  var PROTOCOL = 1;
  var HELPER_NAME = "Goblins CEP Helper";
  var HELPER_VERSION = "0.1.0";
  var CAPABILITIES = ["razor", "set_speed", "set_clip_gain", "import_xml_into_bin"];
  var MAX_ITEMS = 200;
  var ProtocolError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
    code;
  };
  var bad = (message) => {
    throw new ProtocolError("invalid_args", message);
  };
  var TICKS = /^\d{1,20}$/;
  var APPROVAL_WORDS = /approv|auto_?apply|autoapply|scope|decision|bypass/i;
  function parseTrack(s) {
    if (typeof s !== "string") return bad('track must be a string like "V1" or "A2"');
    const m = /^([VA])([1-9]\d{0,2})$/.exec(s);
    if (!m) return bad(`bad track "${s}" (use V1\u2026, A1\u2026)`);
    return { trackType: m[1] === "V" ? "video" : "audio", trackIndex: Number(m[2]) - 1 };
  }
  function trackLabel(t) {
    return (t.trackType === "video" ? "V" : "A") + (t.trackIndex + 1);
  }
  function parseClipRef(ref) {
    if (typeof ref === "string") {
      const m = /^([VA]\d+)@(\d+)$/.exec(ref);
      if (!m) return bad(`bad clipKey "${ref}"`);
      return parseClipRef({ track: m[1], startTicks: m[2] });
    }
    if (!ref || typeof ref !== "object" || Array.isArray(ref)) return bad("clip must be an object");
    const r = ref;
    strictKeys(r, ["track", "startTicks", "name", "clipKey"], "clip");
    if (r.clipKey !== void 0) return parseClipRef(r.clipKey);
    const t = parseTrack(r.track);
    if (typeof r.startTicks !== "string" || !TICKS.test(r.startTicks))
      return bad("clip.startTicks must be ticks as a decimal string");
    if (r.name !== void 0 && (typeof r.name !== "string" || r.name.length > 500))
      return bad("clip.name must be a string");
    return {
      ...t,
      clipStart: r.startTicks.replace(/^0+(?=\d)/, ""),
      name: r.name,
      label: `${trackLabel(t)}@${r.startTicks}`
    };
  }
  function strictKeys(o, allowed, where) {
    for (const k of Object.keys(o)) {
      if (APPROVAL_WORDS.test(k))
        bad(`${where}: "${k}" is not accepted (approval never comes from the request)`);
      if (!allowed.includes(k)) bad(`${where}: unknown key "${k}"`);
    }
  }
  function clipList(v) {
    if (!Array.isArray(v) || v.length === 0) return bad("clips must be a non-empty array");
    if (v.length > MAX_ITEMS) return bad(`at most ${MAX_ITEMS} clips per request`);
    const clips = v.map(parseClipRef);
    const seen = /* @__PURE__ */ new Set();
    for (const c of clips) {
      if (seen.has(c.label)) bad(`clip ${c.label} is listed twice`);
      seen.add(c.label);
    }
    return clips;
  }
  var COMMON = ["reason", "expectedRevision", "waitSeconds"];
  function parseArgs(tool, args) {
    if (!args || typeof args !== "object" || Array.isArray(args))
      return bad("args must be an object");
    const a = args;
    switch (tool) {
      case "razor": {
        strictKeys(a, ["ticks", "tracks", ...COMMON], "razor");
        if (typeof a.ticks !== "string" || !TICKS.test(a.ticks))
          return bad("ticks must be a decimal string");
        let tracks = "all";
        if (a.tracks !== void 0 && a.tracks !== "all") {
          if (!Array.isArray(a.tracks) || a.tracks.length === 0 || a.tracks.length > 64)
            return bad('tracks must be "all" or a list like ["V1","A1"]');
          tracks = a.tracks.map(parseTrack);
          const keys = new Set(tracks.map(trackLabel));
          if (keys.size !== tracks.length) bad("a track is listed twice");
        }
        return { tool, ticks: a.ticks, tracks };
      }
      case "set_speed": {
        strictKeys(a, ["clips", "percent", "reverse", "ripple", ...COMMON], "set_speed");
        const p = a.percent;
        if (typeof p !== "number" || !Number.isFinite(p) || p < 5 || p > 2e3)
          return bad("percent must be a number between 5 and 2000");
        for (const k of ["reverse", "ripple"])
          if (a[k] !== void 0 && typeof a[k] !== "boolean") bad(`${k} must be true or false`);
        return {
          tool,
          clips: clipList(a.clips),
          percent: p,
          reverse: a.reverse === true,
          ripple: a.ripple === true
        };
      }
      case "set_clip_gain": {
        strictKeys(a, ["clips", "gainDb", ...COMMON], "set_clip_gain");
        const g = a.gainDb;
        if (typeof g !== "number" || !Number.isFinite(g) || g < -60 || g > 15)
          return bad("gainDb must be a number between -60 and +15");
        const clips = clipList(a.clips);
        if (clips.some((c) => c.trackType !== "audio"))
          bad("set_clip_gain takes audio clips (A tracks) only");
        return { tool, clips, gainDb: g };
      }
      case "import_xml_into_bin": {
        strictKeys(a, ["xmlPath", "binPath", ...COMMON], "import_xml_into_bin");
        const x = a.xmlPath;
        if (typeof x !== "string" || !isAbsolutePath(x) || !/\.xml$/i.test(x) || x.includes("\0"))
          return bad("xmlPath must be an absolute path to a .xml file");
        if (hasParentSegment(x)) return bad('xmlPath must not contain ".."');
        const bp = a.binPath;
        const parts = typeof bp === "string" ? bp.split("/").map((s) => s.trim()).filter(Boolean) : Array.isArray(bp) && bp.every((s) => typeof s === "string") ? bp : bad('binPath must be "Bin/Sub" or ["Bin","Sub"]');
        if (!parts.length || parts.length > 16 || parts.some((s) => !s || s.length > 255))
          bad("binPath must name 1\u201316 bins");
        return { tool, xmlPath: x, binPath: parts };
      }
    }
  }
  function parseRequest(f) {
    if (typeof f.id !== "string" || !/^[\w.:-]{1,100}$/.test(f.id))
      throw new ProtocolError("invalid_args", "bad id");
    if (f.approvedBy !== "uxp")
      throw new ProtocolError(
        "not_approved",
        "The CEP helper runs only edits approved in the Goblins panel."
      );
    if (typeof f.tool !== "string" || !CAPABILITIES.includes(f.tool))
      throw new ProtocolError("unknown_tool", `The CEP helper does not run "${String(f.tool)}".`);
    const tool = f.tool;
    const p = f.project;
    if (!p || typeof p.path !== "string" || !p.path)
      throw new ProtocolError("wrong_project", "The request does not name the project path.");
    const s = f.sequence;
    const needsSeq = tool !== "import_xml_into_bin";
    if (needsSeq && (!s || typeof s.id !== "string" || !s.id))
      throw new ProtocolError("wrong_sequence", "The request does not name the sequence.");
    const undoName = typeof f.undoName === "string" && f.undoName ? f.undoName.slice(0, 200) : "Goblins AI";
    return {
      id: f.id,
      tool,
      args: parseArgs(tool, f.args),
      project: { path: p.path, guid: typeof p.guid === "string" ? p.guid : void 0 },
      sequence: s && typeof s.id === "string" ? { id: s.id, name: typeof s.name === "string" ? s.name : void 0 } : null,
      undoName
    };
  }
  var TIMEOUTS = {
    info: 1e4,
    razor: 3e4,
    speed: 2e4,
    volume: 15e3,
    importXml: 18e4
  };
  function base(req) {
    var _a, _b;
    return {
      projectPath: req.project.path,
      sequenceId: (_a = req.sequence) == null ? void 0 : _a.id,
      sequenceName: (_b = req.sequence) == null ? void 0 : _b.name
    };
  }
  function infoCall(req) {
    return { op: "info", input: base(req), timeoutMs: TIMEOUTS.info, item: "sequence" };
  }
  function planCalls(req, info) {
    const a = req.args;
    const b = base(req);
    switch (a.tool) {
      case "razor": {
        if (!info) throw new ProtocolError("host_error", "razor needs the sequence info first");
        if (info.zeroPoint !== "0")
          throw new ProtocolError(
            "unsupported",
            "Sequences with a start timecode other than 00:00:00:00 are not supported yet."
          );
        let snap, timecode;
        try {
          snap = snapToFrame(a.ticks, info.timebase);
          timecode = timecodeForDisplay(snap.frame, info.videoDisplayFormat);
        } catch (e) {
          if (e instanceof TimeError) throw new ProtocolError(e.code, e.message);
          throw e;
        }
        return [
          {
            op: "razor",
            input: { ...b, time: snap.ticks, timecode, tracks: a.tracks, includeLinked: false },
            timeoutMs: TIMEOUTS.razor,
            item: `cut@${snap.ticks} (${timecode})`
          }
        ];
      }
      case "set_speed":
        return a.clips.map((c) => ({
          op: "speed",
          input: {
            ...b,
            clip: clipInput(c),
            speed: a.percent / 100,
            reverse: a.reverse,
            ripple: a.ripple
          },
          timeoutMs: TIMEOUTS.speed,
          item: c.label
        }));
      case "set_clip_gain":
        return a.clips.map((c) => ({
          op: "volume",
          input: { ...b, clip: clipInput(c), levelDb: a.gainDb, clearKeyframes: false },
          timeoutMs: TIMEOUTS.volume,
          item: c.label
        }));
      case "import_xml_into_bin":
        return [
          {
            op: "importXml",
            input: { projectPath: req.project.path, xmlPath: a.xmlPath, binPath: a.binPath },
            timeoutMs: TIMEOUTS.importXml,
            item: a.binPath.join("/")
          }
        ];
    }
  }
  function clipInput(c) {
    return { trackType: c.trackType, trackIndex: c.trackIndex, clipStart: c.clipStart, name: c.name };
  }
  function scriptFor(call) {
    const json = JSON.stringify(call.input).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    return `GoblinsCEP.run(${JSON.stringify(call.op)}, ${json})`;
  }
  function parseOpResult(raw) {
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        applied: 0,
        error: { code: "host_error", message: `ExtendScript: ${raw.slice(0, 300)}` }
      };
    }
    if (!v || typeof v !== "object" || typeof v.ok !== "boolean")
      return {
        ok: false,
        applied: 0,
        error: { code: "host_error", message: "ExtendScript returned no result" }
      };
    return v;
  }
  var UNDO_NOTE = "Applied by the CEP helper (ExtendScript). Premiere records each ExtendScript edit as its own undo step, so this cannot be one named step: undo may take the number of steps shown.";
  function refusedResult(id, undoName, code, message) {
    return {
      type: "result",
      id,
      ok: false,
      status: "refused",
      code,
      message,
      applied: [],
      readBack: { ok: false, items: [] },
      undoName,
      undo: { grouped: false, steps: 0, note: UNDO_NOTE },
      warnings: [],
      engine: "cep"
    };
  }
  function appliedEntries(call, r) {
    var _a, _b, _c, _d, _e;
    const rb = r.readBack ?? {};
    switch (call.op) {
      case "razor":
        return (rb.cut ?? []).map((c) => {
          var _a2;
          return {
            target: "clip",
            track: razorTrackLabel(String(c.track)),
            startTicks: String(rb.time),
            field: "split",
            before: c.left ?? null,
            after: ((_a2 = c.right) == null ? void 0 : _a2.name) ?? null
          };
        });
      case "speed":
        return r.applied ? [
          {
            target: "clip",
            ...splitLabel(call.item),
            field: "speed",
            before: { speed: (_a = rb.before) == null ? void 0 : _a.speed, reversed: (_b = rb.before) == null ? void 0 : _b.reversed },
            after: { speed: (_c = rb.after) == null ? void 0 : _c.speed, reversed: (_d = rb.after) == null ? void 0 : _d.reversed },
            endTicks: (_e = rb.after) == null ? void 0 : _e.end
          }
        ] : [];
      case "volume":
        return r.applied ? [
          {
            target: "clip",
            ...splitLabel(call.item),
            field: "gain",
            before: rb.beforeDb,
            after: rb.afterDb
          }
        ] : [];
      case "importXml":
        return (rb.newItems ?? []).map((it) => ({
          target: "project_item",
          field: "imported",
          bin: call.item,
          name: it.name,
          nodeId: it.nodeId,
          before: null,
          after: it.name
        }));
      default:
        return [];
    }
  }
  function razorTrackLabel(key) {
    const m = /^(video|audio)(\d+)$/.exec(key);
    return m ? (m[1] === "video" ? "V" : "A") + (Number(m[2]) + 1) : key;
  }
  function splitLabel(label) {
    const [track, startTicks] = label.split("@");
    return { track, startTicks };
  }

  // apps/cep-helper/src/engine.ts
  var b64url = (b) => b.toString("base64url");
  var keyOf = (token) => b64url((0, import_node_crypto.createHash)("sha256").update(token).digest());
  var hmac = (key, msg) => (0, import_node_crypto.createHmac)("sha256", key).update(msg).digest("base64url");
  function safeEqual(a, b) {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && (0, import_node_crypto.timingSafeEqual)(x, y);
  }
  var PAIR_TTL_MS = 5 * 6e4;
  var FORBIDDEN_FRAME = /approv|auto_?apply|mode|decision|bypass/i;
  var CepEngine = class {
    constructor(deps) {
      this.deps = deps;
      const cfg = deps.store.loadConfig();
      this.engineId = cfg.engineId ?? "e_" + b64url((0, import_node_crypto.randomBytes)(16));
      if (!cfg.engineId) deps.store.saveConfig({ engineId: this.engineId, hubId: cfg.hubId });
    }
    deps;
    socket = null;
    hubId = null;
    discoveryHubId = null;
    key = null;
    // K = base64url(SHA-256(token)), §4.2
    engineNonce = "";
    registered = false;
    pairing = null;
    /** A request (or a timed-out op still running inside ExtendScript) holds the host. */
    hostBusy = null;
    seen = /* @__PURE__ */ new Map();
    diagnostics = { droppedFrames: 0, lateResults: 0 };
    engineId;
    now() {
      return (this.deps.now ?? Date.now)();
    }
    status(s) {
      var _a, _b;
      (_b = (_a = this.deps).onStatus) == null ? void 0 : _b.call(_a, s);
    }
    log(e) {
      var _a, _b;
      (_b = (_a = this.deps).log) == null ? void 0 : _b.call(_a, { at: new Date(this.now()).toISOString(), ...e });
    }
    send(f) {
      var _a;
      (_a = this.socket) == null ? void 0 : _a.send(JSON.stringify(f));
    }
    get isReady() {
      return this.registered;
    }
    /** Called by the transport once the WebSocket to the hub (from the discovery file) is open. */
    async onOpen(socket, discoveryHubId) {
      this.socket = socket;
      this.registered = false;
      this.pairing = null;
      this.engineNonce = b64url((0, import_node_crypto.randomBytes)(24));
      this.discoveryHubId = discoveryHubId;
      this.hubId = null;
      this.key = null;
      this.status({ state: "connecting" });
      this.send({
        type: "hello",
        protocol: PROTOCOL,
        engine: "cep",
        engineId: this.engineId,
        engineNonce: this.engineNonce,
        app: { name: "premierepro", version: this.deps.hostVersion ?? null },
        plugin: { name: HELPER_NAME, version: HELPER_VERSION }
      });
    }
    onClose(detail) {
      this.socket = null;
      this.registered = false;
      this.pairing = null;
      this.status({ state: "disconnected", detail });
    }
    /** Handle one text frame from the hub. Resolves once any request it started has answered. */
    async onMessage(text) {
      let f;
      try {
        f = JSON.parse(text);
      } catch {
        return;
      }
      if (!f || typeof f !== "object" || typeof f.type !== "string") return;
      const type = f.type;
      if (FORBIDDEN_FRAME.test(type)) {
        this.diagnostics.droppedFrames++;
        this.log({ event: "dropped_frame", type });
        return;
      }
      switch (type) {
        case "challenge":
          return this.onChallenge(f);
        case "welcome":
          return this.onWelcome(f);
        case "pair_required":
          return this.onPairRequired(f);
        case "pair_failed":
          this.pairing = null;
          this.status({
            state: "pair_failed",
            detail: "The code was not accepted 5 times. Reconnecting with a new code."
          });
          return;
        case "paired":
          return this.onPaired(f);
        case "ping":
          this.send({ type: "pong", t: f.t });
          return;
        case "request":
          if (!this.registered) return;
          return this.onRequest(f);
        case "cancel":
          if (typeof f.id === "string") this.cancelled.add(f.id);
          return;
        case "error":
          this.log({ event: "hub_error", code: f.code });
          if (f.code === "protocol")
            this.status({ state: "hub_rejected", detail: "protocol version" });
          return;
        default:
          return;
      }
    }
    cancelled = /* @__PURE__ */ new Set();
    async onChallenge(f) {
      var _a;
      const hubId = f.hubId;
      if (typeof hubId !== "string" || typeof f.proof !== "string" || typeof f.hubNonce !== "string")
        return;
      const cfg = this.deps.store.loadConfig();
      const token = cfg.hubId === hubId && hubId === this.discoveryHubId ? await this.deps.store.getToken(hubId) : null;
      const key = token ? keyOf(token) : null;
      if (!key || !safeEqual(hmac(key, this.engineNonce), f.proof)) {
        this.status({
          state: "hub_rejected",
          detail: 'Not paired with this MCP. Press "Pair again" to pair with a new code.'
        });
        this.log({ event: "hub_proof_failed", hubId });
        (_a = this.socket) == null ? void 0 : _a.close(1008, "proof");
        return;
      }
      this.hubId = hubId;
      this.key = key;
      this.send({ type: "auth", mac: hmac(key, f.hubNonce) });
    }
    onWelcome(f) {
      var _a;
      if (!this.key || f.hubId !== this.hubId) {
        this.status({ state: "hub_rejected", detail: "welcome without a verified pairing" });
        (_a = this.socket) == null ? void 0 : _a.close(1008, "unexpected welcome");
        return;
      }
      this.register();
    }
    onPairRequired(f) {
      if (typeof f.hubId !== "string" || typeof f.pairId !== "string") return;
      this.hubId = f.hubId;
      const code = String((0, import_node_crypto.randomInt)(0, 1e6)).padStart(6, "0");
      this.pairing = { pairId: f.pairId, code, expiresAt: this.now() + PAIR_TTL_MS };
      const codeHash = b64url((0, import_node_crypto.createHash)("sha256").update(`${f.hubId}:${f.pairId}:${code}`).digest());
      this.send({ type: "pair_offer", pairId: f.pairId, codeHash });
      this.status({ state: "pairing", code, expiresAt: this.pairing.expiresAt });
    }
    /** The code shown in the panel, while it is valid. */
    get pairingCode() {
      if (!this.pairing || this.now() > this.pairing.expiresAt) return null;
      return this.pairing.code;
    }
    async onPaired(f) {
      if (!this.pairing || typeof f.token !== "string" || f.hubId !== this.hubId || !this.hubId)
        return;
      if (this.now() > this.pairing.expiresAt) return;
      this.key = keyOf(f.token);
      this.pairing = null;
      await this.deps.store.setToken(this.hubId, f.token);
      this.deps.store.saveConfig({ engineId: this.engineId, hubId: this.hubId });
      this.log({ event: "paired", hubId: this.hubId });
      this.register();
    }
    register() {
      this.registered = true;
      this.send({ type: "register", engine: "cep", capabilities: [...CAPABILITIES] });
      this.status({ state: "ready", hubId: this.hubId });
    }
    /** "Pair again" / "Forget AI pairing" in the panel: drop the token and use a new engineId. */
    async forgetPairing() {
      var _a;
      if (this.registered) this.send({ type: "forget_pairing" });
      const cfg = this.deps.store.loadConfig();
      if (cfg.hubId) await this.deps.store.deleteToken(cfg.hubId);
      this.engineId = "e_" + b64url((0, import_node_crypto.randomBytes)(16));
      this.deps.store.saveConfig({ engineId: this.engineId });
      this.key = null;
      this.hubId = null;
      this.registered = false;
      (_a = this.socket) == null ? void 0 : _a.close(1e3, "forget pairing");
    }
    async onRequest(f) {
      var _a;
      const id = typeof f.id === "string" ? f.id : "";
      const undoName = typeof f.undoName === "string" ? f.undoName : "Goblins AI";
      const prior = this.seen.get(id);
      if (prior) return this.send(prior);
      let req;
      try {
        req = parseRequest(f);
      } catch (e) {
        const pe = e instanceof ProtocolError ? e : new ProtocolError("invalid_args", String(e));
        return this.finish(refusedResult(id, undoName, pe.code, pe.message), null);
      }
      if (this.cancelled.has(id))
        return this.finish(
          refusedResult(id, undoName, "cancelled", "The agent cancelled before it started."),
          req
        );
      if (this.hostBusy)
        return this.finish(
          refusedResult(
            id,
            undoName,
            "host_busy",
            `The CEP helper is still waiting for "${this.hostBusy.op}" (request ${this.hostBusy.requestId}) to come back from Premiere.`
          ),
          req
        );
      this.hostBusy = { requestId: id, op: req.tool };
      this.status({ state: "busy", requestId: id, op: req.tool });
      try {
        const result = await this.execute(req);
        this.finish(result, req);
      } finally {
        if (((_a = this.hostBusy) == null ? void 0 : _a.requestId) === id && !this.stuck) this.hostBusy = null;
        if (!this.hostBusy && this.registered) this.status({ state: "ready", hubId: this.hubId });
      }
    }
    stuck = false;
    finish(r, req) {
      if (r.id) {
        this.seen.set(r.id, r);
        if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value);
      }
      this.log({
        event: "result",
        requestId: r.id,
        tool: (req == null ? void 0 : req.tool) ?? null,
        status: r.status,
        code: r.code,
        appliedCount: r.applied.length,
        undoSteps: r.undo.steps
      });
      this.send(r);
    }
    /**
     * Run one ExtendScript op with a time box. ExtendScript cannot be interrupted: on timeout the op
     * may still be running (a dialog, Premiere in another Space), so the host stays marked busy until
     * the late answer arrives, and its state is reported as unknown.
     */
    async run(call, requestId) {
      const p = this.deps.evaluate(scriptFor(call)).then(parseOpResult, (e) => ({
        ok: false,
        applied: 0,
        error: { code: "host_error", message: String((e == null ? void 0 : e.message) ?? e) }
      }));
      let timer;
      const t = new Promise(
        (res) => timer = setTimeout(() => res("timeout"), call.timeoutMs)
      );
      const r = await Promise.race([p, t]);
      clearTimeout(timer);
      if (r === "timeout") {
        this.stuck = true;
        this.hostBusy = { requestId, op: call.op };
        void p.then((late) => {
          this.diagnostics.lateResults++;
          this.log({ event: "late_result", requestId, op: call.op, result: late });
          this.stuck = false;
          this.hostBusy = null;
          if (this.registered) this.status({ state: "ready", hubId: this.hubId });
        });
      }
      return r;
    }
    async execute(req) {
      var _a, _b, _c, _d, _e;
      const applied = [];
      const items = [];
      const warnings = [];
      let steps = 0;
      const done = (status, code, message) => ({
        type: "result",
        id: req.id,
        ok: status === "applied",
        status,
        code,
        message,
        applied,
        readBack: { ok: status === "applied", items },
        undoName: req.undoName,
        undo: { grouped: false, steps, note: UNDO_NOTE },
        warnings,
        engine: "cep"
      });
      let info = null;
      if (req.sequence) {
        const r = await this.run(infoCall(req), req.id);
        if (r === "timeout")
          return done(
            "failed",
            "timeout",
            "Premiere did not answer the read in time (a dialog may be open, or Premiere is in another Space). Nothing was changed."
          );
        if (!r.ok)
          return done("refused", ((_a = r.error) == null ? void 0 : _a.code) ?? "host_error", ((_b = r.error) == null ? void 0 : _b.message) ?? "read failed");
        info = r.readBack;
      }
      let calls;
      try {
        calls = planCalls(req, info);
      } catch (e) {
        const pe = e instanceof ProtocolError ? e : new ProtocolError("host_error", String(e));
        return done("refused", pe.code, pe.message);
      }
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const r = await this.run(call, req.id);
        if (r === "timeout") {
          items.push({ item: call.item, ok: false, state: "unknown" });
          return done(
            "failed",
            "timeout",
            `Premiere did not answer "${call.op}" on ${call.item} within ${call.timeoutMs / 1e3} s. It may still apply; check the timeline before undoing. ${applied.length} item(s) were applied before it.`
          );
        }
        steps += r.ok || r.applied ? r.undoSteps ?? 0 : 0;
        if ((_c = r.warnings) == null ? void 0 : _c.length) warnings.push(...r.warnings);
        items.push({ item: call.item, ok: r.ok, ...r.readBack ?? {} });
        applied.push(...appliedEntries(call, r));
        if (!r.ok) {
          const code = ((_d = r.error) == null ? void 0 : _d.code) ?? "host_error";
          const message = ((_e = r.error) == null ? void 0 : _e.message) ?? "failed";
          if (r.refused && applied.length === 0 && steps === 0) return done("refused", code, message);
          return done(
            "failed",
            r.refused ? code : code === "script_error" ? "host_error" : code,
            `${message} (${call.item}; ${applied.length} item(s) applied before stopping)`
          );
        }
      }
      return done("applied", null, `${applied.length} item(s) applied; undo takes ${steps} step(s).`);
    }
  };

  // apps/cep-helper/src/host.ts
  var import_node_child_process = __require("node:child_process");
  var import_node_fs = __require("node:fs");
  var import_node_os = __require("node:os");
  var import_node_path = __require("node:path");
  function goblinsDir2(home = (0, import_node_os.homedir)(), platform = process.platform, env = process.env) {
    return goblinsDir(platform, home, env);
  }
  function readDiscovery(dir = goblinsDir2()) {
    let v;
    try {
      v = JSON.parse((0, import_node_fs.readFileSync)((0, import_node_path.join)(dir, "premiere-mcp.json"), "utf8"));
    } catch {
      return null;
    }
    if (!v || v.v !== 1) return null;
    if (!Number.isInteger(v.port) || v.port < 1024 || v.port > 65535) return null;
    if (typeof v.hubId !== "string" || !/^h_[\w-]{8,64}$/.test(v.hubId)) return null;
    return { port: v.port, hubId: v.hubId, pid: v.pid };
  }
  function hubUrls(d) {
    return [`ws://127.0.0.1:${d.port}/goblins-premiere`, `ws://localhost:${d.port}/goblins-premiere`];
  }
  var SERVICE = "Goblins CEP Helper";
  function localStore(dir = goblinsDir2(), platform = process.platform) {
    return platform === "darwin" ? macStore(dir) : fileStore(dir);
  }
  function configFile(dir) {
    const file = (0, import_node_path.join)(dir, "cep-helper.json");
    return {
      loadConfig() {
        try {
          const v = JSON.parse((0, import_node_fs.readFileSync)(file, "utf8"));
          return {
            engineId: typeof v.engineId === "string" ? v.engineId : void 0,
            hubId: typeof v.hubId === "string" ? v.hubId : void 0
          };
        } catch {
          return {};
        }
      },
      saveConfig(c) {
        writePrivate(dir, file, { engineId: c.engineId, hubId: c.hubId ?? null });
      }
    };
  }
  function writePrivate(dir, file, value) {
    (0, import_node_fs.mkdirSync)(dir, { recursive: true, mode: 448 });
    const tmp = file + ".tmp";
    (0, import_node_fs.writeFileSync)(tmp, JSON.stringify(value), { mode: 384 });
    (0, import_node_fs.renameSync)(tmp, file);
  }
  var TOKEN = /^[\w-]{16,128}$/;
  var HUB = /^h_[\w-]+$/;
  function fileStore(dir = goblinsDir2()) {
    const file = (0, import_node_path.join)(dir, "cep-helper-tokens.json");
    const all = () => {
      try {
        const v = JSON.parse((0, import_node_fs.readFileSync)(file, "utf8"));
        return v && typeof v === "object" && !Array.isArray(v) ? v : {};
      } catch {
        return {};
      }
    };
    return {
      ...configFile(dir),
      async getToken(hubId) {
        const t = all()[hubId];
        return typeof t === "string" && TOKEN.test(t) ? t : null;
      },
      async setToken(hubId, token) {
        if (!TOKEN.test(token) || !HUB.test(hubId)) throw new Error("bad token");
        writePrivate(dir, file, { ...all(), [hubId]: token });
      },
      async deleteToken(hubId) {
        const v = all();
        if (!(hubId in v)) return;
        delete v[hubId];
        writePrivate(dir, file, v);
      }
    };
  }
  function macStore(dir = goblinsDir2()) {
    return {
      ...configFile(dir),
      getToken(hubId) {
        return new Promise(
          (resolve) => (0, import_node_child_process.execFile)(
            "/usr/bin/security",
            ["find-generic-password", "-s", SERVICE, "-a", "hub:" + hubId, "-w"],
            (err, out) => resolve(err ? null : out.trim() || null)
          )
        );
      },
      setToken(hubId, token) {
        if (!TOKEN.test(token) || !HUB.test(hubId)) return Promise.reject(new Error("bad token"));
        return keychainStdin(
          `add-generic-password -U -s "${SERVICE}" -a "hub:${hubId}" -w "${token}"
`
        );
      },
      deleteToken(hubId) {
        return new Promise(
          (resolve) => (0, import_node_child_process.execFile)(
            "/usr/bin/security",
            ["delete-generic-password", "-s", SERVICE, "-a", "hub:" + hubId],
            () => resolve()
          )
        );
      }
    };
  }
  function keychainStdin(cmd) {
    return new Promise((resolve, reject) => {
      const p = (0, import_node_child_process.spawn)("/usr/bin/security", ["-i"], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("exit", (code) => code === 0 ? resolve() : reject(new Error("keychain write failed")));
      p.stdin.end(cmd);
    });
  }
  function fileLogger(dir = goblinsDir2()) {
    const file = (0, import_node_path.join)(dir, "cep-helper.log");
    return (e) => {
      try {
        (0, import_node_fs.mkdirSync)(dir, { recursive: true, mode: 448 });
        try {
          if ((0, import_node_fs.statSync)(file).size > 5e6) (0, import_node_fs.renameSync)(file, file + ".1");
        } catch {
        }
        (0, import_node_fs.appendFileSync)(file, JSON.stringify(e) + "\n", { mode: 384 });
      } catch {
      }
    };
  }

  // apps/cep-helper/src/panel.ts
  var window = globalThis;
  var document = window.document;
  var cep = window.__adobe_cep__;
  function evaluate(script) {
    return new Promise((resolve) => cep.evalScript(script, (r) => resolve(String(r))));
  }
  function hostVersion() {
    try {
      return JSON.parse(cep.getHostEnvironment()).appVersion;
    } catch {
      return void 0;
    }
  }
  var $ = (id) => document.getElementById(id);
  function show(s) {
    const code = $("code");
    const status = $("status");
    code.textContent = "";
    switch (s.state) {
      case "pairing":
        status.textContent = "Pair with your AI: tell it this code (valid 5 minutes).";
        code.textContent = s.code.slice(0, 3) + " " + s.code.slice(3);
        break;
      case "ready":
        status.textContent = "Connected to Goblins Premiere. Edits come only after you approve them in the Goblins panel.";
        break;
      case "busy":
        status.textContent = `Running an approved edit (${s.op})\u2026`;
        break;
      case "connecting":
        status.textContent = "Connecting to Goblins Premiere\u2026";
        break;
      case "pair_failed":
      case "hub_rejected":
        status.textContent = s.detail;
        break;
      default:
        status.textContent = "Waiting for the Goblins Premiere MCP to start" + (s.detail ? ` (${s.detail})` : "") + ".";
    }
  }
  var log = fileLogger();
  var engine = new CepEngine({
    evaluate,
    store: localStore(),
    log,
    hostVersion: hostVersion(),
    onStatus: show
  });
  var ws = null;
  var backoff = [1, 2, 5, 10];
  var attempt = 0;
  function connect() {
    const d = readDiscovery();
    if (!d) return setTimeout(connect, 3e3);
    const urls = hubUrls(d);
    const url = urls[attempt % urls.length];
    ws = new window.WebSocket(url);
    ws.onopen = () => {
      attempt = 0;
      void engine.onOpen({ send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) }, d.hubId);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string" && ev.data.length <= 4 * 1024 * 1024)
        void engine.onMessage(ev.data);
    };
    ws.onclose = () => {
      engine.onClose();
      const wait = backoff[Math.min(attempt, backoff.length - 1)];
      attempt++;
      setTimeout(connect, wait * 1e3);
    };
    ws.onerror = () => {
    };
  }
  window.addEventListener("load", () => {
    $("version").textContent = "v" + HELPER_VERSION;
    $("forget").addEventListener("click", () => void engine.forgetPairing());
    show({ state: "disconnected" });
    connect();
  });
})();
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vYXBwcy9jZXAtaGVscGVyL3NyYy9lbmdpbmUudHMiLCAiLi4vLi4vLi4vYXBwcy9jZXAtaGVscGVyL3NyYy90aW1lY29kZS50cyIsICIuLi8uLi8uLi9wYWNrYWdlcy9jb3JlL3NyYy9sb2NhbC1wYXRocy50cyIsICIuLi8uLi8uLi9hcHBzL2NlcC1oZWxwZXIvc3JjL3Byb3RvY29sLnRzIiwgIi4uLy4uLy4uL2FwcHMvY2VwLWhlbHBlci9zcmMvaG9zdC50cyIsICIuLi8uLi8uLi9hcHBzL2NlcC1oZWxwZXIvc3JjL3BhbmVsLnRzIl0sCiAgInNvdXJjZXNDb250ZW50IjogWyIvLyBUaGUgQ0VQIGVuZ2luZTogY29ubmVjdHMgdG8gdGhlIEdvYmxpbnMgUHJlbWllcmUgTUNQIGh1YiAoZG9jcy9haS1lZGl0aW5nLm1kIFx1MDBBNzNcdTIwMTNcdTAwQTc0KSwgcGFpcnMgd2l0aCBhXG4vLyBvbmUtdGltZSBjb2RlIHNob3duIGluIHRoaXMgaGVscGVyJ3Mgb3duIHBhbmVsLCByZWdpc3RlcnMgaXRzIHRvb2xzIGFuZCBydW5zIGFwcHJvdmVkIHJlcXVlc3RzXG4vLyAoXHUwMEE3Ni43KSBvbmUgYXQgYSB0aW1lIHRocm91Z2ggRXh0ZW5kU2NyaXB0LiBFdmVyeXRoaW5nIGhvc3Qtc3BlY2lmaWMgaXMgaW5qZWN0ZWQgc28gdGhlIGxvZ2ljIGlzXG4vLyB1bml0LXRlc3RlZCB3aXRoIGEgZmFrZSBodWIgYW5kIGEgZmFrZSBFeHRlbmRTY3JpcHQgZXZhbHVhdG9yICh0ZXN0cy9jZXAtaGVscGVyLnRlc3QudHMpLlxuaW1wb3J0IHsgY3JlYXRlSGFzaCwgY3JlYXRlSG1hYywgcmFuZG9tQnl0ZXMsIHJhbmRvbUludCwgdGltaW5nU2FmZUVxdWFsIH0gZnJvbSAnbm9kZTpjcnlwdG8nO1xuaW1wb3J0IHtcbiAgYXBwbGllZEVudHJpZXMsXG4gIENBUEFCSUxJVElFUyxcbiAgSEVMUEVSX05BTUUsXG4gIEhFTFBFUl9WRVJTSU9OLFxuICBpbmZvQ2FsbCxcbiAgcGFyc2VPcFJlc3VsdCxcbiAgcGFyc2VSZXF1ZXN0LFxuICBwbGFuQ2FsbHMsXG4gIFBST1RPQ09MLFxuICBQcm90b2NvbEVycm9yLFxuICByZWZ1c2VkUmVzdWx0LFxuICBzY3JpcHRGb3IsXG4gIFVORE9fTk9URSxcbiAgdHlwZSBDZXBSZXF1ZXN0LFxuICB0eXBlIE9wQ2FsbCxcbiAgdHlwZSBPcFJlc3VsdCxcbiAgdHlwZSBSZXN1bHRGcmFtZSxcbiAgdHlwZSBTZXFJbmZvLFxufSBmcm9tICcuL3Byb3RvY29sLmpzJztcblxuLyoqIFJ1bnMgb25lIEV4dGVuZFNjcmlwdCBzdHJpbmcgYW5kIHJlc29sdmVzIHdpdGggaXRzIHN0cmluZyByZXN1bHQgKENFUCBldmFsU2NyaXB0KS4gKi9cbmV4cG9ydCB0eXBlIEV2YWx1YXRvciA9IChzY3JpcHQ6IHN0cmluZykgPT4gUHJvbWlzZTxzdHJpbmc+O1xuXG5leHBvcnQgaW50ZXJmYWNlIFNvY2tldCB7XG4gIHNlbmQodGV4dDogc3RyaW5nKTogdm9pZDtcbiAgY2xvc2UoY29kZT86IG51bWJlciwgcmVhc29uPzogc3RyaW5nKTogdm9pZDtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBTdG9yZSB7XG4gIC8qKiBOb24tc2VjcmV0IHNldHRpbmdzIChlbmdpbmVJZCwgaHViSWQpLiAqL1xuICBsb2FkQ29uZmlnKCk6IHsgZW5naW5lSWQ/OiBzdHJpbmc7IGh1YklkPzogc3RyaW5nIH07XG4gIHNhdmVDb25maWcoYzogeyBlbmdpbmVJZDogc3RyaW5nOyBodWJJZD86IHN0cmluZyB9KTogdm9pZDtcbiAgLyoqIFBhaXJpbmcgdG9rZW46IG1hY09TIEtleWNoYWluLCBvciBhIHBlci11c2VyIGZpbGUgb24gV2luZG93cyAoaG9zdC50cyBsb2NhbFN0b3JlKS4gKi9cbiAgZ2V0VG9rZW4oaHViSWQ6IHN0cmluZyk6IFByb21pc2U8c3RyaW5nIHwgbnVsbD47XG4gIHNldFRva2VuKGh1YklkOiBzdHJpbmcsIHRva2VuOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+O1xuICBkZWxldGVUb2tlbihodWJJZDogc3RyaW5nKTogUHJvbWlzZTx2b2lkPjtcbn1cblxuZXhwb3J0IGludGVyZmFjZSBFbmdpbmVEZXBzIHtcbiAgZXZhbHVhdGU6IEV2YWx1YXRvcjtcbiAgc3RvcmU6IFN0b3JlO1xuICBub3c/OiAoKSA9PiBudW1iZXI7XG4gIGxvZz86IChlbnRyeTogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+IHZvaWQ7XG4gIGhvc3RWZXJzaW9uPzogc3RyaW5nO1xuICBvblN0YXR1cz86IChzOiBFbmdpbmVTdGF0dXMpID0+IHZvaWQ7XG59XG5cbmV4cG9ydCB0eXBlIEVuZ2luZVN0YXR1cyA9XG4gIHwgeyBzdGF0ZTogJ2Rpc2Nvbm5lY3RlZCc7IGRldGFpbD86IHN0cmluZyB9XG4gIHwgeyBzdGF0ZTogJ2Nvbm5lY3RpbmcnIH1cbiAgfCB7IHN0YXRlOiAncGFpcmluZyc7IGNvZGU6IHN0cmluZzsgZXhwaXJlc0F0OiBudW1iZXIgfVxuICB8IHsgc3RhdGU6ICdwYWlyX2ZhaWxlZCc7IGRldGFpbDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiAncmVhZHknOyBodWJJZDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiAnYnVzeSc7IHJlcXVlc3RJZDogc3RyaW5nOyBvcDogc3RyaW5nIH1cbiAgfCB7IHN0YXRlOiAnaHViX3JlamVjdGVkJzsgZGV0YWlsOiBzdHJpbmcgfTtcblxuY29uc3QgYjY0dXJsID0gKGI6IEJ1ZmZlcikgPT4gYi50b1N0cmluZygnYmFzZTY0dXJsJyk7XG4vKiogSyA9IGJhc2U2NHVybChTSEEtMjU2KHRva2VuKSkgXHUyMDE0IHRoZSBvbmx5IHBhaXJpbmcgc2VjcmV0IHVzZWQgYWZ0ZXIgcGFpcmluZyAoXHUwMEE3NC4yKS4gKi9cbmV4cG9ydCBjb25zdCBrZXlPZiA9ICh0b2tlbjogc3RyaW5nKSA9PiBiNjR1cmwoY3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKHRva2VuKS5kaWdlc3QoKSk7XG5leHBvcnQgY29uc3QgaG1hYyA9IChrZXk6IHN0cmluZywgbXNnOiBzdHJpbmcpID0+XG4gIGNyZWF0ZUhtYWMoJ3NoYTI1NicsIGtleSkudXBkYXRlKG1zZykuZGlnZXN0KCdiYXNlNjR1cmwnKTtcbmZ1bmN0aW9uIHNhZmVFcXVhbChhOiBzdHJpbmcsIGI6IHN0cmluZykge1xuICBjb25zdCB4ID0gQnVmZmVyLmZyb20oYSk7XG4gIGNvbnN0IHkgPSBCdWZmZXIuZnJvbShiKTtcbiAgcmV0dXJuIHgubGVuZ3RoID09PSB5Lmxlbmd0aCAmJiB0aW1pbmdTYWZlRXF1YWwoeCwgeSk7XG59XG5jb25zdCBQQUlSX1RUTF9NUyA9IDUgKiA2MF8wMDA7XG4vLyBGcmFtZXMgdGhhdCB3b3VsZCBjYXJyeSBhbiBhcHByb3ZhbCBkZWNpc2lvbiBvciBtb2RlOiBuZXZlciBhY2NlcHRlZCBmcm9tIHRoZSBodWIgKFx1MDBBNzYuNSkuXG5jb25zdCBGT1JCSURERU5fRlJBTUUgPSAvYXBwcm92fGF1dG9fP2FwcGx5fG1vZGV8ZGVjaXNpb258YnlwYXNzL2k7XG5cbmV4cG9ydCBjbGFzcyBDZXBFbmdpbmUge1xuICBwcml2YXRlIHNvY2tldDogU29ja2V0IHwgbnVsbCA9IG51bGw7XG4gIHByaXZhdGUgaHViSWQ6IHN0cmluZyB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIGRpc2NvdmVyeUh1YklkOiBzdHJpbmcgfCBudWxsID0gbnVsbDtcbiAgcHJpdmF0ZSBrZXk6IHN0cmluZyB8IG51bGwgPSBudWxsOyAvLyBLID0gYmFzZTY0dXJsKFNIQS0yNTYodG9rZW4pKSwgXHUwMEE3NC4yXG4gIHByaXZhdGUgZW5naW5lTm9uY2UgPSAnJztcbiAgcHJpdmF0ZSByZWdpc3RlcmVkID0gZmFsc2U7XG4gIHByaXZhdGUgcGFpcmluZzogeyBwYWlySWQ6IHN0cmluZzsgY29kZTogc3RyaW5nOyBleHBpcmVzQXQ6IG51bWJlciB9IHwgbnVsbCA9IG51bGw7XG4gIC8qKiBBIHJlcXVlc3QgKG9yIGEgdGltZWQtb3V0IG9wIHN0aWxsIHJ1bm5pbmcgaW5zaWRlIEV4dGVuZFNjcmlwdCkgaG9sZHMgdGhlIGhvc3QuICovXG4gIHByaXZhdGUgaG9zdEJ1c3k6IHsgcmVxdWVzdElkOiBzdHJpbmc7IG9wOiBzdHJpbmcgfSB8IG51bGwgPSBudWxsO1xuICBwcml2YXRlIHNlZW4gPSBuZXcgTWFwPHN0cmluZywgUmVzdWx0RnJhbWU+KCk7XG4gIHJlYWRvbmx5IGRpYWdub3N0aWNzID0geyBkcm9wcGVkRnJhbWVzOiAwLCBsYXRlUmVzdWx0czogMCB9O1xuICBlbmdpbmVJZDogc3RyaW5nO1xuXG4gIGNvbnN0cnVjdG9yKHByaXZhdGUgZGVwczogRW5naW5lRGVwcykge1xuICAgIGNvbnN0IGNmZyA9IGRlcHMuc3RvcmUubG9hZENvbmZpZygpO1xuICAgIHRoaXMuZW5naW5lSWQgPSBjZmcuZW5naW5lSWQgPz8gJ2VfJyArIGI2NHVybChyYW5kb21CeXRlcygxNikpO1xuICAgIGlmICghY2ZnLmVuZ2luZUlkKSBkZXBzLnN0b3JlLnNhdmVDb25maWcoeyBlbmdpbmVJZDogdGhpcy5lbmdpbmVJZCwgaHViSWQ6IGNmZy5odWJJZCB9KTtcbiAgfVxuXG4gIHByaXZhdGUgbm93KCkge1xuICAgIHJldHVybiAodGhpcy5kZXBzLm5vdyA/PyBEYXRlLm5vdykoKTtcbiAgfVxuICBwcml2YXRlIHN0YXR1cyhzOiBFbmdpbmVTdGF0dXMpIHtcbiAgICB0aGlzLmRlcHMub25TdGF0dXM/LihzKTtcbiAgfVxuICBwcml2YXRlIGxvZyhlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIHRoaXMuZGVwcy5sb2c/Lih7IGF0OiBuZXcgRGF0ZSh0aGlzLm5vdygpKS50b0lTT1N0cmluZygpLCAuLi5lIH0pO1xuICB9XG4gIHByaXZhdGUgc2VuZChmOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIHRoaXMuc29ja2V0Py5zZW5kKEpTT04uc3RyaW5naWZ5KGYpKTtcbiAgfVxuXG4gIGdldCBpc1JlYWR5KCkge1xuICAgIHJldHVybiB0aGlzLnJlZ2lzdGVyZWQ7XG4gIH1cblxuICAvKiogQ2FsbGVkIGJ5IHRoZSB0cmFuc3BvcnQgb25jZSB0aGUgV2ViU29ja2V0IHRvIHRoZSBodWIgKGZyb20gdGhlIGRpc2NvdmVyeSBmaWxlKSBpcyBvcGVuLiAqL1xuICBhc3luYyBvbk9wZW4oc29ja2V0OiBTb2NrZXQsIGRpc2NvdmVyeUh1YklkOiBzdHJpbmcpIHtcbiAgICB0aGlzLnNvY2tldCA9IHNvY2tldDtcbiAgICB0aGlzLnJlZ2lzdGVyZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBhaXJpbmcgPSBudWxsO1xuICAgIHRoaXMuZW5naW5lTm9uY2UgPSBiNjR1cmwocmFuZG9tQnl0ZXMoMjQpKTtcbiAgICB0aGlzLmRpc2NvdmVyeUh1YklkID0gZGlzY292ZXJ5SHViSWQ7XG4gICAgdGhpcy5odWJJZCA9IG51bGw7XG4gICAgdGhpcy5rZXkgPSBudWxsO1xuICAgIHRoaXMuc3RhdHVzKHsgc3RhdGU6ICdjb25uZWN0aW5nJyB9KTtcbiAgICAvLyBoZWxsbyBjYXJyaWVzIG5vIHNlY3JldCAoXHUwMEE3NC4xKTsgdGhlIGh1YiBtdXN0IHByb3ZlIHRoZSBwYWlyaW5nIGtleSBmaXJzdCAoXHUwMEE3NC4yKS5cbiAgICB0aGlzLnNlbmQoe1xuICAgICAgdHlwZTogJ2hlbGxvJyxcbiAgICAgIHByb3RvY29sOiBQUk9UT0NPTCxcbiAgICAgIGVuZ2luZTogJ2NlcCcsXG4gICAgICBlbmdpbmVJZDogdGhpcy5lbmdpbmVJZCxcbiAgICAgIGVuZ2luZU5vbmNlOiB0aGlzLmVuZ2luZU5vbmNlLFxuICAgICAgYXBwOiB7IG5hbWU6ICdwcmVtaWVyZXBybycsIHZlcnNpb246IHRoaXMuZGVwcy5ob3N0VmVyc2lvbiA/PyBudWxsIH0sXG4gICAgICBwbHVnaW46IHsgbmFtZTogSEVMUEVSX05BTUUsIHZlcnNpb246IEhFTFBFUl9WRVJTSU9OIH0sXG4gICAgfSk7XG4gIH1cblxuICBvbkNsb3NlKGRldGFpbD86IHN0cmluZykge1xuICAgIHRoaXMuc29ja2V0ID0gbnVsbDtcbiAgICB0aGlzLnJlZ2lzdGVyZWQgPSBmYWxzZTtcbiAgICB0aGlzLnBhaXJpbmcgPSBudWxsO1xuICAgIHRoaXMuc3RhdHVzKHsgc3RhdGU6ICdkaXNjb25uZWN0ZWQnLCBkZXRhaWwgfSk7XG4gIH1cblxuICAvKiogSGFuZGxlIG9uZSB0ZXh0IGZyYW1lIGZyb20gdGhlIGh1Yi4gUmVzb2x2ZXMgb25jZSBhbnkgcmVxdWVzdCBpdCBzdGFydGVkIGhhcyBhbnN3ZXJlZC4gKi9cbiAgYXN5bmMgb25NZXNzYWdlKHRleHQ6IHN0cmluZyk6IFByb21pc2U8dm9pZD4ge1xuICAgIGxldCBmOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgICB0cnkge1xuICAgICAgZiA9IEpTT04ucGFyc2UodGV4dCk7XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICghZiB8fCB0eXBlb2YgZiAhPT0gJ29iamVjdCcgfHwgdHlwZW9mIGYudHlwZSAhPT0gJ3N0cmluZycpIHJldHVybjtcbiAgICBjb25zdCB0eXBlID0gZi50eXBlO1xuICAgIGlmIChGT1JCSURERU5fRlJBTUUudGVzdCh0eXBlKSkge1xuICAgICAgdGhpcy5kaWFnbm9zdGljcy5kcm9wcGVkRnJhbWVzKys7XG4gICAgICB0aGlzLmxvZyh7IGV2ZW50OiAnZHJvcHBlZF9mcmFtZScsIHR5cGUgfSk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHN3aXRjaCAodHlwZSkge1xuICAgICAgY2FzZSAnY2hhbGxlbmdlJzpcbiAgICAgICAgcmV0dXJuIHRoaXMub25DaGFsbGVuZ2UoZik7XG4gICAgICBjYXNlICd3ZWxjb21lJzpcbiAgICAgICAgcmV0dXJuIHRoaXMub25XZWxjb21lKGYpO1xuICAgICAgY2FzZSAncGFpcl9yZXF1aXJlZCc6XG4gICAgICAgIHJldHVybiB0aGlzLm9uUGFpclJlcXVpcmVkKGYpO1xuICAgICAgY2FzZSAncGFpcl9mYWlsZWQnOlxuICAgICAgICAvLyA1IHdyb25nIGNvZGVzOiB0aGUgaHViIGNsb3Nlczsgd2UgcmVjb25uZWN0IGFuZCBzaG93IGEgbmV3IGNvZGUuXG4gICAgICAgIHRoaXMucGFpcmluZyA9IG51bGw7XG4gICAgICAgIHRoaXMuc3RhdHVzKHtcbiAgICAgICAgICBzdGF0ZTogJ3BhaXJfZmFpbGVkJyxcbiAgICAgICAgICBkZXRhaWw6ICdUaGUgY29kZSB3YXMgbm90IGFjY2VwdGVkIDUgdGltZXMuIFJlY29ubmVjdGluZyB3aXRoIGEgbmV3IGNvZGUuJyxcbiAgICAgICAgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgJ3BhaXJlZCc6XG4gICAgICAgIHJldHVybiB0aGlzLm9uUGFpcmVkKGYpO1xuICAgICAgY2FzZSAncGluZyc6XG4gICAgICAgIHRoaXMuc2VuZCh7IHR5cGU6ICdwb25nJywgdDogZi50IH0pO1xuICAgICAgICByZXR1cm47XG4gICAgICBjYXNlICdyZXF1ZXN0JzpcbiAgICAgICAgaWYgKCF0aGlzLnJlZ2lzdGVyZWQpIHJldHVybjtcbiAgICAgICAgcmV0dXJuIHRoaXMub25SZXF1ZXN0KGYpO1xuICAgICAgY2FzZSAnY2FuY2VsJzpcbiAgICAgICAgLy8gQXBwcm92ZWQgQ0VQIGVkaXRzIGFyZSBzaG9ydCBhbmQgY2Fubm90IGJlIGludGVycnVwdGVkIGluc2lkZSBFeHRlbmRTY3JpcHQ7IGEgY2FuY2VsXG4gICAgICAgIC8vIGJlZm9yZSB3ZSBzdGFydCBpcyBob25vdXJlZCBieSB0aGUgcXVldWUgY2hlY2sgaW4gb25SZXF1ZXN0LlxuICAgICAgICBpZiAodHlwZW9mIGYuaWQgPT09ICdzdHJpbmcnKSB0aGlzLmNhbmNlbGxlZC5hZGQoZi5pZCk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGNhc2UgJ2Vycm9yJzpcbiAgICAgICAgdGhpcy5sb2coeyBldmVudDogJ2h1Yl9lcnJvcicsIGNvZGU6IGYuY29kZSB9KTtcbiAgICAgICAgaWYgKGYuY29kZSA9PT0gJ3Byb3RvY29sJylcbiAgICAgICAgICB0aGlzLnN0YXR1cyh7IHN0YXRlOiAnaHViX3JlamVjdGVkJywgZGV0YWlsOiAncHJvdG9jb2wgdmVyc2lvbicgfSk7XG4gICAgICAgIHJldHVybjtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJldHVybjsgLy8gdW5rbm93biB0eXBlcyBhcmUgaWdub3JlZCAoXHUwMEE3NClcbiAgICB9XG4gIH1cbiAgcHJpdmF0ZSBjYW5jZWxsZWQgPSBuZXcgU2V0PHN0cmluZz4oKTtcblxuICBwcml2YXRlIGFzeW5jIG9uQ2hhbGxlbmdlKGY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgY29uc3QgaHViSWQgPSBmLmh1YklkO1xuICAgIGlmICh0eXBlb2YgaHViSWQgIT09ICdzdHJpbmcnIHx8IHR5cGVvZiBmLnByb29mICE9PSAnc3RyaW5nJyB8fCB0eXBlb2YgZi5odWJOb25jZSAhPT0gJ3N0cmluZycpXG4gICAgICByZXR1cm47XG4gICAgY29uc3QgY2ZnID0gdGhpcy5kZXBzLnN0b3JlLmxvYWRDb25maWcoKTtcbiAgICBjb25zdCB0b2tlbiA9XG4gICAgICBjZmcuaHViSWQgPT09IGh1YklkICYmIGh1YklkID09PSB0aGlzLmRpc2NvdmVyeUh1YklkXG4gICAgICAgID8gYXdhaXQgdGhpcy5kZXBzLnN0b3JlLmdldFRva2VuKGh1YklkKVxuICAgICAgICA6IG51bGw7XG4gICAgY29uc3Qga2V5ID0gdG9rZW4gPyBrZXlPZih0b2tlbikgOiBudWxsO1xuICAgIGlmICgha2V5IHx8ICFzYWZlRXF1YWwoaG1hYyhrZXksIHRoaXMuZW5naW5lTm9uY2UpLCBmLnByb29mKSkge1xuICAgICAgLy8gQSBkaWZmZXJlbnQgKG9yIGZha2UpIGh1Yiwgb3Igb3VyIHRva2VuIGlzIGdvbmU6IGFuc3dlciBub3RoaW5nLiBcIlBhaXIgYWdhaW5cIiBpbiB0aGUgcGFuZWxcbiAgICAgIC8vIHJvdGF0ZXMgdGhlIGVuZ2luZUlkIHNvIHRoZSBodWIgYXNrcyBmb3IgYSBmcmVzaCBjb2RlLlxuICAgICAgdGhpcy5zdGF0dXMoe1xuICAgICAgICBzdGF0ZTogJ2h1Yl9yZWplY3RlZCcsXG4gICAgICAgIGRldGFpbDogJ05vdCBwYWlyZWQgd2l0aCB0aGlzIE1DUC4gUHJlc3MgXCJQYWlyIGFnYWluXCIgdG8gcGFpciB3aXRoIGEgbmV3IGNvZGUuJyxcbiAgICAgIH0pO1xuICAgICAgdGhpcy5sb2coeyBldmVudDogJ2h1Yl9wcm9vZl9mYWlsZWQnLCBodWJJZCB9KTtcbiAgICAgIHRoaXMuc29ja2V0Py5jbG9zZSgxMDA4LCAncHJvb2YnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5odWJJZCA9IGh1YklkO1xuICAgIHRoaXMua2V5ID0ga2V5O1xuICAgIHRoaXMuc2VuZCh7IHR5cGU6ICdhdXRoJywgbWFjOiBobWFjKGtleSwgZi5odWJOb25jZSkgfSk7XG4gIH1cblxuICBwcml2YXRlIG9uV2VsY29tZShmOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIC8vIE9ubHkgYWZ0ZXIgb3VyIG93biBjaGVjayBvZiB0aGUgaHViJ3MgcHJvb2YgKGNoYWxsZW5nZSkgb3IgYSBmcmVzaCBwYWlyaW5nLlxuICAgIGlmICghdGhpcy5rZXkgfHwgZi5odWJJZCAhPT0gdGhpcy5odWJJZCkge1xuICAgICAgdGhpcy5zdGF0dXMoeyBzdGF0ZTogJ2h1Yl9yZWplY3RlZCcsIGRldGFpbDogJ3dlbGNvbWUgd2l0aG91dCBhIHZlcmlmaWVkIHBhaXJpbmcnIH0pO1xuICAgICAgdGhpcy5zb2NrZXQ/LmNsb3NlKDEwMDgsICd1bmV4cGVjdGVkIHdlbGNvbWUnKTtcbiAgICAgIHJldHVybjtcbiAgICB9XG4gICAgdGhpcy5yZWdpc3RlcigpO1xuICB9XG5cbiAgcHJpdmF0ZSBvblBhaXJSZXF1aXJlZChmOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIGlmICh0eXBlb2YgZi5odWJJZCAhPT0gJ3N0cmluZycgfHwgdHlwZW9mIGYucGFpcklkICE9PSAnc3RyaW5nJykgcmV0dXJuO1xuICAgIHRoaXMuaHViSWQgPSBmLmh1YklkO1xuICAgIGNvbnN0IGNvZGUgPSBTdHJpbmcocmFuZG9tSW50KDAsIDFfMDAwXzAwMCkpLnBhZFN0YXJ0KDYsICcwJyk7XG4gICAgdGhpcy5wYWlyaW5nID0geyBwYWlySWQ6IGYucGFpcklkLCBjb2RlLCBleHBpcmVzQXQ6IHRoaXMubm93KCkgKyBQQUlSX1RUTF9NUyB9O1xuICAgIGNvbnN0IGNvZGVIYXNoID0gYjY0dXJsKGNyZWF0ZUhhc2goJ3NoYTI1NicpLnVwZGF0ZShgJHtmLmh1YklkfToke2YucGFpcklkfToke2NvZGV9YCkuZGlnZXN0KCkpO1xuICAgIHRoaXMuc2VuZCh7IHR5cGU6ICdwYWlyX29mZmVyJywgcGFpcklkOiBmLnBhaXJJZCwgY29kZUhhc2ggfSk7XG4gICAgdGhpcy5zdGF0dXMoeyBzdGF0ZTogJ3BhaXJpbmcnLCBjb2RlLCBleHBpcmVzQXQ6IHRoaXMucGFpcmluZy5leHBpcmVzQXQgfSk7XG4gIH1cblxuICAvKiogVGhlIGNvZGUgc2hvd24gaW4gdGhlIHBhbmVsLCB3aGlsZSBpdCBpcyB2YWxpZC4gKi9cbiAgZ2V0IHBhaXJpbmdDb2RlKCk6IHN0cmluZyB8IG51bGwge1xuICAgIGlmICghdGhpcy5wYWlyaW5nIHx8IHRoaXMubm93KCkgPiB0aGlzLnBhaXJpbmcuZXhwaXJlc0F0KSByZXR1cm4gbnVsbDtcbiAgICByZXR1cm4gdGhpcy5wYWlyaW5nLmNvZGU7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIG9uUGFpcmVkKGY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KSB7XG4gICAgaWYgKCF0aGlzLnBhaXJpbmcgfHwgdHlwZW9mIGYudG9rZW4gIT09ICdzdHJpbmcnIHx8IGYuaHViSWQgIT09IHRoaXMuaHViSWQgfHwgIXRoaXMuaHViSWQpXG4gICAgICByZXR1cm47XG4gICAgaWYgKHRoaXMubm93KCkgPiB0aGlzLnBhaXJpbmcuZXhwaXJlc0F0KSByZXR1cm47XG4gICAgdGhpcy5rZXkgPSBrZXlPZihmLnRva2VuKTtcbiAgICB0aGlzLnBhaXJpbmcgPSBudWxsO1xuICAgIGF3YWl0IHRoaXMuZGVwcy5zdG9yZS5zZXRUb2tlbih0aGlzLmh1YklkLCBmLnRva2VuKTtcbiAgICB0aGlzLmRlcHMuc3RvcmUuc2F2ZUNvbmZpZyh7IGVuZ2luZUlkOiB0aGlzLmVuZ2luZUlkLCBodWJJZDogdGhpcy5odWJJZCB9KTtcbiAgICB0aGlzLmxvZyh7IGV2ZW50OiAncGFpcmVkJywgaHViSWQ6IHRoaXMuaHViSWQgfSk7XG4gICAgdGhpcy5yZWdpc3RlcigpO1xuICB9XG5cbiAgcHJpdmF0ZSByZWdpc3RlcigpIHtcbiAgICB0aGlzLnJlZ2lzdGVyZWQgPSB0cnVlO1xuICAgIHRoaXMuc2VuZCh7IHR5cGU6ICdyZWdpc3RlcicsIGVuZ2luZTogJ2NlcCcsIGNhcGFiaWxpdGllczogWy4uLkNBUEFCSUxJVElFU10gfSk7XG4gICAgdGhpcy5zdGF0dXMoeyBzdGF0ZTogJ3JlYWR5JywgaHViSWQ6IHRoaXMuaHViSWQhIH0pO1xuICB9XG5cbiAgLyoqIFwiUGFpciBhZ2FpblwiIC8gXCJGb3JnZXQgQUkgcGFpcmluZ1wiIGluIHRoZSBwYW5lbDogZHJvcCB0aGUgdG9rZW4gYW5kIHVzZSBhIG5ldyBlbmdpbmVJZC4gKi9cbiAgYXN5bmMgZm9yZ2V0UGFpcmluZygpIHtcbiAgICBpZiAodGhpcy5yZWdpc3RlcmVkKSB0aGlzLnNlbmQoeyB0eXBlOiAnZm9yZ2V0X3BhaXJpbmcnIH0pO1xuICAgIGNvbnN0IGNmZyA9IHRoaXMuZGVwcy5zdG9yZS5sb2FkQ29uZmlnKCk7XG4gICAgaWYgKGNmZy5odWJJZCkgYXdhaXQgdGhpcy5kZXBzLnN0b3JlLmRlbGV0ZVRva2VuKGNmZy5odWJJZCk7XG4gICAgdGhpcy5lbmdpbmVJZCA9ICdlXycgKyBiNjR1cmwocmFuZG9tQnl0ZXMoMTYpKTtcbiAgICB0aGlzLmRlcHMuc3RvcmUuc2F2ZUNvbmZpZyh7IGVuZ2luZUlkOiB0aGlzLmVuZ2luZUlkIH0pO1xuICAgIHRoaXMua2V5ID0gbnVsbDtcbiAgICB0aGlzLmh1YklkID0gbnVsbDtcbiAgICB0aGlzLnJlZ2lzdGVyZWQgPSBmYWxzZTtcbiAgICB0aGlzLnNvY2tldD8uY2xvc2UoMTAwMCwgJ2ZvcmdldCBwYWlyaW5nJyk7XG4gIH1cblxuICBwcml2YXRlIGFzeW5jIG9uUmVxdWVzdChmOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikge1xuICAgIGNvbnN0IGlkID0gdHlwZW9mIGYuaWQgPT09ICdzdHJpbmcnID8gZi5pZCA6ICcnO1xuICAgIGNvbnN0IHVuZG9OYW1lID0gdHlwZW9mIGYudW5kb05hbWUgPT09ICdzdHJpbmcnID8gZi51bmRvTmFtZSA6ICdHb2JsaW5zIEFJJztcbiAgICAvLyBTYW1lIGlkIHR3aWNlIChhIGh1YiByZXRyeSk6IGFuc3dlciB3aXRoIHRoZSBmaXJzdCByZXN1bHQsIG5ldmVyIGFwcGx5IHR3aWNlLlxuICAgIGNvbnN0IHByaW9yID0gdGhpcy5zZWVuLmdldChpZCk7XG4gICAgaWYgKHByaW9yKSByZXR1cm4gdGhpcy5zZW5kKHByaW9yIGFzIHVua25vd24gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgIGxldCByZXE6IENlcFJlcXVlc3Q7XG4gICAgdHJ5IHtcbiAgICAgIHJlcSA9IHBhcnNlUmVxdWVzdChmKTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICBjb25zdCBwZSA9IGUgaW5zdGFuY2VvZiBQcm90b2NvbEVycm9yID8gZSA6IG5ldyBQcm90b2NvbEVycm9yKCdpbnZhbGlkX2FyZ3MnLCBTdHJpbmcoZSkpO1xuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoKHJlZnVzZWRSZXN1bHQoaWQsIHVuZG9OYW1lLCBwZS5jb2RlLCBwZS5tZXNzYWdlKSwgbnVsbCk7XG4gICAgfVxuICAgIGlmICh0aGlzLmNhbmNlbGxlZC5oYXMoaWQpKVxuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoKFxuICAgICAgICByZWZ1c2VkUmVzdWx0KGlkLCB1bmRvTmFtZSwgJ2NhbmNlbGxlZCcsICdUaGUgYWdlbnQgY2FuY2VsbGVkIGJlZm9yZSBpdCBzdGFydGVkLicpLFxuICAgICAgICByZXEsXG4gICAgICApO1xuICAgIGlmICh0aGlzLmhvc3RCdXN5KVxuICAgICAgcmV0dXJuIHRoaXMuZmluaXNoKFxuICAgICAgICByZWZ1c2VkUmVzdWx0KFxuICAgICAgICAgIGlkLFxuICAgICAgICAgIHVuZG9OYW1lLFxuICAgICAgICAgICdob3N0X2J1c3knLFxuICAgICAgICAgIGBUaGUgQ0VQIGhlbHBlciBpcyBzdGlsbCB3YWl0aW5nIGZvciBcIiR7dGhpcy5ob3N0QnVzeS5vcH1cIiAocmVxdWVzdCAke3RoaXMuaG9zdEJ1c3kucmVxdWVzdElkfSkgdG8gY29tZSBiYWNrIGZyb20gUHJlbWllcmUuYCxcbiAgICAgICAgKSxcbiAgICAgICAgcmVxLFxuICAgICAgKTtcbiAgICB0aGlzLmhvc3RCdXN5ID0geyByZXF1ZXN0SWQ6IGlkLCBvcDogcmVxLnRvb2wgfTtcbiAgICB0aGlzLnN0YXR1cyh7IHN0YXRlOiAnYnVzeScsIHJlcXVlc3RJZDogaWQsIG9wOiByZXEudG9vbCB9KTtcbiAgICB0cnkge1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlKHJlcSk7XG4gICAgICB0aGlzLmZpbmlzaChyZXN1bHQsIHJlcSk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGlmICh0aGlzLmhvc3RCdXN5Py5yZXF1ZXN0SWQgPT09IGlkICYmICF0aGlzLnN0dWNrKSB0aGlzLmhvc3RCdXN5ID0gbnVsbDtcbiAgICAgIGlmICghdGhpcy5ob3N0QnVzeSAmJiB0aGlzLnJlZ2lzdGVyZWQpIHRoaXMuc3RhdHVzKHsgc3RhdGU6ICdyZWFkeScsIGh1YklkOiB0aGlzLmh1YklkISB9KTtcbiAgICB9XG4gIH1cbiAgcHJpdmF0ZSBzdHVjayA9IGZhbHNlO1xuXG4gIHByaXZhdGUgZmluaXNoKHI6IFJlc3VsdEZyYW1lLCByZXE6IENlcFJlcXVlc3QgfCBudWxsKSB7XG4gICAgaWYgKHIuaWQpIHtcbiAgICAgIHRoaXMuc2Vlbi5zZXQoci5pZCwgcik7XG4gICAgICBpZiAodGhpcy5zZWVuLnNpemUgPiA1MDApIHRoaXMuc2Vlbi5kZWxldGUodGhpcy5zZWVuLmtleXMoKS5uZXh0KCkudmFsdWUhKTtcbiAgICB9XG4gICAgdGhpcy5sb2coe1xuICAgICAgZXZlbnQ6ICdyZXN1bHQnLFxuICAgICAgcmVxdWVzdElkOiByLmlkLFxuICAgICAgdG9vbDogcmVxPy50b29sID8/IG51bGwsXG4gICAgICBzdGF0dXM6IHIuc3RhdHVzLFxuICAgICAgY29kZTogci5jb2RlLFxuICAgICAgYXBwbGllZENvdW50OiByLmFwcGxpZWQubGVuZ3RoLFxuICAgICAgdW5kb1N0ZXBzOiByLnVuZG8uc3RlcHMsXG4gICAgfSk7XG4gICAgdGhpcy5zZW5kKHIgYXMgdW5rbm93biBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik7XG4gIH1cblxuICAvKipcbiAgICogUnVuIG9uZSBFeHRlbmRTY3JpcHQgb3Agd2l0aCBhIHRpbWUgYm94LiBFeHRlbmRTY3JpcHQgY2Fubm90IGJlIGludGVycnVwdGVkOiBvbiB0aW1lb3V0IHRoZSBvcFxuICAgKiBtYXkgc3RpbGwgYmUgcnVubmluZyAoYSBkaWFsb2csIFByZW1pZXJlIGluIGFub3RoZXIgU3BhY2UpLCBzbyB0aGUgaG9zdCBzdGF5cyBtYXJrZWQgYnVzeSB1bnRpbFxuICAgKiB0aGUgbGF0ZSBhbnN3ZXIgYXJyaXZlcywgYW5kIGl0cyBzdGF0ZSBpcyByZXBvcnRlZCBhcyB1bmtub3duLlxuICAgKi9cbiAgcHJpdmF0ZSBhc3luYyBydW4oY2FsbDogT3BDYWxsLCByZXF1ZXN0SWQ6IHN0cmluZyk6IFByb21pc2U8T3BSZXN1bHQgfCAndGltZW91dCc+IHtcbiAgICBjb25zdCBwID0gdGhpcy5kZXBzLmV2YWx1YXRlKHNjcmlwdEZvcihjYWxsKSkudGhlbihwYXJzZU9wUmVzdWx0LCAoZSkgPT4gKHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGFwcGxpZWQ6IDAsXG4gICAgICBlcnJvcjogeyBjb2RlOiAnaG9zdF9lcnJvcicsIG1lc3NhZ2U6IFN0cmluZyhlPy5tZXNzYWdlID8/IGUpIH0sXG4gICAgfSkpO1xuICAgIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gICAgY29uc3QgdCA9IG5ldyBQcm9taXNlPCd0aW1lb3V0Jz4oXG4gICAgICAocmVzKSA9PiAodGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHJlcygndGltZW91dCcpLCBjYWxsLnRpbWVvdXRNcykpLFxuICAgICk7XG4gICAgY29uc3QgciA9IGF3YWl0IFByb21pc2UucmFjZShbcCwgdF0pO1xuICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgaWYgKHIgPT09ICd0aW1lb3V0Jykge1xuICAgICAgdGhpcy5zdHVjayA9IHRydWU7XG4gICAgICB0aGlzLmhvc3RCdXN5ID0geyByZXF1ZXN0SWQsIG9wOiBjYWxsLm9wIH07XG4gICAgICB2b2lkIHAudGhlbigobGF0ZSkgPT4ge1xuICAgICAgICB0aGlzLmRpYWdub3N0aWNzLmxhdGVSZXN1bHRzKys7XG4gICAgICAgIHRoaXMubG9nKHsgZXZlbnQ6ICdsYXRlX3Jlc3VsdCcsIHJlcXVlc3RJZCwgb3A6IGNhbGwub3AsIHJlc3VsdDogbGF0ZSB9KTtcbiAgICAgICAgdGhpcy5zdHVjayA9IGZhbHNlO1xuICAgICAgICB0aGlzLmhvc3RCdXN5ID0gbnVsbDtcbiAgICAgICAgaWYgKHRoaXMucmVnaXN0ZXJlZCkgdGhpcy5zdGF0dXMoeyBzdGF0ZTogJ3JlYWR5JywgaHViSWQ6IHRoaXMuaHViSWQhIH0pO1xuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiByO1xuICB9XG5cbiAgcHJpdmF0ZSBhc3luYyBleGVjdXRlKHJlcTogQ2VwUmVxdWVzdCk6IFByb21pc2U8UmVzdWx0RnJhbWU+IHtcbiAgICBjb25zdCBhcHBsaWVkOiB1bmtub3duW10gPSBbXTtcbiAgICBjb25zdCBpdGVtczogdW5rbm93bltdID0gW107XG4gICAgY29uc3Qgd2FybmluZ3M6IHN0cmluZ1tdID0gW107XG4gICAgbGV0IHN0ZXBzID0gMDtcbiAgICBjb25zdCBkb25lID0gKFxuICAgICAgc3RhdHVzOiBSZXN1bHRGcmFtZVsnc3RhdHVzJ10sXG4gICAgICBjb2RlOiBzdHJpbmcgfCBudWxsLFxuICAgICAgbWVzc2FnZTogc3RyaW5nLFxuICAgICk6IFJlc3VsdEZyYW1lID0+ICh7XG4gICAgICB0eXBlOiAncmVzdWx0JyxcbiAgICAgIGlkOiByZXEuaWQsXG4gICAgICBvazogc3RhdHVzID09PSAnYXBwbGllZCcsXG4gICAgICBzdGF0dXMsXG4gICAgICBjb2RlLFxuICAgICAgbWVzc2FnZSxcbiAgICAgIGFwcGxpZWQsXG4gICAgICByZWFkQmFjazogeyBvazogc3RhdHVzID09PSAnYXBwbGllZCcsIGl0ZW1zIH0sXG4gICAgICB1bmRvTmFtZTogcmVxLnVuZG9OYW1lLFxuICAgICAgdW5kbzogeyBncm91cGVkOiBmYWxzZSwgc3RlcHMsIG5vdGU6IFVORE9fTk9URSB9LFxuICAgICAgd2FybmluZ3MsXG4gICAgICBlbmdpbmU6ICdjZXAnLFxuICAgIH0pO1xuXG4gICAgbGV0IGluZm86IFNlcUluZm8gfCBudWxsID0gbnVsbDtcbiAgICBpZiAocmVxLnNlcXVlbmNlKSB7XG4gICAgICBjb25zdCByID0gYXdhaXQgdGhpcy5ydW4oaW5mb0NhbGwocmVxKSwgcmVxLmlkKTtcbiAgICAgIGlmIChyID09PSAndGltZW91dCcpXG4gICAgICAgIHJldHVybiBkb25lKFxuICAgICAgICAgICdmYWlsZWQnLFxuICAgICAgICAgICd0aW1lb3V0JyxcbiAgICAgICAgICAnUHJlbWllcmUgZGlkIG5vdCBhbnN3ZXIgdGhlIHJlYWQgaW4gdGltZSAoYSBkaWFsb2cgbWF5IGJlIG9wZW4sIG9yIFByZW1pZXJlIGlzIGluIGFub3RoZXIgU3BhY2UpLiBOb3RoaW5nIHdhcyBjaGFuZ2VkLicsXG4gICAgICAgICk7XG4gICAgICBpZiAoIXIub2spXG4gICAgICAgIHJldHVybiBkb25lKCdyZWZ1c2VkJywgci5lcnJvcj8uY29kZSA/PyAnaG9zdF9lcnJvcicsIHIuZXJyb3I/Lm1lc3NhZ2UgPz8gJ3JlYWQgZmFpbGVkJyk7XG4gICAgICBpbmZvID0gci5yZWFkQmFjayBhcyB1bmtub3duIGFzIFNlcUluZm87XG4gICAgfVxuICAgIGxldCBjYWxsczogT3BDYWxsW107XG4gICAgdHJ5IHtcbiAgICAgIGNhbGxzID0gcGxhbkNhbGxzKHJlcSwgaW5mbyk7XG4gICAgfSBjYXRjaCAoZSkge1xuICAgICAgY29uc3QgcGUgPSBlIGluc3RhbmNlb2YgUHJvdG9jb2xFcnJvciA/IGUgOiBuZXcgUHJvdG9jb2xFcnJvcignaG9zdF9lcnJvcicsIFN0cmluZyhlKSk7XG4gICAgICByZXR1cm4gZG9uZSgncmVmdXNlZCcsIHBlLmNvZGUsIHBlLm1lc3NhZ2UpO1xuICAgIH1cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IGNhbGxzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBjb25zdCBjYWxsID0gY2FsbHNbaV07XG4gICAgICBjb25zdCByID0gYXdhaXQgdGhpcy5ydW4oY2FsbCwgcmVxLmlkKTtcbiAgICAgIGlmIChyID09PSAndGltZW91dCcpIHtcbiAgICAgICAgaXRlbXMucHVzaCh7IGl0ZW06IGNhbGwuaXRlbSwgb2s6IGZhbHNlLCBzdGF0ZTogJ3Vua25vd24nIH0pO1xuICAgICAgICByZXR1cm4gZG9uZShcbiAgICAgICAgICAnZmFpbGVkJyxcbiAgICAgICAgICAndGltZW91dCcsXG4gICAgICAgICAgYFByZW1pZXJlIGRpZCBub3QgYW5zd2VyIFwiJHtjYWxsLm9wfVwiIG9uICR7Y2FsbC5pdGVtfSB3aXRoaW4gJHtjYWxsLnRpbWVvdXRNcyAvIDEwMDB9IHMuIEl0IG1heSBzdGlsbCBhcHBseTsgY2hlY2sgdGhlIHRpbWVsaW5lIGJlZm9yZSB1bmRvaW5nLiAke2FwcGxpZWQubGVuZ3RofSBpdGVtKHMpIHdlcmUgYXBwbGllZCBiZWZvcmUgaXQuYCxcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHN0ZXBzICs9IHIub2sgfHwgci5hcHBsaWVkID8gKHIudW5kb1N0ZXBzID8/IDApIDogMDtcbiAgICAgIGlmIChyLndhcm5pbmdzPy5sZW5ndGgpIHdhcm5pbmdzLnB1c2goLi4uci53YXJuaW5ncyk7XG4gICAgICBpdGVtcy5wdXNoKHsgaXRlbTogY2FsbC5pdGVtLCBvazogci5vaywgLi4uKHIucmVhZEJhY2sgPz8ge30pIH0pO1xuICAgICAgYXBwbGllZC5wdXNoKC4uLmFwcGxpZWRFbnRyaWVzKGNhbGwsIHIpKTtcbiAgICAgIGlmICghci5vaykge1xuICAgICAgICBjb25zdCBjb2RlID0gci5lcnJvcj8uY29kZSA/PyAnaG9zdF9lcnJvcic7XG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSByLmVycm9yPy5tZXNzYWdlID8/ICdmYWlsZWQnO1xuICAgICAgICAvLyBOb3RoaW5nIGFwcGxpZWQgeWV0IGFuZCBQcmVtaWVyZSByZWZ1c2VkIGJlZm9yZSB0b3VjaGluZyBhbnl0aGluZyBcdTIxOTIgcmVmdXNlZC5cbiAgICAgICAgaWYgKHIucmVmdXNlZCAmJiBhcHBsaWVkLmxlbmd0aCA9PT0gMCAmJiBzdGVwcyA9PT0gMCkgcmV0dXJuIGRvbmUoJ3JlZnVzZWQnLCBjb2RlLCBtZXNzYWdlKTtcbiAgICAgICAgcmV0dXJuIGRvbmUoXG4gICAgICAgICAgJ2ZhaWxlZCcsXG4gICAgICAgICAgci5yZWZ1c2VkID8gY29kZSA6IGNvZGUgPT09ICdzY3JpcHRfZXJyb3InID8gJ2hvc3RfZXJyb3InIDogY29kZSxcbiAgICAgICAgICBgJHttZXNzYWdlfSAoJHtjYWxsLml0ZW19OyAke2FwcGxpZWQubGVuZ3RofSBpdGVtKHMpIGFwcGxpZWQgYmVmb3JlIHN0b3BwaW5nKWAsXG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBkb25lKCdhcHBsaWVkJywgbnVsbCwgYCR7YXBwbGllZC5sZW5ndGh9IGl0ZW0ocykgYXBwbGllZDsgdW5kbyB0YWtlcyAke3N0ZXBzfSBzdGVwKHMpLmApO1xuICB9XG59XG5cbi8qKiBUaGUgc3RlcHMgYSBwZXJzb24gbXVzdCBwcmVzcyBDbWQrWiBmb3IsIHBlciB0b29sIFx1MjAxNCBzaG93biBvbiB0aGUgYXBwcm92YWwgY2FyZCBiZWZvcmUgQXBwbHkuICovXG5leHBvcnQgZnVuY3Rpb24gZXhwZWN0ZWRVbmRvU3RlcHModG9vbDogc3RyaW5nLCBpdGVtQ291bnQ6IG51bWJlcik6IHN0cmluZyB7XG4gIHN3aXRjaCAodG9vbCkge1xuICAgIGNhc2UgJ3Jhem9yJzpcbiAgICAgIHJldHVybiAnb25lIHVuZG8gc3RlcCBwZXIgdHJhY2sgY3V0JztcbiAgICBjYXNlICdzZXRfc3BlZWQnOlxuICAgIGNhc2UgJ3NldF9jbGlwX2dhaW4nOlxuICAgICAgcmV0dXJuIGAke2l0ZW1Db3VudH0gdW5kbyBzdGVwKHMpLCBvbmUgcGVyIGNsaXBgO1xuICAgIGNhc2UgJ2ltcG9ydF94bWxfaW50b19iaW4nOlxuICAgICAgcmV0dXJuICcxIHVuZG8gc3RlcCAodGhlIGltcG9ydCknO1xuICAgIGRlZmF1bHQ6XG4gICAgICByZXR1cm4gJ3Vua25vd24nO1xuICB9XG59XG4iLCAiLy8gVGltZSBtYXRoIGZvciB0aGUgQ0VQIGhlbHBlci4gUHJlbWllcmUgY291bnRzIHRpbWUgaW4gdGlja3MgKDI1NCwwMTYsMDAwLDAwMCBwZXIgc2Vjb25kKS4gUUUnc1xuLy8gcmF6b3IoKSB0YWtlcyBhIHRpbWVjb2RlIHN0cmluZyBpbiB0aGUgc2VxdWVuY2UncyBvd24gZGlzcGxheSBmb3JtYXQsIHNvIHRoZSBoZWxwZXIgdHVybnMgYVxuLy8gZnJhbWUtc25hcHBlZCB0aWNrIHRpbWUgaW50byB0aGF0IHN0cmluZyBoZXJlICh0ZXN0ZWQgaW4gTm9kZSkgYW5kIHRoZSBFeHRlbmRTY3JpcHQgc2lkZSBjaGVja3Ncbi8vIGl0IGFnYWluc3QgUHJlbWllcmUncyBvd24gVGltZS5nZXRGb3JtYXR0ZWQoKSBiZWZvcmUgY3V0dGluZy5cblxuZXhwb3J0IGNvbnN0IFRJQ0tTX1BFUl9TRUNPTkQgPSAyNTQwMTYwMDAwMDBuO1xuXG4vKiogUHJlbWllcmUncyBFeHRlbmRTY3JpcHQgYHZpZGVvRGlzcGxheUZvcm1hdGAgY29kZXMgKFRpbWVEaXNwbGF5IGVudW0pLiAqL1xuZXhwb3J0IGNvbnN0IERJU1BMQVlfRk9STUFUUzogUmVjb3JkPG51bWJlciwgeyBmcHM6IG51bWJlcjsgZHJvcEZyYW1lOiBib29sZWFuIH0gfCAnZnJhbWVzJz4gPSB7XG4gIDEwMDogeyBmcHM6IDI0LCBkcm9wRnJhbWU6IGZhbHNlIH0sXG4gIDEwMTogeyBmcHM6IDI1LCBkcm9wRnJhbWU6IGZhbHNlIH0sXG4gIDEwMjogeyBmcHM6IDMwLCBkcm9wRnJhbWU6IHRydWUgfSwgLy8gMjkuOTcgZHJvcC1mcmFtZVxuICAxMDM6IHsgZnBzOiAzMCwgZHJvcEZyYW1lOiBmYWxzZSB9LCAvLyAyOS45NyBub24tZHJvcFxuICAxMDQ6IHsgZnBzOiAzMCwgZHJvcEZyYW1lOiBmYWxzZSB9LFxuICAxMDU6IHsgZnBzOiA1MCwgZHJvcEZyYW1lOiBmYWxzZSB9LFxuICAxMDY6IHsgZnBzOiA2MCwgZHJvcEZyYW1lOiB0cnVlIH0sIC8vIDU5Ljk0IGRyb3AtZnJhbWVcbiAgMTA3OiB7IGZwczogNjAsIGRyb3BGcmFtZTogZmFsc2UgfSwgLy8gNTkuOTQgbm9uLWRyb3BcbiAgMTA4OiB7IGZwczogNjAsIGRyb3BGcmFtZTogZmFsc2UgfSxcbiAgMTA5OiAnZnJhbWVzJyxcbiAgMTEwOiB7IGZwczogMjQsIGRyb3BGcmFtZTogZmFsc2UgfSwgLy8gMjMuOTc2XG4gIDExMzogeyBmcHM6IDQ4LCBkcm9wRnJhbWU6IGZhbHNlIH0sXG59O1xuXG5leHBvcnQgY2xhc3MgVGltZUVycm9yIGV4dGVuZHMgRXJyb3Ige1xuICBjb25zdHJ1Y3RvcihcbiAgICBwdWJsaWMgY29kZTogc3RyaW5nLFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgKSB7XG4gICAgc3VwZXIobWVzc2FnZSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gdG9UaWNrcyh2OiBzdHJpbmcgfCBudW1iZXIgfCBiaWdpbnQsIHdoYXQ6IHN0cmluZyk6IGJpZ2ludCB7XG4gIGNvbnN0IHMgPSBTdHJpbmcodik7XG4gIGlmICghL15cXGQrJC8udGVzdChzKSkgdGhyb3cgbmV3IFRpbWVFcnJvcignYmFkX3RpbWUnLCBgJHt3aGF0fSBtdXN0IGJlIGEgd2hvbGUgbnVtYmVyIG9mIHRpY2tzYCk7XG4gIHJldHVybiBCaWdJbnQocyk7XG59XG5cbi8qKlxuICogU25hcCBhIHRpY2sgdGltZSB0byB0aGUgbmVhcmVzdCBmcmFtZSBvZiB0aGUgc2VxdWVuY2UuIGB0aWNrc1BlckZyYW1lYCBpcyB0aGUgc2VxdWVuY2Unc1xuICogYHRpbWViYXNlYCAoYSBzdHJpbmcgaW4gRXh0ZW5kU2NyaXB0KS4gUmV0dXJucyB0aGUgZnJhbWUgbnVtYmVyIGFuZCBpdHMgZXhhY3QgdGljayB0aW1lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc25hcFRvRnJhbWUoXG4gIHRpY2tzOiBzdHJpbmcgfCBudW1iZXIgfCBiaWdpbnQsXG4gIHRpY2tzUGVyRnJhbWU6IHN0cmluZyB8IG51bWJlciB8IGJpZ2ludCxcbik6IHsgZnJhbWU6IG51bWJlcjsgdGlja3M6IHN0cmluZzsgc25hcHBlZEJ5OiBzdHJpbmcgfSB7XG4gIGNvbnN0IHQgPSB0b1RpY2tzKHRpY2tzLCAndGltZScpO1xuICBjb25zdCB0cGYgPSB0b1RpY2tzKHRpY2tzUGVyRnJhbWUsICd0aW1lYmFzZScpO1xuICBpZiAodHBmIDw9IDBuKSB0aHJvdyBuZXcgVGltZUVycm9yKCdiYWRfdGltZScsICd0aW1lYmFzZSBtdXN0IGJlIHBvc2l0aXZlJyk7XG4gIGNvbnN0IGZyYW1lID0gKHQgKyB0cGYgLyAybikgLyB0cGY7XG4gIGNvbnN0IHNuYXBwZWQgPSBmcmFtZSAqIHRwZjtcbiAgaWYgKGZyYW1lID4gQmlnSW50KE51bWJlci5NQVhfU0FGRV9JTlRFR0VSKSkgdGhyb3cgbmV3IFRpbWVFcnJvcignYmFkX3RpbWUnLCAndGltZSBvdXQgb2YgcmFuZ2UnKTtcbiAgcmV0dXJuIHsgZnJhbWU6IE51bWJlcihmcmFtZSksIHRpY2tzOiBzbmFwcGVkLnRvU3RyaW5nKCksIHNuYXBwZWRCeTogKHNuYXBwZWQgLSB0KS50b1N0cmluZygpIH07XG59XG5cbmNvbnN0IHBhZCA9IChuOiBudW1iZXIpID0+IFN0cmluZyhuKS5wYWRTdGFydCgyLCAnMCcpO1xuXG4vKipcbiAqIEZyYW1lIG51bWJlciBcdTIxOTIgdGltZWNvZGUgbGFiZWwuIERyb3AtZnJhbWUgKDI5Ljk3LzU5Ljk0KSBza2lwcyBsYWJlbHMgMDAgYW5kIDAxIChcdTAwRDcyIGF0IDU5Ljk0KVxuICogYXQgdGhlIHN0YXJ0IG9mIGV2ZXJ5IG1pbnV0ZSBleGNlcHQgZWFjaCB0ZW50aCBtaW51dGUsIGFuZCB1c2VzICc7JyBhcyBQcmVtaWVyZSBzaG93cyBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZyYW1lc1RvVGltZWNvZGUoZnJhbWU6IG51bWJlciwgZnBzOiBudW1iZXIsIGRyb3BGcmFtZTogYm9vbGVhbik6IHN0cmluZyB7XG4gIGlmICghTnVtYmVyLmlzSW50ZWdlcihmcmFtZSkgfHwgZnJhbWUgPCAwKSB0aHJvdyBuZXcgVGltZUVycm9yKCdiYWRfdGltZScsICdmcmFtZSBtdXN0IGJlID49IDAnKTtcbiAgbGV0IGYgPSBmcmFtZTtcbiAgaWYgKGRyb3BGcmFtZSkge1xuICAgIGlmIChmcHMgIT09IDMwICYmIGZwcyAhPT0gNjApIHRocm93IG5ldyBUaW1lRXJyb3IoJ2JhZF90aW1lJywgJ2Ryb3AtZnJhbWUgbmVlZHMgMzAgb3IgNjAgZnBzJyk7XG4gICAgY29uc3QgZHJvcCA9IGZwcyA9PT0gMzAgPyAyIDogNDtcbiAgICBjb25zdCBwZXIxMCA9IGZwcyAqIDYwMCAtIGRyb3AgKiA5OyAvLyBmcmFtZXMgaW4gMTAgcmVhbCBtaW51dGVzXG4gICAgY29uc3QgcGVyMSA9IGZwcyAqIDYwIC0gZHJvcDsgLy8gZnJhbWVzIGluIGEgZHJvcHBlZCBtaW51dGVcbiAgICBjb25zdCBkID0gTWF0aC5mbG9vcihmIC8gcGVyMTApO1xuICAgIGNvbnN0IG0gPSBmICUgcGVyMTA7XG4gICAgZiArPSBkcm9wICogOSAqIGQgKyAobSA+IGRyb3AgPyBkcm9wICogTWF0aC5mbG9vcigobSAtIGRyb3ApIC8gcGVyMSkgOiAwKTtcbiAgfVxuICBjb25zdCBmZiA9IGYgJSBmcHM7XG4gIGNvbnN0IHRvdGFsU2VjID0gTWF0aC5mbG9vcihmIC8gZnBzKTtcbiAgY29uc3Qgc2VwID0gZHJvcEZyYW1lID8gJzsnIDogJzonO1xuICByZXR1cm4gKFxuICAgIHBhZChNYXRoLmZsb29yKHRvdGFsU2VjIC8gMzYwMCkpICtcbiAgICBzZXAgK1xuICAgIHBhZChNYXRoLmZsb29yKHRvdGFsU2VjIC8gNjApICUgNjApICtcbiAgICBzZXAgK1xuICAgIHBhZCh0b3RhbFNlYyAlIDYwKSArXG4gICAgc2VwICtcbiAgICBwYWQoZmYpXG4gICk7XG59XG5cbi8qKiBUaGUgc3RyaW5nIFFFIHJhem9yKCkgZXhwZWN0cyBmb3IgdGhpcyBmcmFtZSBpbiB0aGlzIGRpc3BsYXkgZm9ybWF0LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHRpbWVjb2RlRm9yRGlzcGxheShmcmFtZTogbnVtYmVyLCBkaXNwbGF5Rm9ybWF0OiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBmbXQgPSBESVNQTEFZX0ZPUk1BVFNbZGlzcGxheUZvcm1hdF07XG4gIGlmICghZm10KVxuICAgIHRocm93IG5ldyBUaW1lRXJyb3IoXG4gICAgICAndW5zdXBwb3J0ZWRfZGlzcGxheV9mb3JtYXQnLFxuICAgICAgYHNlcXVlbmNlIGRpc3BsYXkgZm9ybWF0ICR7ZGlzcGxheUZvcm1hdH0gaXMgbm90IGEgdGltZWNvZGUgb3IgZnJhbWUgZm9ybWF0IHRoZSBoZWxwZXIga25vd3NgLFxuICAgICk7XG4gIGlmIChmbXQgPT09ICdmcmFtZXMnKSByZXR1cm4gU3RyaW5nKGZyYW1lKTtcbiAgcmV0dXJuIGZyYW1lc1RvVGltZWNvZGUoZnJhbWUsIGZtdC5mcHMsIGZtdC5kcm9wRnJhbWUpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gc2Vjb25kc1RvVGlja3Moc2Vjb25kczogbnVtYmVyKTogc3RyaW5nIHtcbiAgaWYgKCFOdW1iZXIuaXNGaW5pdGUoc2Vjb25kcykgfHwgc2Vjb25kcyA8IDApXG4gICAgdGhyb3cgbmV3IFRpbWVFcnJvcignYmFkX3RpbWUnLCAnc2Vjb25kcyBtdXN0IGJlID49IDAnKTtcbiAgLy8gTWlsbGlzZWNvbmQtbGV2ZWwgaW5wdXQ7IGV4YWN0IGVub3VnaCBiZWZvcmUgZnJhbWUgc25hcHBpbmcuXG4gIHJldHVybiAoKEJpZ0ludChNYXRoLnJvdW5kKHNlY29uZHMgKiAxZTYpKSAqIFRJQ0tTX1BFUl9TRUNPTkQpIC8gMTAwMDAwMG4pLnRvU3RyaW5nKCk7XG59XG4iLCAiLy8gTG9jYWwgZmlsZSBwYXRocyBvbiBtYWNPUyBhbmQgV2luZG93cywgc2hhcmVkIGJ5IHRoZSBVWFAgcGFuZWwsIHRoZSBsb2NhbCBNQ1AgYW5kIHRoZSBDRVBcbi8vIGhlbHBlci4gUGxhaW4gc3RyaW5nIGZ1bmN0aW9ucyAobm8gbm9kZTpwYXRoKSBzbyB0aGUgcGFuZWwsIHdoaWNoIGhhcyBubyBOb2RlLCBjYW4gdXNlIHRoZW07XG4vLyBhIHBhdGgga2VlcHMgdGhlIHNlcGFyYXRvciBzdHlsZSBpdCBjYW1lIHdpdGggKFwiQzpcXFVzZXJzXFxcdTIwMjZcIiBzdGF5cyBiYWNrc2xhc2hlZCkuXG5cbi8qKiBBIFdpbmRvd3MgcGF0aDogZHJpdmUgbGV0dGVyIChcIkM6XFxcdTIwMjZcIiwgXCJDOi9cdTIwMjZcIikgb3IgVU5DIChcIlxcXFxzZXJ2ZXJcXHNoYXJlXFxcdTIwMjZcIikuICovXG5leHBvcnQgY29uc3QgaXNXaW5kb3dzUGF0aCA9IChwOiBzdHJpbmcpID0+IC9eW0EtWmEtel06W1xcXFwvXS8udGVzdChwKSB8fCAvXlxcXFxcXFxcW15cXFxcXS8udGVzdChwKTtcblxuLyoqIEFic29sdXRlIG9uIG1hY09TIChcIi9cdTIwMjZcIikgb3IgV2luZG93cyAoZHJpdmUgbGV0dGVyIG9yIFVOQyBcIlxcXFxzZXJ2ZXJcXHNoYXJlXCIpLiAqL1xuZXhwb3J0IGNvbnN0IEFCU09MVVRFX1BBVEggPSAvXig/OlxcL3xbQS1aYS16XTpbXFxcXC9dfFxcXFxcXFxcW15cXFxcL10rW1xcXFwvXVteXFxcXC9dKykvO1xuZXhwb3J0IGNvbnN0IGlzQWJzb2x1dGVQYXRoID0gKHA6IHN0cmluZykgPT4gQUJTT0xVVEVfUEFUSC50ZXN0KHApO1xuXG5jb25zdCBzZXBPZiA9IChwOiBzdHJpbmcpID0+XG4gIGlzV2luZG93c1BhdGgocCkgfHwgKHAuaW5jbHVkZXMoJ1xcXFwnKSAmJiAhcC5pbmNsdWRlcygnLycpKSA/ICdcXFxcJyA6ICcvJztcblxuLyoqIEpvaW5zIHdpdGggdGhlIHNlcGFyYXRvciBvZiBgYmFzZWAgKFwiQzpcXGFcIiArIFwiYi9jXCIgXHUyMTkyIFwiQzpcXGFcXGJcXGNcIjsgXCIvYVwiICsgXCJiXCIgXHUyMTkyIFwiL2EvYlwiKS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBqb2luUGF0aChiYXNlOiBzdHJpbmcsIC4uLnBhcnRzOiBzdHJpbmdbXSkge1xuICBjb25zdCBzZXAgPSBzZXBPZihiYXNlKTtcbiAgbGV0IG91dCA9IGJhc2UubGVuZ3RoID4gMSA/IGJhc2UucmVwbGFjZSgvW1xcXFwvXSskLywgJycpIDogYmFzZTtcbiAgZm9yIChjb25zdCBwYXJ0IG9mIHBhcnRzKSB7XG4gICAgY29uc3QgcCA9IHBhcnQucmVwbGFjZSgvXltcXFxcL10rfFtcXFxcL10rJC9nLCAnJykucmVwbGFjZSgvW1xcXFwvXSsvZywgc2VwKTtcbiAgICBpZiAocCkgb3V0ICs9IChvdXQuZW5kc1dpdGgoc2VwKSA/ICcnIDogc2VwKSArIHA7XG4gIH1cbiAgcmV0dXJuIG91dDtcbn1cblxuLyoqIEZvbGRlciBhbmQgZmlsZSBuYW1lLCBvbiBlaXRoZXIgc2VwYXJhdG9yLiBUaGUgZm9sZGVyIG9mIFwiQzpcXGYucG5nXCIgaXMgXCJDOlxcXCIsIG9mIFwiL2ZcIiBpcyBcIi9cIi4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzcGxpdFBhdGgocDogc3RyaW5nKTogeyBkaXI6IHN0cmluZzsgYmFzZTogc3RyaW5nIH0ge1xuICBjb25zdCBpID0gTWF0aC5tYXgocC5sYXN0SW5kZXhPZignLycpLCBwLmxhc3RJbmRleE9mKCdcXFxcJykpO1xuICBpZiAoaSA8IDApIHJldHVybiB7IGRpcjogJycsIGJhc2U6IHAgfTtcbiAgbGV0IGRpciA9IHAuc2xpY2UoMCwgaSk7XG4gIGlmICghZGlyIHx8IC9eW0EtWmEtel06JC8udGVzdChkaXIpKSBkaXIgKz0gcFtpXTtcbiAgcmV0dXJuIHsgZGlyLCBiYXNlOiBwLnNsaWNlKGkgKyAxKSB9O1xufVxuXG4vKiogVHJ1ZSB3aGVuIGFueSBzZWdtZW50IG9mIHRoZSBwYXRoIGlzIFwiLi5cIi4gKi9cbmV4cG9ydCBjb25zdCBoYXNQYXJlbnRTZWdtZW50ID0gKHA6IHN0cmluZykgPT4gcC5zcGxpdCgvW1xcXFwvXS8pLmluY2x1ZGVzKCcuLicpO1xuXG4vKipcbiAqIEdvYmxpbnMnIHBlci11c2VyIGZvbGRlciAoZGlzY292ZXJ5IGZpbGUsIHBhaXJpbmdzLCBDRVAgaGVscGVyIGNvbmZpZyBhbmQgbG9nKTpcbiAqIG1hY09TIGB+L0xpYnJhcnkvQXBwbGljYXRpb24gU3VwcG9ydC9Hb2JsaW5zYCwgV2luZG93cyBgJVVTRVJQUk9GSUxFJVxcQXBwRGF0YVxcUm9hbWluZ1xcR29ibGluc2BcbiAqICh0aGUgZGVmYXVsdCAlQVBQREFUQSU7IGJ1aWx0IGZyb20gdGhlIGhvbWUgZm9sZGVyLCBub3QgdGhlIHZhcmlhYmxlLCBiZWNhdXNlIHRoZSBVWFAgcGFuZWxcbiAqIGNhbm5vdCByZWFkIGVudmlyb25tZW50IHZhcmlhYmxlcyBhbmQgbXVzdCBmaW5kIHRoZSBzYW1lIGZpbGUgdGhlIE1DUCB3cm90ZSksIGVsc2V3aGVyZVxuICogYCRYREdfQ09ORklHX0hPTUUvZ29ibGluc2Agb3IgYH4vLmNvbmZpZy9nb2JsaW5zYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdvYmxpbnNEaXIoXG4gIHBsYXRmb3JtOiBzdHJpbmcsXG4gIGhvbWU6IHN0cmluZyxcbiAgZW52OiB7IFhER19DT05GSUdfSE9NRT86IHN0cmluZyB9ID0ge30sXG4pOiBzdHJpbmcge1xuICBpZiAocGxhdGZvcm0gPT09ICdkYXJ3aW4nKSByZXR1cm4gam9pblBhdGgoaG9tZSwgJ0xpYnJhcnknLCAnQXBwbGljYXRpb24gU3VwcG9ydCcsICdHb2JsaW5zJyk7XG4gIGlmIChwbGF0Zm9ybSA9PT0gJ3dpbjMyJykgcmV0dXJuIGpvaW5QYXRoKGhvbWUsICdBcHBEYXRhJywgJ1JvYW1pbmcnLCAnR29ibGlucycpO1xuICByZXR1cm4gam9pblBhdGgoZW52LlhER19DT05GSUdfSE9NRSB8fCBqb2luUGF0aChob21lLCAnLmNvbmZpZycpLCAnZ29ibGlucycpO1xufVxuXG4vKipcbiAqIFRoZSBNQ1AncyBkaXNjb3ZlcnkgZmlsZS4gVGhlIE1DUCB3cml0ZXMgaXQgaGVyZSBhbmQgdGhlIHBhbmVsIGFuZCB0aGUgQ0VQIGhlbHBlciByZWFkIGl0IGhlcmU7XG4gKiB0aGUgcGFuZWwgcGFzc2VzIHV4cCdzIG9zLnBsYXRmb3JtKCkgKGVtcHR5IGlmIHVua25vd246IGEgXCJDOlxcXCIgaG9tZSBtZWFucyBXaW5kb3dzKS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIG1jcERpc2NvdmVyeUZpbGUoXG4gIHBsYXRmb3JtOiBzdHJpbmcsXG4gIGhvbWU6IHN0cmluZyxcbiAgZW52OiB7IFhER19DT05GSUdfSE9NRT86IHN0cmluZyB9ID0ge30sXG4pIHtcbiAgY29uc3Qgb3MgPSBwbGF0Zm9ybSB8fCAoL15bQS1aYS16XTpbXFxcXC9dLy50ZXN0KGhvbWUpID8gJ3dpbjMyJyA6ICdkYXJ3aW4nKTtcbiAgcmV0dXJuIGpvaW5QYXRoKGdvYmxpbnNEaXIob3MsIGhvbWUsIGVudiksICdwcmVtaWVyZS1tY3AuanNvbicpO1xufVxuXG4vKipcbiAqIFVSTHMgVVhQJ3MgbG9jYWxGaWxlU3lzdGVtLmdldEVudHJ5V2l0aFVybCgpIG1heSBhY2NlcHQgZm9yIGFuIGFic29sdXRlIHBhdGgsIG1vc3QgbGlrZWx5XG4gKiBmaXJzdDogXCJmaWxlOi9Vc2Vycy94L2EgYlwiLCBcImZpbGU6Ly8vVXNlcnMveC9hJTIwYlwiOyBvbiBXaW5kb3dzIHRoZSBkcml2ZSBwYXRoIGJlY29tZXNcbiAqIFwiZmlsZTovQzovVXNlcnMveC9cdTIwMjZcIiBhbmQgXCJmaWxlOi8vL0M6L1VzZXJzL3gvXHUyMDI2XCIsIGEgVU5DIHBhdGggXCJmaWxlOi8vc2VydmVyL3NoYXJlL1x1MjAyNlwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZmlsZVVybHMocGF0aDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBpZiAoL15cXFxcXFxcXFteXFxcXF0vLnRlc3QocGF0aCkpIHtcbiAgICBjb25zdCByZXN0ID0gcGF0aC5zbGljZSgyKS5yZXBsYWNlKC9cXFxcL2csICcvJyk7XG4gICAgcmV0dXJuIFsnZmlsZTovLycgKyByZXN0LCAnZmlsZTovLycgKyBlbmNvZGVVUkkocmVzdCldLmZpbHRlcigodSwgaSwgYSkgPT4gYS5pbmRleE9mKHUpID09PSBpKTtcbiAgfVxuICBpZiAoL15bQS1aYS16XTpbXFxcXC9dLy50ZXN0KHBhdGgpKSB7XG4gICAgY29uc3QgcCA9ICcvJyArIHBhdGgucmVwbGFjZSgvXFxcXC9nLCAnLycpO1xuICAgIHJldHVybiBbJ2ZpbGU6JyArIHAsICdmaWxlOi8vJyArIGVuY29kZVVSSShwKSwgJ2ZpbGU6JyArIHBhdGhdO1xuICB9XG4gIHJldHVybiBbJ2ZpbGU6JyArIHBhdGgsICdmaWxlOi8vJyArIGVuY29kZVVSSShwYXRoKV07XG59XG4iLCAiLy8gVGhlIENFUCBlbmdpbmUncyBzaWRlIG9mIHRoZSBBSS1lZGl0IHByb3RvY29sIHYxIChkb2NzL2FpLWVkaXRpbmcubWQgXHUwMEE3MywgXHUwMEE3NCwgXHUwMEE3Ni43KS4gUHVyZVxuLy8gZnVuY3Rpb25zIG9ubHk6IHZhbGlkYXRpbmcgaHViIGZyYW1lcywgdHVybmluZyBhIHRvb2wncyBhcmdzIGludG8gRXh0ZW5kU2NyaXB0IG9wIGNhbGxzLCBhbmRcbi8vIGJ1aWxkaW5nIGByZXN1bHRgIGZyYW1lcy4gTm8gYXBwcm92YWwgbG9naWMgbGl2ZXMgaGVyZSBcdTIwMTQgdGhlIENFUCBlbmdpbmUgcnVucyBhIHJlcXVlc3Qgb25seVxuLy8gd2hlbiB0aGUgaHViIGZvcndhcmRzIGl0IHdpdGggYGFwcHJvdmVkQnk6IFwidXhwXCJgICh0aGUgcGVyc29uIGRlY2lkZWQgaW4gdGhlIFVYUCBwYW5lbCkuXG5pbXBvcnQgeyBzbmFwVG9GcmFtZSwgdGltZWNvZGVGb3JEaXNwbGF5LCBUaW1lRXJyb3IgfSBmcm9tICcuL3RpbWVjb2RlLmpzJztcbmltcG9ydCB7IGhhc1BhcmVudFNlZ21lbnQsIGlzQWJzb2x1dGVQYXRoIH0gZnJvbSAnLi4vLi4vLi4vcGFja2FnZXMvY29yZS9zcmMvbG9jYWwtcGF0aHMuanMnO1xuXG5leHBvcnQgY29uc3QgUFJPVE9DT0wgPSAxO1xuZXhwb3J0IGNvbnN0IEhFTFBFUl9OQU1FID0gJ0dvYmxpbnMgQ0VQIEhlbHBlcic7XG5leHBvcnQgY29uc3QgSEVMUEVSX1ZFUlNJT04gPSAnMC4xLjAnO1xuXG4vKiogVG9vbCBuYW1lcyB0aGUgQ0VQIGVuZ2luZSByZWdpc3RlcnMgKFx1MDBBNzQuNCwgXHUwMEE3NSkuICovXG5leHBvcnQgY29uc3QgQ0FQQUJJTElUSUVTID0gWydyYXpvcicsICdzZXRfc3BlZWQnLCAnc2V0X2NsaXBfZ2FpbicsICdpbXBvcnRfeG1sX2ludG9fYmluJ10gYXMgY29uc3Q7XG5leHBvcnQgdHlwZSBDZXBUb29sID0gKHR5cGVvZiBDQVBBQklMSVRJRVMpW251bWJlcl07XG5cbmV4cG9ydCBjb25zdCBNQVhfSVRFTVMgPSAyMDA7IC8vIFx1MDBBNzYuNCBjYXAgcGVyIHJlcXVlc3RcblxuZXhwb3J0IHR5cGUgVHJhY2tUeXBlID0gJ3ZpZGVvJyB8ICdhdWRpbyc7XG5leHBvcnQgaW50ZXJmYWNlIFRyYWNrQWRkciB7XG4gIHRyYWNrVHlwZTogVHJhY2tUeXBlO1xuICB0cmFja0luZGV4OiBudW1iZXI7XG59XG5leHBvcnQgaW50ZXJmYWNlIENsaXBBZGRyIGV4dGVuZHMgVHJhY2tBZGRyIHtcbiAgY2xpcFN0YXJ0OiBzdHJpbmc7XG4gIG5hbWU/OiBzdHJpbmc7XG4gIGxhYmVsOiBzdHJpbmc7IC8vIFwiVjFAdGlja3NcIiBmb3IgbWVzc2FnZXMgYW5kIGBhcHBsaWVkYFxufVxuXG5leHBvcnQgY2xhc3MgUHJvdG9jb2xFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgY29uc3RydWN0b3IoXG4gICAgcHVibGljIGNvZGU6IHN0cmluZyxcbiAgICBtZXNzYWdlOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5jb25zdCBiYWQgPSAobWVzc2FnZTogc3RyaW5nKTogbmV2ZXIgPT4ge1xuICB0aHJvdyBuZXcgUHJvdG9jb2xFcnJvcignaW52YWxpZF9hcmdzJywgbWVzc2FnZSk7XG59O1xuXG5jb25zdCBUSUNLUyA9IC9eXFxkezEsMjB9JC87XG4vLyBcdTAwQTc2LjU6IGFueXRoaW5nIHRoYXQgbG9va3MgbGlrZSBhbiBhcHByb3ZhbCBkZWNpc2lvbiBpcyByZWZ1c2VkIG91dHJpZ2h0LlxuY29uc3QgQVBQUk9WQUxfV09SRFMgPSAvYXBwcm92fGF1dG9fP2FwcGx5fGF1dG9hcHBseXxzY29wZXxkZWNpc2lvbnxieXBhc3MvaTtcblxuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlVHJhY2soczogdW5rbm93bik6IFRyYWNrQWRkciB7XG4gIGlmICh0eXBlb2YgcyAhPT0gJ3N0cmluZycpIHJldHVybiBiYWQoJ3RyYWNrIG11c3QgYmUgYSBzdHJpbmcgbGlrZSBcIlYxXCIgb3IgXCJBMlwiJyk7XG4gIGNvbnN0IG0gPSAvXihbVkFdKShbMS05XVxcZHswLDJ9KSQvLmV4ZWMocyk7XG4gIGlmICghbSkgcmV0dXJuIGJhZChgYmFkIHRyYWNrIFwiJHtzfVwiICh1c2UgVjFcdTIwMjYsIEExXHUyMDI2KWApO1xuICByZXR1cm4geyB0cmFja1R5cGU6IG1bMV0gPT09ICdWJyA/ICd2aWRlbycgOiAnYXVkaW8nLCB0cmFja0luZGV4OiBOdW1iZXIobVsyXSkgLSAxIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiB0cmFja0xhYmVsKHQ6IFRyYWNrQWRkcik6IHN0cmluZyB7XG4gIHJldHVybiAodC50cmFja1R5cGUgPT09ICd2aWRlbycgPyAnVicgOiAnQScpICsgKHQudHJhY2tJbmRleCArIDEpO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDbGlwUmVmKHJlZjogdW5rbm93bik6IENsaXBBZGRyIHtcbiAgaWYgKHR5cGVvZiByZWYgPT09ICdzdHJpbmcnKSB7XG4gICAgY29uc3QgbSA9IC9eKFtWQV1cXGQrKUAoXFxkKykkLy5leGVjKHJlZik7XG4gICAgaWYgKCFtKSByZXR1cm4gYmFkKGBiYWQgY2xpcEtleSBcIiR7cmVmfVwiYCk7XG4gICAgcmV0dXJuIHBhcnNlQ2xpcFJlZih7IHRyYWNrOiBtWzFdLCBzdGFydFRpY2tzOiBtWzJdIH0pO1xuICB9XG4gIGlmICghcmVmIHx8IHR5cGVvZiByZWYgIT09ICdvYmplY3QnIHx8IEFycmF5LmlzQXJyYXkocmVmKSkgcmV0dXJuIGJhZCgnY2xpcCBtdXN0IGJlIGFuIG9iamVjdCcpO1xuICBjb25zdCByID0gcmVmIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBzdHJpY3RLZXlzKHIsIFsndHJhY2snLCAnc3RhcnRUaWNrcycsICduYW1lJywgJ2NsaXBLZXknXSwgJ2NsaXAnKTtcbiAgaWYgKHIuY2xpcEtleSAhPT0gdW5kZWZpbmVkKSByZXR1cm4gcGFyc2VDbGlwUmVmKHIuY2xpcEtleSk7XG4gIGNvbnN0IHQgPSBwYXJzZVRyYWNrKHIudHJhY2spO1xuICBpZiAodHlwZW9mIHIuc3RhcnRUaWNrcyAhPT0gJ3N0cmluZycgfHwgIVRJQ0tTLnRlc3Qoci5zdGFydFRpY2tzKSlcbiAgICByZXR1cm4gYmFkKCdjbGlwLnN0YXJ0VGlja3MgbXVzdCBiZSB0aWNrcyBhcyBhIGRlY2ltYWwgc3RyaW5nJyk7XG4gIGlmIChyLm5hbWUgIT09IHVuZGVmaW5lZCAmJiAodHlwZW9mIHIubmFtZSAhPT0gJ3N0cmluZycgfHwgci5uYW1lLmxlbmd0aCA+IDUwMCkpXG4gICAgcmV0dXJuIGJhZCgnY2xpcC5uYW1lIG11c3QgYmUgYSBzdHJpbmcnKTtcbiAgcmV0dXJuIHtcbiAgICAuLi50LFxuICAgIGNsaXBTdGFydDogci5zdGFydFRpY2tzLnJlcGxhY2UoL14wKyg/PVxcZCkvLCAnJyksXG4gICAgbmFtZTogci5uYW1lIGFzIHN0cmluZyB8IHVuZGVmaW5lZCxcbiAgICBsYWJlbDogYCR7dHJhY2tMYWJlbCh0KX1AJHtyLnN0YXJ0VGlja3N9YCxcbiAgfTtcbn1cblxuZnVuY3Rpb24gc3RyaWN0S2V5cyhvOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiwgYWxsb3dlZDogc3RyaW5nW10sIHdoZXJlOiBzdHJpbmcpIHtcbiAgZm9yIChjb25zdCBrIG9mIE9iamVjdC5rZXlzKG8pKSB7XG4gICAgaWYgKEFQUFJPVkFMX1dPUkRTLnRlc3QoaykpXG4gICAgICBiYWQoYCR7d2hlcmV9OiBcIiR7a31cIiBpcyBub3QgYWNjZXB0ZWQgKGFwcHJvdmFsIG5ldmVyIGNvbWVzIGZyb20gdGhlIHJlcXVlc3QpYCk7XG4gICAgaWYgKCFhbGxvd2VkLmluY2x1ZGVzKGspKSBiYWQoYCR7d2hlcmV9OiB1bmtub3duIGtleSBcIiR7a31cImApO1xuICB9XG59XG5cbmZ1bmN0aW9uIGNsaXBMaXN0KHY6IHVua25vd24pOiBDbGlwQWRkcltdIHtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHYpIHx8IHYubGVuZ3RoID09PSAwKSByZXR1cm4gYmFkKCdjbGlwcyBtdXN0IGJlIGEgbm9uLWVtcHR5IGFycmF5Jyk7XG4gIGlmICh2Lmxlbmd0aCA+IE1BWF9JVEVNUykgcmV0dXJuIGJhZChgYXQgbW9zdCAke01BWF9JVEVNU30gY2xpcHMgcGVyIHJlcXVlc3RgKTtcbiAgY29uc3QgY2xpcHMgPSB2Lm1hcChwYXJzZUNsaXBSZWYpO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgYyBvZiBjbGlwcykge1xuICAgIGlmIChzZWVuLmhhcyhjLmxhYmVsKSkgYmFkKGBjbGlwICR7Yy5sYWJlbH0gaXMgbGlzdGVkIHR3aWNlYCk7XG4gICAgc2Vlbi5hZGQoYy5sYWJlbCk7XG4gIH1cbiAgcmV0dXJuIGNsaXBzO1xufVxuXG5leHBvcnQgdHlwZSBUb29sQXJncyA9XG4gIHwgeyB0b29sOiAncmF6b3InOyB0aWNrczogc3RyaW5nOyB0cmFja3M6IFRyYWNrQWRkcltdIHwgJ2FsbCcgfVxuICB8IHsgdG9vbDogJ3NldF9zcGVlZCc7IGNsaXBzOiBDbGlwQWRkcltdOyBwZXJjZW50OiBudW1iZXI7IHJldmVyc2U6IGJvb2xlYW47IHJpcHBsZTogYm9vbGVhbiB9XG4gIHwgeyB0b29sOiAnc2V0X2NsaXBfZ2Fpbic7IGNsaXBzOiBDbGlwQWRkcltdOyBnYWluRGI6IG51bWJlciB9XG4gIHwgeyB0b29sOiAnaW1wb3J0X3htbF9pbnRvX2Jpbic7IHhtbFBhdGg6IHN0cmluZzsgYmluUGF0aDogc3RyaW5nW10gfTtcblxuY29uc3QgQ09NTU9OID0gWydyZWFzb24nLCAnZXhwZWN0ZWRSZXZpc2lvbicsICd3YWl0U2Vjb25kcyddO1xuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VBcmdzKHRvb2w6IENlcFRvb2wsIGFyZ3M6IHVua25vd24pOiBUb29sQXJncyB7XG4gIGlmICghYXJncyB8fCB0eXBlb2YgYXJncyAhPT0gJ29iamVjdCcgfHwgQXJyYXkuaXNBcnJheShhcmdzKSlcbiAgICByZXR1cm4gYmFkKCdhcmdzIG11c3QgYmUgYW4gb2JqZWN0Jyk7XG4gIGNvbnN0IGEgPSBhcmdzIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBzd2l0Y2ggKHRvb2wpIHtcbiAgICBjYXNlICdyYXpvcic6IHtcbiAgICAgIHN0cmljdEtleXMoYSwgWyd0aWNrcycsICd0cmFja3MnLCAuLi5DT01NT05dLCAncmF6b3InKTtcbiAgICAgIGlmICh0eXBlb2YgYS50aWNrcyAhPT0gJ3N0cmluZycgfHwgIVRJQ0tTLnRlc3QoYS50aWNrcykpXG4gICAgICAgIHJldHVybiBiYWQoJ3RpY2tzIG11c3QgYmUgYSBkZWNpbWFsIHN0cmluZycpO1xuICAgICAgbGV0IHRyYWNrczogVHJhY2tBZGRyW10gfCAnYWxsJyA9ICdhbGwnO1xuICAgICAgaWYgKGEudHJhY2tzICE9PSB1bmRlZmluZWQgJiYgYS50cmFja3MgIT09ICdhbGwnKSB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShhLnRyYWNrcykgfHwgYS50cmFja3MubGVuZ3RoID09PSAwIHx8IGEudHJhY2tzLmxlbmd0aCA+IDY0KVxuICAgICAgICAgIHJldHVybiBiYWQoJ3RyYWNrcyBtdXN0IGJlIFwiYWxsXCIgb3IgYSBsaXN0IGxpa2UgW1wiVjFcIixcIkExXCJdJyk7XG4gICAgICAgIHRyYWNrcyA9IGEudHJhY2tzLm1hcChwYXJzZVRyYWNrKTtcbiAgICAgICAgY29uc3Qga2V5cyA9IG5ldyBTZXQodHJhY2tzLm1hcCh0cmFja0xhYmVsKSk7XG4gICAgICAgIGlmIChrZXlzLnNpemUgIT09IHRyYWNrcy5sZW5ndGgpIGJhZCgnYSB0cmFjayBpcyBsaXN0ZWQgdHdpY2UnKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB7IHRvb2wsIHRpY2tzOiBhLnRpY2tzLCB0cmFja3MgfTtcbiAgICB9XG4gICAgY2FzZSAnc2V0X3NwZWVkJzoge1xuICAgICAgc3RyaWN0S2V5cyhhLCBbJ2NsaXBzJywgJ3BlcmNlbnQnLCAncmV2ZXJzZScsICdyaXBwbGUnLCAuLi5DT01NT05dLCAnc2V0X3NwZWVkJyk7XG4gICAgICBjb25zdCBwID0gYS5wZXJjZW50O1xuICAgICAgaWYgKHR5cGVvZiBwICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzRmluaXRlKHApIHx8IHAgPCA1IHx8IHAgPiAyMDAwKVxuICAgICAgICByZXR1cm4gYmFkKCdwZXJjZW50IG11c3QgYmUgYSBudW1iZXIgYmV0d2VlbiA1IGFuZCAyMDAwJyk7XG4gICAgICBmb3IgKGNvbnN0IGsgb2YgWydyZXZlcnNlJywgJ3JpcHBsZSddIGFzIGNvbnN0KVxuICAgICAgICBpZiAoYVtrXSAhPT0gdW5kZWZpbmVkICYmIHR5cGVvZiBhW2tdICE9PSAnYm9vbGVhbicpIGJhZChgJHtrfSBtdXN0IGJlIHRydWUgb3IgZmFsc2VgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIHRvb2wsXG4gICAgICAgIGNsaXBzOiBjbGlwTGlzdChhLmNsaXBzKSxcbiAgICAgICAgcGVyY2VudDogcCxcbiAgICAgICAgcmV2ZXJzZTogYS5yZXZlcnNlID09PSB0cnVlLFxuICAgICAgICByaXBwbGU6IGEucmlwcGxlID09PSB0cnVlLFxuICAgICAgfTtcbiAgICB9XG4gICAgY2FzZSAnc2V0X2NsaXBfZ2Fpbic6IHtcbiAgICAgIHN0cmljdEtleXMoYSwgWydjbGlwcycsICdnYWluRGInLCAuLi5DT01NT05dLCAnc2V0X2NsaXBfZ2FpbicpO1xuICAgICAgY29uc3QgZyA9IGEuZ2FpbkRiO1xuICAgICAgaWYgKHR5cGVvZiBnICE9PSAnbnVtYmVyJyB8fCAhTnVtYmVyLmlzRmluaXRlKGcpIHx8IGcgPCAtNjAgfHwgZyA+IDE1KVxuICAgICAgICByZXR1cm4gYmFkKCdnYWluRGIgbXVzdCBiZSBhIG51bWJlciBiZXR3ZWVuIC02MCBhbmQgKzE1Jyk7XG4gICAgICBjb25zdCBjbGlwcyA9IGNsaXBMaXN0KGEuY2xpcHMpO1xuICAgICAgaWYgKGNsaXBzLnNvbWUoKGMpID0+IGMudHJhY2tUeXBlICE9PSAnYXVkaW8nKSlcbiAgICAgICAgYmFkKCdzZXRfY2xpcF9nYWluIHRha2VzIGF1ZGlvIGNsaXBzIChBIHRyYWNrcykgb25seScpO1xuICAgICAgcmV0dXJuIHsgdG9vbCwgY2xpcHMsIGdhaW5EYjogZyB9O1xuICAgIH1cbiAgICBjYXNlICdpbXBvcnRfeG1sX2ludG9fYmluJzoge1xuICAgICAgc3RyaWN0S2V5cyhhLCBbJ3htbFBhdGgnLCAnYmluUGF0aCcsIC4uLkNPTU1PTl0sICdpbXBvcnRfeG1sX2ludG9fYmluJyk7XG4gICAgICBjb25zdCB4ID0gYS54bWxQYXRoO1xuICAgICAgLy8gbWFjT1MgXCIvXHUyMDI2XCIgb3IgV2luZG93cyBcIkM6XFxcdTIwMjZcIiAvIFwiXFxcXHNlcnZlclxcc2hhcmVcXFx1MjAyNlwiIChCVUctMjAyNjExMDktMzIpLlxuICAgICAgaWYgKHR5cGVvZiB4ICE9PSAnc3RyaW5nJyB8fCAhaXNBYnNvbHV0ZVBhdGgoeCkgfHwgIS9cXC54bWwkL2kudGVzdCh4KSB8fCB4LmluY2x1ZGVzKCdcXDAnKSlcbiAgICAgICAgcmV0dXJuIGJhZCgneG1sUGF0aCBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGggdG8gYSAueG1sIGZpbGUnKTtcbiAgICAgIGlmIChoYXNQYXJlbnRTZWdtZW50KHgpKSByZXR1cm4gYmFkKCd4bWxQYXRoIG11c3Qgbm90IGNvbnRhaW4gXCIuLlwiJyk7XG4gICAgICBjb25zdCBicCA9IGEuYmluUGF0aDtcbiAgICAgIGNvbnN0IHBhcnRzID1cbiAgICAgICAgdHlwZW9mIGJwID09PSAnc3RyaW5nJ1xuICAgICAgICAgID8gYnBcbiAgICAgICAgICAgICAgLnNwbGl0KCcvJylcbiAgICAgICAgICAgICAgLm1hcCgocykgPT4gcy50cmltKCkpXG4gICAgICAgICAgICAgIC5maWx0ZXIoQm9vbGVhbilcbiAgICAgICAgICA6IEFycmF5LmlzQXJyYXkoYnApICYmIGJwLmV2ZXJ5KChzKSA9PiB0eXBlb2YgcyA9PT0gJ3N0cmluZycpXG4gICAgICAgICAgICA/IChicCBhcyBzdHJpbmdbXSlcbiAgICAgICAgICAgIDogYmFkKCdiaW5QYXRoIG11c3QgYmUgXCJCaW4vU3ViXCIgb3IgW1wiQmluXCIsXCJTdWJcIl0nKTtcbiAgICAgIGlmICghcGFydHMubGVuZ3RoIHx8IHBhcnRzLmxlbmd0aCA+IDE2IHx8IHBhcnRzLnNvbWUoKHMpID0+ICFzIHx8IHMubGVuZ3RoID4gMjU1KSlcbiAgICAgICAgYmFkKCdiaW5QYXRoIG11c3QgbmFtZSAxXHUyMDEzMTYgYmlucycpO1xuICAgICAgcmV0dXJuIHsgdG9vbCwgeG1sUGF0aDogeCwgYmluUGF0aDogcGFydHMgfTtcbiAgICB9XG4gIH1cbn1cblxuZXhwb3J0IGludGVyZmFjZSBDZXBSZXF1ZXN0IHtcbiAgaWQ6IHN0cmluZztcbiAgdG9vbDogQ2VwVG9vbDtcbiAgYXJnczogVG9vbEFyZ3M7XG4gIHByb2plY3Q6IHsgZ3VpZD86IHN0cmluZzsgcGF0aDogc3RyaW5nIH07XG4gIHNlcXVlbmNlOiB7IGlkOiBzdHJpbmc7IG5hbWU/OiBzdHJpbmcgfSB8IG51bGw7XG4gIHVuZG9OYW1lOiBzdHJpbmc7XG59XG5cbi8qKiBWYWxpZGF0ZSBhIGh1YiBgcmVxdWVzdGAgZnJhbWUgKFx1MDBBNzYuNyBzdGVwIDMpLiBUaHJvd3MgUHJvdG9jb2xFcnJvciB3aXRoIHRoZSByZWZ1c2FsIGNvZGUuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VSZXF1ZXN0KGY6IFJlY29yZDxzdHJpbmcsIHVua25vd24+KTogQ2VwUmVxdWVzdCB7XG4gIGlmICh0eXBlb2YgZi5pZCAhPT0gJ3N0cmluZycgfHwgIS9eW1xcdy46LV17MSwxMDB9JC8udGVzdChmLmlkKSlcbiAgICB0aHJvdyBuZXcgUHJvdG9jb2xFcnJvcignaW52YWxpZF9hcmdzJywgJ2JhZCBpZCcpO1xuICBpZiAoZi5hcHByb3ZlZEJ5ICE9PSAndXhwJylcbiAgICB0aHJvdyBuZXcgUHJvdG9jb2xFcnJvcihcbiAgICAgICdub3RfYXBwcm92ZWQnLFxuICAgICAgJ1RoZSBDRVAgaGVscGVyIHJ1bnMgb25seSBlZGl0cyBhcHByb3ZlZCBpbiB0aGUgR29ibGlucyBwYW5lbC4nLFxuICAgICk7XG4gIGlmICh0eXBlb2YgZi50b29sICE9PSAnc3RyaW5nJyB8fCAhKENBUEFCSUxJVElFUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXMoZi50b29sKSlcbiAgICB0aHJvdyBuZXcgUHJvdG9jb2xFcnJvcigndW5rbm93bl90b29sJywgYFRoZSBDRVAgaGVscGVyIGRvZXMgbm90IHJ1biBcIiR7U3RyaW5nKGYudG9vbCl9XCIuYCk7XG4gIGNvbnN0IHRvb2wgPSBmLnRvb2wgYXMgQ2VwVG9vbDtcbiAgY29uc3QgcCA9IGYucHJvamVjdCBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IHVuZGVmaW5lZDtcbiAgaWYgKCFwIHx8IHR5cGVvZiBwLnBhdGggIT09ICdzdHJpbmcnIHx8ICFwLnBhdGgpXG4gICAgdGhyb3cgbmV3IFByb3RvY29sRXJyb3IoJ3dyb25nX3Byb2plY3QnLCAnVGhlIHJlcXVlc3QgZG9lcyBub3QgbmFtZSB0aGUgcHJvamVjdCBwYXRoLicpO1xuICBjb25zdCBzID0gZi5zZXF1ZW5jZSBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB8IG51bGwgfCB1bmRlZmluZWQ7XG4gIGNvbnN0IG5lZWRzU2VxID0gdG9vbCAhPT0gJ2ltcG9ydF94bWxfaW50b19iaW4nO1xuICBpZiAobmVlZHNTZXEgJiYgKCFzIHx8IHR5cGVvZiBzLmlkICE9PSAnc3RyaW5nJyB8fCAhcy5pZCkpXG4gICAgdGhyb3cgbmV3IFByb3RvY29sRXJyb3IoJ3dyb25nX3NlcXVlbmNlJywgJ1RoZSByZXF1ZXN0IGRvZXMgbm90IG5hbWUgdGhlIHNlcXVlbmNlLicpO1xuICBjb25zdCB1bmRvTmFtZSA9XG4gICAgdHlwZW9mIGYudW5kb05hbWUgPT09ICdzdHJpbmcnICYmIGYudW5kb05hbWUgPyBmLnVuZG9OYW1lLnNsaWNlKDAsIDIwMCkgOiAnR29ibGlucyBBSSc7XG4gIHJldHVybiB7XG4gICAgaWQ6IGYuaWQsXG4gICAgdG9vbCxcbiAgICBhcmdzOiBwYXJzZUFyZ3ModG9vbCwgZi5hcmdzKSxcbiAgICBwcm9qZWN0OiB7IHBhdGg6IHAucGF0aCwgZ3VpZDogdHlwZW9mIHAuZ3VpZCA9PT0gJ3N0cmluZycgPyBwLmd1aWQgOiB1bmRlZmluZWQgfSxcbiAgICBzZXF1ZW5jZTpcbiAgICAgIHMgJiYgdHlwZW9mIHMuaWQgPT09ICdzdHJpbmcnXG4gICAgICAgID8geyBpZDogcy5pZCwgbmFtZTogdHlwZW9mIHMubmFtZSA9PT0gJ3N0cmluZycgPyBzLm5hbWUgOiB1bmRlZmluZWQgfVxuICAgICAgICA6IG51bGwsXG4gICAgdW5kb05hbWUsXG4gIH07XG59XG5cbi8qKiBXaGF0IGBpbmZvYCByZWFkcyBiYWNrIGFib3V0IHRoZSB0YXJnZXQgc2VxdWVuY2UuICovXG5leHBvcnQgaW50ZXJmYWNlIFNlcUluZm8ge1xuICBwcm9qZWN0UGF0aDogc3RyaW5nO1xuICBzZXF1ZW5jZUlkOiBzdHJpbmc7XG4gIHNlcXVlbmNlTmFtZTogc3RyaW5nO1xuICBpc0FjdGl2ZTogYm9vbGVhbjtcbiAgdGltZWJhc2U6IHN0cmluZztcbiAgemVyb1BvaW50OiBzdHJpbmc7XG4gIHZpZGVvRGlzcGxheUZvcm1hdDogbnVtYmVyO1xufVxuXG4vKiogT25lIEV4dGVuZFNjcmlwdCBjYWxsOiBHb2JsaW5zQ0VQLnJ1bihvcCwgaW5wdXQpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBPcENhbGwge1xuICBvcDogJ2luZm8nIHwgJ3Jhem9yJyB8ICdzcGVlZCcgfCAndm9sdW1lJyB8ICdpbXBvcnRYbWwnO1xuICBpbnB1dDogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHRpbWVvdXRNczogbnVtYmVyO1xuICBpdGVtOiBzdHJpbmc7IC8vIHdoYXQgdGhpcyBjYWxsIHRvdWNoZXMsIGZvciBgYXBwbGllZGAvbWVzc2FnZXNcbn1cblxuZXhwb3J0IGNvbnN0IFRJTUVPVVRTID0ge1xuICBpbmZvOiAxMF8wMDAsXG4gIHJhem9yOiAzMF8wMDAsXG4gIHNwZWVkOiAyMF8wMDAsXG4gIHZvbHVtZTogMTVfMDAwLFxuICBpbXBvcnRYbWw6IDE4MF8wMDAsXG59O1xuXG5mdW5jdGlvbiBiYXNlKHJlcTogQ2VwUmVxdWVzdCkge1xuICByZXR1cm4ge1xuICAgIHByb2plY3RQYXRoOiByZXEucHJvamVjdC5wYXRoLFxuICAgIHNlcXVlbmNlSWQ6IHJlcS5zZXF1ZW5jZT8uaWQsXG4gICAgc2VxdWVuY2VOYW1lOiByZXEuc2VxdWVuY2U/Lm5hbWUsXG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpbmZvQ2FsbChyZXE6IENlcFJlcXVlc3QpOiBPcENhbGwge1xuICByZXR1cm4geyBvcDogJ2luZm8nLCBpbnB1dDogYmFzZShyZXEpLCB0aW1lb3V0TXM6IFRJTUVPVVRTLmluZm8sIGl0ZW06ICdzZXF1ZW5jZScgfTtcbn1cblxuLyoqIFR1cm4gdmFsaWRhdGVkIGFyZ3MgaW50byBFeHRlbmRTY3JpcHQgY2FsbHMuIFJhem9yIG5lZWRzIHRoZSBzZXF1ZW5jZSBgaW5mb2AgZmlyc3QuICovXG5leHBvcnQgZnVuY3Rpb24gcGxhbkNhbGxzKHJlcTogQ2VwUmVxdWVzdCwgaW5mbzogU2VxSW5mbyB8IG51bGwpOiBPcENhbGxbXSB7XG4gIGNvbnN0IGEgPSByZXEuYXJncztcbiAgY29uc3QgYiA9IGJhc2UocmVxKTtcbiAgc3dpdGNoIChhLnRvb2wpIHtcbiAgICBjYXNlICdyYXpvcic6IHtcbiAgICAgIGlmICghaW5mbykgdGhyb3cgbmV3IFByb3RvY29sRXJyb3IoJ2hvc3RfZXJyb3InLCAncmF6b3IgbmVlZHMgdGhlIHNlcXVlbmNlIGluZm8gZmlyc3QnKTtcbiAgICAgIGlmIChpbmZvLnplcm9Qb2ludCAhPT0gJzAnKVxuICAgICAgICB0aHJvdyBuZXcgUHJvdG9jb2xFcnJvcihcbiAgICAgICAgICAndW5zdXBwb3J0ZWQnLFxuICAgICAgICAgICdTZXF1ZW5jZXMgd2l0aCBhIHN0YXJ0IHRpbWVjb2RlIG90aGVyIHRoYW4gMDA6MDA6MDA6MDAgYXJlIG5vdCBzdXBwb3J0ZWQgeWV0LicsXG4gICAgICAgICk7XG4gICAgICBsZXQgc25hcCwgdGltZWNvZGU7XG4gICAgICB0cnkge1xuICAgICAgICBzbmFwID0gc25hcFRvRnJhbWUoYS50aWNrcywgaW5mby50aW1lYmFzZSk7XG4gICAgICAgIHRpbWVjb2RlID0gdGltZWNvZGVGb3JEaXNwbGF5KHNuYXAuZnJhbWUsIGluZm8udmlkZW9EaXNwbGF5Rm9ybWF0KTtcbiAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgaWYgKGUgaW5zdGFuY2VvZiBUaW1lRXJyb3IpIHRocm93IG5ldyBQcm90b2NvbEVycm9yKGUuY29kZSwgZS5tZXNzYWdlKTtcbiAgICAgICAgdGhyb3cgZTtcbiAgICAgIH1cbiAgICAgIHJldHVybiBbXG4gICAgICAgIHtcbiAgICAgICAgICBvcDogJ3Jhem9yJyxcbiAgICAgICAgICBpbnB1dDogeyAuLi5iLCB0aW1lOiBzbmFwLnRpY2tzLCB0aW1lY29kZSwgdHJhY2tzOiBhLnRyYWNrcywgaW5jbHVkZUxpbmtlZDogZmFsc2UgfSxcbiAgICAgICAgICB0aW1lb3V0TXM6IFRJTUVPVVRTLnJhem9yLFxuICAgICAgICAgIGl0ZW06IGBjdXRAJHtzbmFwLnRpY2tzfSAoJHt0aW1lY29kZX0pYCxcbiAgICAgICAgfSxcbiAgICAgIF07XG4gICAgfVxuICAgIGNhc2UgJ3NldF9zcGVlZCc6XG4gICAgICByZXR1cm4gYS5jbGlwcy5tYXAoKGMpID0+ICh7XG4gICAgICAgIG9wOiAnc3BlZWQnIGFzIGNvbnN0LFxuICAgICAgICBpbnB1dDoge1xuICAgICAgICAgIC4uLmIsXG4gICAgICAgICAgY2xpcDogY2xpcElucHV0KGMpLFxuICAgICAgICAgIHNwZWVkOiBhLnBlcmNlbnQgLyAxMDAsXG4gICAgICAgICAgcmV2ZXJzZTogYS5yZXZlcnNlLFxuICAgICAgICAgIHJpcHBsZTogYS5yaXBwbGUsXG4gICAgICAgIH0sXG4gICAgICAgIHRpbWVvdXRNczogVElNRU9VVFMuc3BlZWQsXG4gICAgICAgIGl0ZW06IGMubGFiZWwsXG4gICAgICB9KSk7XG4gICAgY2FzZSAnc2V0X2NsaXBfZ2Fpbic6XG4gICAgICByZXR1cm4gYS5jbGlwcy5tYXAoKGMpID0+ICh7XG4gICAgICAgIG9wOiAndm9sdW1lJyBhcyBjb25zdCxcbiAgICAgICAgaW5wdXQ6IHsgLi4uYiwgY2xpcDogY2xpcElucHV0KGMpLCBsZXZlbERiOiBhLmdhaW5EYiwgY2xlYXJLZXlmcmFtZXM6IGZhbHNlIH0sXG4gICAgICAgIHRpbWVvdXRNczogVElNRU9VVFMudm9sdW1lLFxuICAgICAgICBpdGVtOiBjLmxhYmVsLFxuICAgICAgfSkpO1xuICAgIGNhc2UgJ2ltcG9ydF94bWxfaW50b19iaW4nOlxuICAgICAgcmV0dXJuIFtcbiAgICAgICAge1xuICAgICAgICAgIG9wOiAnaW1wb3J0WG1sJyxcbiAgICAgICAgICBpbnB1dDogeyBwcm9qZWN0UGF0aDogcmVxLnByb2plY3QucGF0aCwgeG1sUGF0aDogYS54bWxQYXRoLCBiaW5QYXRoOiBhLmJpblBhdGggfSxcbiAgICAgICAgICB0aW1lb3V0TXM6IFRJTUVPVVRTLmltcG9ydFhtbCxcbiAgICAgICAgICBpdGVtOiBhLmJpblBhdGguam9pbignLycpLFxuICAgICAgICB9LFxuICAgICAgXTtcbiAgfVxufVxuXG5mdW5jdGlvbiBjbGlwSW5wdXQoYzogQ2xpcEFkZHIpIHtcbiAgcmV0dXJuIHsgdHJhY2tUeXBlOiBjLnRyYWNrVHlwZSwgdHJhY2tJbmRleDogYy50cmFja0luZGV4LCBjbGlwU3RhcnQ6IGMuY2xpcFN0YXJ0LCBuYW1lOiBjLm5hbWUgfTtcbn1cblxuLyoqIFRoZSBFeHRlbmRTY3JpcHQgc291cmNlIGZvciBvbmUgY2FsbC4gSlNPTiBpcyBhIHZhbGlkIEVTMyBsaXRlcmFsIG9uY2UgVSsyMDI4LzkgYXJlIGVzY2FwZWQuICovXG5leHBvcnQgZnVuY3Rpb24gc2NyaXB0Rm9yKGNhbGw6IE9wQ2FsbCk6IHN0cmluZyB7XG4gIGNvbnN0IGpzb24gPSBKU09OLnN0cmluZ2lmeShjYWxsLmlucHV0KVxuICAgIC5yZXBsYWNlKC9cXHUyMDI4L2csICdcXFxcdTIwMjgnKVxuICAgIC5yZXBsYWNlKC9cXHUyMDI5L2csICdcXFxcdTIwMjknKTtcbiAgcmV0dXJuIGBHb2JsaW5zQ0VQLnJ1bigke0pTT04uc3RyaW5naWZ5KGNhbGwub3ApfSwgJHtqc29ufSlgO1xufVxuXG4vKiogV2hhdCBvbmUgRXh0ZW5kU2NyaXB0IG9wIHJldHVybnMgKHNlZSBqc3gvZ29ibGluc19oZWxwZXIuanN4KS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgT3BSZXN1bHQge1xuICBvazogYm9vbGVhbjtcbiAgYXBwbGllZDogbnVtYmVyO1xuICByZWZ1c2VkPzogYm9vbGVhbjtcbiAgdW5kb1N0ZXBzPzogbnVtYmVyO1xuICB3YXJuaW5ncz86IHN0cmluZ1tdO1xuICByZWFkQmFjaz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICBlcnJvcj86IHsgY29kZTogc3RyaW5nOyBtZXNzYWdlOiBzdHJpbmc7IGRldGFpbD86IHVua25vd24gfTtcbiAgb3A/OiBzdHJpbmc7XG4gIG1zPzogbnVtYmVyO1xufVxuXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VPcFJlc3VsdChyYXc6IHN0cmluZyk6IE9wUmVzdWx0IHtcbiAgbGV0IHY6IHVua25vd247XG4gIHRyeSB7XG4gICAgdiA9IEpTT04ucGFyc2UocmF3KTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gZXZhbFNjcmlwdCByZXR1cm5zIFwiRXZhbFNjcmlwdCBlcnJvci5cIiB3aGVuIHRoZSBzY3JpcHQgaXRzZWxmIGZhaWxlZCB0byBydW4uXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGFwcGxpZWQ6IDAsXG4gICAgICBlcnJvcjogeyBjb2RlOiAnaG9zdF9lcnJvcicsIG1lc3NhZ2U6IGBFeHRlbmRTY3JpcHQ6ICR7cmF3LnNsaWNlKDAsIDMwMCl9YCB9LFxuICAgIH07XG4gIH1cbiAgaWYgKCF2IHx8IHR5cGVvZiB2ICE9PSAnb2JqZWN0JyB8fCB0eXBlb2YgKHYgYXMgT3BSZXN1bHQpLm9rICE9PSAnYm9vbGVhbicpXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGFwcGxpZWQ6IDAsXG4gICAgICBlcnJvcjogeyBjb2RlOiAnaG9zdF9lcnJvcicsIG1lc3NhZ2U6ICdFeHRlbmRTY3JpcHQgcmV0dXJuZWQgbm8gcmVzdWx0JyB9LFxuICAgIH07XG4gIHJldHVybiB2IGFzIE9wUmVzdWx0O1xufVxuXG4vKiogSG93IG1hbnkgQ21kK1ogaXQgdGFrZXMgdG8gcmVtb3ZlIHdoYXQgYW4gb3AgZGlkIFx1MjAxNCBFeHRlbmRTY3JpcHQgaGFzIG5vIG5hbWVkIHVuZG8gZ3JvdXAuICovXG5leHBvcnQgY29uc3QgVU5ET19OT1RFID1cbiAgJ0FwcGxpZWQgYnkgdGhlIENFUCBoZWxwZXIgKEV4dGVuZFNjcmlwdCkuIFByZW1pZXJlIHJlY29yZHMgZWFjaCBFeHRlbmRTY3JpcHQgZWRpdCBhcyBpdHMgb3duIHVuZG8gc3RlcCwgc28gdGhpcyBjYW5ub3QgYmUgb25lIG5hbWVkIHN0ZXA6IHVuZG8gbWF5IHRha2UgdGhlIG51bWJlciBvZiBzdGVwcyBzaG93bi4nO1xuXG5leHBvcnQgaW50ZXJmYWNlIFJlc3VsdEZyYW1lIHtcbiAgdHlwZTogJ3Jlc3VsdCc7XG4gIGlkOiBzdHJpbmc7XG4gIG9rOiBib29sZWFuO1xuICBzdGF0dXM6ICdhcHBsaWVkJyB8ICdyZWZ1c2VkJyB8ICdmYWlsZWQnO1xuICBjb2RlOiBzdHJpbmcgfCBudWxsO1xuICBtZXNzYWdlOiBzdHJpbmc7XG4gIGFwcGxpZWQ6IHVua25vd25bXTtcbiAgcmVhZEJhY2s6IHsgb2s6IGJvb2xlYW47IGl0ZW1zOiB1bmtub3duW10gfTtcbiAgdW5kb05hbWU6IHN0cmluZztcbiAgdW5kbzogeyBncm91cGVkOiBmYWxzZTsgc3RlcHM6IG51bWJlcjsgbm90ZTogc3RyaW5nIH07XG4gIHdhcm5pbmdzOiBzdHJpbmdbXTtcbiAgZW5naW5lOiAnY2VwJztcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIHJlZnVzZWRSZXN1bHQoXG4gIGlkOiBzdHJpbmcsXG4gIHVuZG9OYW1lOiBzdHJpbmcsXG4gIGNvZGU6IHN0cmluZyxcbiAgbWVzc2FnZTogc3RyaW5nLFxuKTogUmVzdWx0RnJhbWUge1xuICByZXR1cm4ge1xuICAgIHR5cGU6ICdyZXN1bHQnLFxuICAgIGlkLFxuICAgIG9rOiBmYWxzZSxcbiAgICBzdGF0dXM6ICdyZWZ1c2VkJyxcbiAgICBjb2RlLFxuICAgIG1lc3NhZ2UsXG4gICAgYXBwbGllZDogW10sXG4gICAgcmVhZEJhY2s6IHsgb2s6IGZhbHNlLCBpdGVtczogW10gfSxcbiAgICB1bmRvTmFtZSxcbiAgICB1bmRvOiB7IGdyb3VwZWQ6IGZhbHNlLCBzdGVwczogMCwgbm90ZTogVU5ET19OT1RFIH0sXG4gICAgd2FybmluZ3M6IFtdLFxuICAgIGVuZ2luZTogJ2NlcCcsXG4gIH07XG59XG5cbi8qKiBNYXAgb3AgcmVhZEJhY2tzIGludG8gXHUwMEE3Ny1zdHlsZSBgYWZmZWN0ZWRgIGVudHJpZXMgZm9yIHRoZSBwYW5lbCdzIGFpX2VkaXQgcmVjb3JkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFwcGxpZWRFbnRyaWVzKGNhbGw6IE9wQ2FsbCwgcjogT3BSZXN1bHQpOiB1bmtub3duW10ge1xuICBjb25zdCByYiA9IChyLnJlYWRCYWNrID8/IHt9KSBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+O1xuICBzd2l0Y2ggKGNhbGwub3ApIHtcbiAgICBjYXNlICdyYXpvcic6XG4gICAgICByZXR1cm4gKChyYi5jdXQgYXMgYW55W10pID8/IFtdKS5tYXAoKGMpID0+ICh7XG4gICAgICAgIHRhcmdldDogJ2NsaXAnLFxuICAgICAgICB0cmFjazogcmF6b3JUcmFja0xhYmVsKFN0cmluZyhjLnRyYWNrKSksXG4gICAgICAgIHN0YXJ0VGlja3M6IFN0cmluZyhyYi50aW1lKSxcbiAgICAgICAgZmllbGQ6ICdzcGxpdCcsXG4gICAgICAgIGJlZm9yZTogYy5sZWZ0ID8/IG51bGwsXG4gICAgICAgIGFmdGVyOiBjLnJpZ2h0Py5uYW1lID8/IG51bGwsXG4gICAgICB9KSk7XG4gICAgY2FzZSAnc3BlZWQnOlxuICAgICAgcmV0dXJuIHIuYXBwbGllZFxuICAgICAgICA/IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgdGFyZ2V0OiAnY2xpcCcsXG4gICAgICAgICAgICAgIC4uLnNwbGl0TGFiZWwoY2FsbC5pdGVtKSxcbiAgICAgICAgICAgICAgZmllbGQ6ICdzcGVlZCcsXG4gICAgICAgICAgICAgIGJlZm9yZTogeyBzcGVlZDogcmIuYmVmb3JlPy5zcGVlZCwgcmV2ZXJzZWQ6IHJiLmJlZm9yZT8ucmV2ZXJzZWQgfSxcbiAgICAgICAgICAgICAgYWZ0ZXI6IHsgc3BlZWQ6IHJiLmFmdGVyPy5zcGVlZCwgcmV2ZXJzZWQ6IHJiLmFmdGVyPy5yZXZlcnNlZCB9LFxuICAgICAgICAgICAgICBlbmRUaWNrczogcmIuYWZ0ZXI/LmVuZCxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXVxuICAgICAgICA6IFtdO1xuICAgIGNhc2UgJ3ZvbHVtZSc6XG4gICAgICByZXR1cm4gci5hcHBsaWVkXG4gICAgICAgID8gW1xuICAgICAgICAgICAge1xuICAgICAgICAgICAgICB0YXJnZXQ6ICdjbGlwJyxcbiAgICAgICAgICAgICAgLi4uc3BsaXRMYWJlbChjYWxsLml0ZW0pLFxuICAgICAgICAgICAgICBmaWVsZDogJ2dhaW4nLFxuICAgICAgICAgICAgICBiZWZvcmU6IHJiLmJlZm9yZURiLFxuICAgICAgICAgICAgICBhZnRlcjogcmIuYWZ0ZXJEYixcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgXVxuICAgICAgICA6IFtdO1xuICAgIGNhc2UgJ2ltcG9ydFhtbCc6XG4gICAgICByZXR1cm4gKChyYi5uZXdJdGVtcyBhcyBhbnlbXSkgPz8gW10pLm1hcCgoaXQpID0+ICh7XG4gICAgICAgIHRhcmdldDogJ3Byb2plY3RfaXRlbScsXG4gICAgICAgIGZpZWxkOiAnaW1wb3J0ZWQnLFxuICAgICAgICBiaW46IGNhbGwuaXRlbSxcbiAgICAgICAgbmFtZTogaXQubmFtZSxcbiAgICAgICAgbm9kZUlkOiBpdC5ub2RlSWQsXG4gICAgICAgIGJlZm9yZTogbnVsbCxcbiAgICAgICAgYWZ0ZXI6IGl0Lm5hbWUsXG4gICAgICB9KSk7XG4gICAgZGVmYXVsdDpcbiAgICAgIHJldHVybiBbXTtcbiAgfVxufVxuXG5mdW5jdGlvbiByYXpvclRyYWNrTGFiZWwoa2V5OiBzdHJpbmcpOiBzdHJpbmcge1xuICBjb25zdCBtID0gL14odmlkZW98YXVkaW8pKFxcZCspJC8uZXhlYyhrZXkpO1xuICByZXR1cm4gbSA/IChtWzFdID09PSAndmlkZW8nID8gJ1YnIDogJ0EnKSArIChOdW1iZXIobVsyXSkgKyAxKSA6IGtleTtcbn1cbmZ1bmN0aW9uIHNwbGl0TGFiZWwobGFiZWw6IHN0cmluZykge1xuICBjb25zdCBbdHJhY2ssIHN0YXJ0VGlja3NdID0gbGFiZWwuc3BsaXQoJ0AnKTtcbiAgcmV0dXJuIHsgdHJhY2ssIHN0YXJ0VGlja3MgfTtcbn1cbiIsICIvLyBOb2RlLXNpZGUgaGVscGVycyBmb3IgdGhlIENFUCBwYW5lbCB0aGF0IHRvdWNoIHRoZSBjb21wdXRlcjogdGhlIGh1YidzIGRpc2NvdmVyeSBmaWxlXG4vLyAoZG9jcy9haS1lZGl0aW5nLm1kIFx1MDBBNzMpLCB0aGUgbm9uLXNlY3JldCBjb25maWcgZmlsZSBhbmQgdGhlIHBhaXJpbmcgdG9rZW4gKG1hY09TIEtleWNoYWluLFxuLy8gb3IgYSBwZXItdXNlciBmaWxlIG9uIFdpbmRvd3MpLlxuLy8gS2VwdCBhcGFydCBmcm9tIHBhbmVsLnRzIHNvIHRoZXkgY2FuIGJlIHRlc3RlZCB3aXRob3V0IGEgYnJvd3Nlci5cbmltcG9ydCB7IGV4ZWNGaWxlLCBzcGF3biB9IGZyb20gJ25vZGU6Y2hpbGRfcHJvY2Vzcyc7XG5pbXBvcnQge1xuICBta2RpclN5bmMsXG4gIHJlYWRGaWxlU3luYyxcbiAgd3JpdGVGaWxlU3luYyxcbiAgYXBwZW5kRmlsZVN5bmMsXG4gIHN0YXRTeW5jLFxuICByZW5hbWVTeW5jLFxufSBmcm9tICdub2RlOmZzJztcbmltcG9ydCB7IGhvbWVkaXIgfSBmcm9tICdub2RlOm9zJztcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdub2RlOnBhdGgnO1xuaW1wb3J0IHR5cGUgeyBTdG9yZSB9IGZyb20gJy4vZW5naW5lLmpzJztcbmltcG9ydCB7IGdvYmxpbnNEaXIgYXMgc2hhcmVkR29ibGluc0RpciB9IGZyb20gJy4uLy4uLy4uL3BhY2thZ2VzL2NvcmUvc3JjL2xvY2FsLXBhdGhzLmpzJztcblxuLyoqIFRoZSBmb2xkZXIgdGhlIE1DUCB3cml0ZXMgaXRzIGRpc2NvdmVyeSBmaWxlIHRvIChzaGFyZWQgcnVsZTogcGFja2FnZXMvY29yZSBsb2NhbC1wYXRocy50cykuICovXG5leHBvcnQgZnVuY3Rpb24gZ29ibGluc0RpcihcbiAgaG9tZSA9IGhvbWVkaXIoKSxcbiAgcGxhdGZvcm06IHN0cmluZyA9IHByb2Nlc3MucGxhdGZvcm0sXG4gIGVudjogeyBYREdfQ09ORklHX0hPTUU/OiBzdHJpbmcgfSA9IHByb2Nlc3MuZW52LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHNoYXJlZEdvYmxpbnNEaXIocGxhdGZvcm0sIGhvbWUsIGVudik7XG59XG5cbmV4cG9ydCBpbnRlcmZhY2UgRGlzY292ZXJ5IHtcbiAgcG9ydDogbnVtYmVyO1xuICBodWJJZDogc3RyaW5nO1xuICBwaWQ/OiBudW1iZXI7XG59XG5cbi8qKiBSZWFkIGFuZCBjaGVjayB0aGUgaHViJ3MgZGlzY292ZXJ5IGZpbGUuIFJldHVybnMgbnVsbCB3aGVuIG1pc3Npbmcgb3IgbWFsZm9ybWVkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlYWREaXNjb3ZlcnkoZGlyID0gZ29ibGluc0RpcigpKTogRGlzY292ZXJ5IHwgbnVsbCB7XG4gIGxldCB2OiBhbnk7XG4gIHRyeSB7XG4gICAgdiA9IEpTT04ucGFyc2UocmVhZEZpbGVTeW5jKGpvaW4oZGlyLCAncHJlbWllcmUtbWNwLmpzb24nKSwgJ3V0ZjgnKSk7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIGlmICghdiB8fCB2LnYgIT09IDEpIHJldHVybiBudWxsO1xuICBpZiAoIU51bWJlci5pc0ludGVnZXIodi5wb3J0KSB8fCB2LnBvcnQgPCAxMDI0IHx8IHYucG9ydCA+IDY1NTM1KSByZXR1cm4gbnVsbDtcbiAgaWYgKHR5cGVvZiB2Lmh1YklkICE9PSAnc3RyaW5nJyB8fCAhL15oX1tcXHctXXs4LDY0fSQvLnRlc3Qodi5odWJJZCkpIHJldHVybiBudWxsO1xuICByZXR1cm4geyBwb3J0OiB2LnBvcnQsIGh1YklkOiB2Lmh1YklkLCBwaWQ6IHYucGlkIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBodWJVcmxzKGQ6IERpc2NvdmVyeSk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtgd3M6Ly8xMjcuMC4wLjE6JHtkLnBvcnR9L2dvYmxpbnMtcHJlbWllcmVgLCBgd3M6Ly9sb2NhbGhvc3Q6JHtkLnBvcnR9L2dvYmxpbnMtcHJlbWllcmVgXTtcbn1cblxuY29uc3QgU0VSVklDRSA9ICdHb2JsaW5zIENFUCBIZWxwZXInO1xuXG4vKipcbiAqIFRoZSBoZWxwZXIncyBzdG9yZSBvbiB0aGlzIGNvbXB1dGVyOiBtYWNPUyBrZWVwcyB0aGUgcGFpcmluZyB0b2tlbiBpbiB0aGUgS2V5Y2hhaW47IFdpbmRvd3NcbiAqIChhbmQgYW55dGhpbmcgZWxzZSkgaW4gYSBwZXItdXNlciBmaWxlIG5leHQgdG8gdGhlIGNvbmZpZyAoQlVHLTIwMjYxMTA5LTMzKSwgYXMgdGhlIE1DUCdzXG4gKiBGaWxlU3RvcmUga2VlcHMgaXRzIHBhaXJpbmcgaGFzaGVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbG9jYWxTdG9yZShkaXIgPSBnb2JsaW5zRGlyKCksIHBsYXRmb3JtOiBzdHJpbmcgPSBwcm9jZXNzLnBsYXRmb3JtKTogU3RvcmUge1xuICByZXR1cm4gcGxhdGZvcm0gPT09ICdkYXJ3aW4nID8gbWFjU3RvcmUoZGlyKSA6IGZpbGVTdG9yZShkaXIpO1xufVxuXG5mdW5jdGlvbiBjb25maWdGaWxlKGRpcjogc3RyaW5nKSB7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpciwgJ2NlcC1oZWxwZXIuanNvbicpO1xuICByZXR1cm4ge1xuICAgIGxvYWRDb25maWcoKTogeyBlbmdpbmVJZD86IHN0cmluZzsgaHViSWQ/OiBzdHJpbmcgfSB7XG4gICAgICB0cnkge1xuICAgICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZmlsZSwgJ3V0ZjgnKSk7XG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgZW5naW5lSWQ6IHR5cGVvZiB2LmVuZ2luZUlkID09PSAnc3RyaW5nJyA/IHYuZW5naW5lSWQgOiB1bmRlZmluZWQsXG4gICAgICAgICAgaHViSWQ6IHR5cGVvZiB2Lmh1YklkID09PSAnc3RyaW5nJyA/IHYuaHViSWQgOiB1bmRlZmluZWQsXG4gICAgICAgIH07XG4gICAgICB9IGNhdGNoIHtcbiAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgfVxuICAgIH0sXG4gICAgc2F2ZUNvbmZpZyhjOiB7IGVuZ2luZUlkOiBzdHJpbmc7IGh1YklkPzogc3RyaW5nIH0pIHtcbiAgICAgIHdyaXRlUHJpdmF0ZShkaXIsIGZpbGUsIHsgZW5naW5lSWQ6IGMuZW5naW5lSWQsIGh1YklkOiBjLmh1YklkID8/IG51bGwgfSk7XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIFdyaXRlcyBKU09OIHJlYWRhYmxlIGJ5IHRoaXMgdXNlciBvbmx5ICgwNjAwOyB1bmRlciAlQVBQREFUQSUgb24gV2luZG93cywgYSBwZXItdXNlciBmb2xkZXIpLiAqL1xuZnVuY3Rpb24gd3JpdGVQcml2YXRlKGRpcjogc3RyaW5nLCBmaWxlOiBzdHJpbmcsIHZhbHVlOiB1bmtub3duKSB7XG4gIG1rZGlyU3luYyhkaXIsIHsgcmVjdXJzaXZlOiB0cnVlLCBtb2RlOiAwbzcwMCB9KTtcbiAgY29uc3QgdG1wID0gZmlsZSArICcudG1wJztcbiAgd3JpdGVGaWxlU3luYyh0bXAsIEpTT04uc3RyaW5naWZ5KHZhbHVlKSwgeyBtb2RlOiAwbzYwMCB9KTtcbiAgcmVuYW1lU3luYyh0bXAsIGZpbGUpO1xufVxuXG5jb25zdCBUT0tFTiA9IC9eW1xcdy1dezE2LDEyOH0kLztcbmNvbnN0IEhVQiA9IC9eaF9bXFx3LV0rJC87XG5cbi8qKiBDb25maWcgKyBwYWlyaW5nIHRva2VucyBpbiBgY2VwLWhlbHBlci10b2tlbnMuanNvbmAgKDA2MDApLiBUaGUgdG9rZW4gbmV2ZXIgdG91Y2hlcyBhcmd2IG9yIGEgbG9nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZpbGVTdG9yZShkaXIgPSBnb2JsaW5zRGlyKCkpOiBTdG9yZSB7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpciwgJ2NlcC1oZWxwZXItdG9rZW5zLmpzb24nKTtcbiAgY29uc3QgYWxsID0gKCk6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4gPT4ge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCB2ID0gSlNPTi5wYXJzZShyZWFkRmlsZVN5bmMoZmlsZSwgJ3V0ZjgnKSk7XG4gICAgICByZXR1cm4gdiAmJiB0eXBlb2YgdiA9PT0gJ29iamVjdCcgJiYgIUFycmF5LmlzQXJyYXkodikgPyB2IDoge307XG4gICAgfSBjYXRjaCB7XG4gICAgICByZXR1cm4ge307XG4gICAgfVxuICB9O1xuICByZXR1cm4ge1xuICAgIC4uLmNvbmZpZ0ZpbGUoZGlyKSxcbiAgICBhc3luYyBnZXRUb2tlbihodWJJZCkge1xuICAgICAgY29uc3QgdCA9IGFsbCgpW2h1YklkXTtcbiAgICAgIHJldHVybiB0eXBlb2YgdCA9PT0gJ3N0cmluZycgJiYgVE9LRU4udGVzdCh0KSA/IHQgOiBudWxsO1xuICAgIH0sXG4gICAgYXN5bmMgc2V0VG9rZW4oaHViSWQsIHRva2VuKSB7XG4gICAgICBpZiAoIVRPS0VOLnRlc3QodG9rZW4pIHx8ICFIVUIudGVzdChodWJJZCkpIHRocm93IG5ldyBFcnJvcignYmFkIHRva2VuJyk7XG4gICAgICB3cml0ZVByaXZhdGUoZGlyLCBmaWxlLCB7IC4uLmFsbCgpLCBbaHViSWRdOiB0b2tlbiB9KTtcbiAgICB9LFxuICAgIGFzeW5jIGRlbGV0ZVRva2VuKGh1YklkKSB7XG4gICAgICBjb25zdCB2ID0gYWxsKCk7XG4gICAgICBpZiAoIShodWJJZCBpbiB2KSkgcmV0dXJuO1xuICAgICAgZGVsZXRlIHZbaHViSWRdO1xuICAgICAgd3JpdGVQcml2YXRlKGRpciwgZmlsZSwgdik7XG4gICAgfSxcbiAgfTtcbn1cblxuLyoqIEZpbGUgY29uZmlnICsgbWFjT1MgS2V5Y2hhaW4gdG9rZW4gc3RvcmUuIFRoZSB0b2tlbiBuZXZlciB0b3VjaGVzIGFyZ3Ygb3IgYSBsb2cuICovXG5leHBvcnQgZnVuY3Rpb24gbWFjU3RvcmUoZGlyID0gZ29ibGluc0RpcigpKTogU3RvcmUge1xuICByZXR1cm4ge1xuICAgIC4uLmNvbmZpZ0ZpbGUoZGlyKSxcbiAgICBnZXRUb2tlbihodWJJZCkge1xuICAgICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PlxuICAgICAgICBleGVjRmlsZShcbiAgICAgICAgICAnL3Vzci9iaW4vc2VjdXJpdHknLFxuICAgICAgICAgIFsnZmluZC1nZW5lcmljLXBhc3N3b3JkJywgJy1zJywgU0VSVklDRSwgJy1hJywgJ2h1YjonICsgaHViSWQsICctdyddLFxuICAgICAgICAgIChlcnIsIG91dCkgPT4gcmVzb2x2ZShlcnIgPyBudWxsIDogb3V0LnRyaW0oKSB8fCBudWxsKSxcbiAgICAgICAgKSxcbiAgICAgICk7XG4gICAgfSxcbiAgICBzZXRUb2tlbihodWJJZCwgdG9rZW4pIHtcbiAgICAgIGlmICghVE9LRU4udGVzdCh0b2tlbikgfHwgIUhVQi50ZXN0KGh1YklkKSkgcmV0dXJuIFByb21pc2UucmVqZWN0KG5ldyBFcnJvcignYmFkIHRva2VuJykpO1xuICAgICAgLy8gYHNlY3VyaXR5IC1pYCByZWFkcyB0aGUgY29tbWFuZCBmcm9tIHN0ZGluLCBzbyB0aGUgdG9rZW4gaXMgbm90IHZpc2libGUgaW4gYHBzYC5cbiAgICAgIHJldHVybiBrZXljaGFpblN0ZGluKFxuICAgICAgICBgYWRkLWdlbmVyaWMtcGFzc3dvcmQgLVUgLXMgXCIke1NFUlZJQ0V9XCIgLWEgXCJodWI6JHtodWJJZH1cIiAtdyBcIiR7dG9rZW59XCJcXG5gLFxuICAgICAgKTtcbiAgICB9LFxuICAgIGRlbGV0ZVRva2VuKGh1YklkKSB7XG4gICAgICByZXR1cm4gbmV3IFByb21pc2UoKHJlc29sdmUpID0+XG4gICAgICAgIGV4ZWNGaWxlKFxuICAgICAgICAgICcvdXNyL2Jpbi9zZWN1cml0eScsXG4gICAgICAgICAgWydkZWxldGUtZ2VuZXJpYy1wYXNzd29yZCcsICctcycsIFNFUlZJQ0UsICctYScsICdodWI6JyArIGh1YklkXSxcbiAgICAgICAgICAoKSA9PiByZXNvbHZlKCksXG4gICAgICAgICksXG4gICAgICApO1xuICAgIH0sXG4gIH07XG59XG5cbmZ1bmN0aW9uIGtleWNoYWluU3RkaW4oY21kOiBzdHJpbmcpOiBQcm9taXNlPHZvaWQ+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBjb25zdCBwID0gc3Bhd24oJy91c3IvYmluL3NlY3VyaXR5JywgWyctaSddLCB7IHN0ZGlvOiBbJ3BpcGUnLCAnaWdub3JlJywgJ2lnbm9yZSddIH0pO1xuICAgIHAub24oJ2Vycm9yJywgcmVqZWN0KTtcbiAgICBwLm9uKCdleGl0JywgKGNvZGUpID0+IChjb2RlID09PSAwID8gcmVzb2x2ZSgpIDogcmVqZWN0KG5ldyBFcnJvcigna2V5Y2hhaW4gd3JpdGUgZmFpbGVkJykpKSk7XG4gICAgcC5zdGRpbi5lbmQoY21kKTtcbiAgfSk7XG59XG5cbi8qKiBMb2NhbCBKU09OLWxpbmVzIGxvZyBvZiB3aGF0IHRoZSBoZWxwZXIgcmFuIChubyB0b2tlbnMsIG5vIGNsaXAgbmFtZXMgYmV5b25kIHRoZSByZXF1ZXN0KS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaWxlTG9nZ2VyKGRpciA9IGdvYmxpbnNEaXIoKSk6IChlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPikgPT4gdm9pZCB7XG4gIGNvbnN0IGZpbGUgPSBqb2luKGRpciwgJ2NlcC1oZWxwZXIubG9nJyk7XG4gIHJldHVybiAoZSkgPT4ge1xuICAgIHRyeSB7XG4gICAgICBta2RpclN5bmMoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSwgbW9kZTogMG83MDAgfSk7XG4gICAgICB0cnkge1xuICAgICAgICBpZiAoc3RhdFN5bmMoZmlsZSkuc2l6ZSA+IDVfMDAwXzAwMCkgcmVuYW1lU3luYyhmaWxlLCBmaWxlICsgJy4xJyk7XG4gICAgICB9IGNhdGNoIHt9XG4gICAgICBhcHBlbmRGaWxlU3luYyhmaWxlLCBKU09OLnN0cmluZ2lmeShlKSArICdcXG4nLCB7IG1vZGU6IDBvNjAwIH0pO1xuICAgIH0gY2F0Y2gge31cbiAgfTtcbn1cbiIsICIvLyBDRVAgcGFuZWwgZW50cnkgKGJ1bmRsZWQgdG8gZGlzdC9jZXAtaGVscGVyL2pzL2hlbHBlci5qcykuIENvbm5lY3RzIG91dCB0byB0aGUgbG9jYWwgaHViIHdpdGggdGhlXG4vLyBicm93c2VyIFdlYlNvY2tldCwgcnVucyBFeHRlbmRTY3JpcHQgdGhyb3VnaCBDRVAncyBldmFsU2NyaXB0LCBhbmQgc2hvd3Mgc3RhdHVzIGFuZCB0aGUgcGFpcmluZ1xuLy8gY29kZS4gSXQgaGFzIG5vIEFwcGx5IGJ1dHRvbiBvbiBwdXJwb3NlOiBhcHByb3ZhbCBvbmx5IGhhcHBlbnMgaW4gdGhlIEdvYmxpbnMgVVhQIHBhbmVsLlxuaW1wb3J0IHsgQ2VwRW5naW5lLCB0eXBlIEVuZ2luZVN0YXR1cyB9IGZyb20gJy4vZW5naW5lLmpzJztcbmltcG9ydCB7IGZpbGVMb2dnZXIsIGh1YlVybHMsIGxvY2FsU3RvcmUsIHJlYWREaXNjb3ZlcnkgfSBmcm9tICcuL2hvc3QuanMnO1xuaW1wb3J0IHsgSEVMUEVSX1ZFUlNJT04gfSBmcm9tICcuL3Byb3RvY29sLmpzJztcblxuY29uc3Qgd2luZG93ID0gZ2xvYmFsVGhpcyBhcyBhbnk7XG5jb25zdCBkb2N1bWVudCA9IHdpbmRvdy5kb2N1bWVudDtcblxuY29uc3QgY2VwID0gd2luZG93Ll9fYWRvYmVfY2VwX187XG5cbmZ1bmN0aW9uIGV2YWx1YXRlKHNjcmlwdDogc3RyaW5nKTogUHJvbWlzZTxzdHJpbmc+IHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiBjZXAuZXZhbFNjcmlwdChzY3JpcHQsIChyOiBzdHJpbmcpID0+IHJlc29sdmUoU3RyaW5nKHIpKSkpO1xufVxuXG5mdW5jdGlvbiBob3N0VmVyc2lvbigpOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICB0cnkge1xuICAgIHJldHVybiBKU09OLnBhcnNlKGNlcC5nZXRIb3N0RW52aXJvbm1lbnQoKSkuYXBwVmVyc2lvbjtcbiAgfSBjYXRjaCB7XG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG5jb25zdCAkID0gKGlkOiBzdHJpbmcpID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTtcblxuZnVuY3Rpb24gc2hvdyhzOiBFbmdpbmVTdGF0dXMpIHtcbiAgY29uc3QgY29kZSA9ICQoJ2NvZGUnKTtcbiAgY29uc3Qgc3RhdHVzID0gJCgnc3RhdHVzJyk7XG4gIGNvZGUudGV4dENvbnRlbnQgPSAnJztcbiAgc3dpdGNoIChzLnN0YXRlKSB7XG4gICAgY2FzZSAncGFpcmluZyc6XG4gICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSAnUGFpciB3aXRoIHlvdXIgQUk6IHRlbGwgaXQgdGhpcyBjb2RlICh2YWxpZCA1IG1pbnV0ZXMpLic7XG4gICAgICBjb2RlLnRleHRDb250ZW50ID0gcy5jb2RlLnNsaWNlKDAsIDMpICsgJyAnICsgcy5jb2RlLnNsaWNlKDMpO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAncmVhZHknOlxuICAgICAgc3RhdHVzLnRleHRDb250ZW50ID1cbiAgICAgICAgJ0Nvbm5lY3RlZCB0byBHb2JsaW5zIFByZW1pZXJlLiBFZGl0cyBjb21lIG9ubHkgYWZ0ZXIgeW91IGFwcHJvdmUgdGhlbSBpbiB0aGUgR29ibGlucyBwYW5lbC4nO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAnYnVzeSc6XG4gICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBgUnVubmluZyBhbiBhcHByb3ZlZCBlZGl0ICgke3Mub3B9KVx1MjAyNmA7XG4gICAgICBicmVhaztcbiAgICBjYXNlICdjb25uZWN0aW5nJzpcbiAgICAgIHN0YXR1cy50ZXh0Q29udGVudCA9ICdDb25uZWN0aW5nIHRvIEdvYmxpbnMgUHJlbWllcmVcdTIwMjYnO1xuICAgICAgYnJlYWs7XG4gICAgY2FzZSAncGFpcl9mYWlsZWQnOlxuICAgIGNhc2UgJ2h1Yl9yZWplY3RlZCc6XG4gICAgICBzdGF0dXMudGV4dENvbnRlbnQgPSBzLmRldGFpbDtcbiAgICAgIGJyZWFrO1xuICAgIGRlZmF1bHQ6XG4gICAgICBzdGF0dXMudGV4dENvbnRlbnQgPVxuICAgICAgICAnV2FpdGluZyBmb3IgdGhlIEdvYmxpbnMgUHJlbWllcmUgTUNQIHRvIHN0YXJ0JyArIChzLmRldGFpbCA/IGAgKCR7cy5kZXRhaWx9KWAgOiAnJykgKyAnLic7XG4gIH1cbn1cblxuY29uc3QgbG9nID0gZmlsZUxvZ2dlcigpO1xuY29uc3QgZW5naW5lID0gbmV3IENlcEVuZ2luZSh7XG4gIGV2YWx1YXRlLFxuICBzdG9yZTogbG9jYWxTdG9yZSgpLFxuICBsb2csXG4gIGhvc3RWZXJzaW9uOiBob3N0VmVyc2lvbigpLFxuICBvblN0YXR1czogc2hvdyxcbn0pO1xuXG5sZXQgd3M6IGFueSA9IG51bGw7XG5sZXQgYmFja29mZiA9IFsxLCAyLCA1LCAxMF07XG5sZXQgYXR0ZW1wdCA9IDA7XG5cbmZ1bmN0aW9uIGNvbm5lY3QoKSB7XG4gIGNvbnN0IGQgPSByZWFkRGlzY292ZXJ5KCk7XG4gIGlmICghZCkgcmV0dXJuIHNldFRpbWVvdXQoY29ubmVjdCwgMzAwMCk7XG4gIGNvbnN0IHVybHMgPSBodWJVcmxzKGQpO1xuICBjb25zdCB1cmwgPSB1cmxzW2F0dGVtcHQgJSB1cmxzLmxlbmd0aF07XG4gIHdzID0gbmV3IHdpbmRvdy5XZWJTb2NrZXQodXJsKTtcbiAgd3Mub25vcGVuID0gKCkgPT4ge1xuICAgIGF0dGVtcHQgPSAwO1xuICAgIHZvaWQgZW5naW5lLm9uT3Blbih7IHNlbmQ6ICh0KSA9PiB3cy5zZW5kKHQpLCBjbG9zZTogKGMsIHIpID0+IHdzLmNsb3NlKGMsIHIpIH0sIGQuaHViSWQpO1xuICB9O1xuICB3cy5vbm1lc3NhZ2UgPSAoZXY6IGFueSkgPT4ge1xuICAgIGlmICh0eXBlb2YgZXYuZGF0YSA9PT0gJ3N0cmluZycgJiYgZXYuZGF0YS5sZW5ndGggPD0gNCAqIDEwMjQgKiAxMDI0KVxuICAgICAgdm9pZCBlbmdpbmUub25NZXNzYWdlKGV2LmRhdGEpO1xuICB9O1xuICB3cy5vbmNsb3NlID0gKCkgPT4ge1xuICAgIGVuZ2luZS5vbkNsb3NlKCk7XG4gICAgY29uc3Qgd2FpdCA9IGJhY2tvZmZbTWF0aC5taW4oYXR0ZW1wdCwgYmFja29mZi5sZW5ndGggLSAxKV07XG4gICAgYXR0ZW1wdCsrO1xuICAgIHNldFRpbWVvdXQoY29ubmVjdCwgd2FpdCAqIDEwMDApO1xuICB9O1xuICB3cy5vbmVycm9yID0gKCkgPT4ge307XG59XG5cbndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdsb2FkJywgKCkgPT4ge1xuICAkKCd2ZXJzaW9uJykudGV4dENvbnRlbnQgPSAndicgKyBIRUxQRVJfVkVSU0lPTjtcbiAgJCgnZm9yZ2V0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLCAoKSA9PiB2b2lkIGVuZ2luZS5mb3JnZXRQYWlyaW5nKCkpO1xuICBzaG93KHsgc3RhdGU6ICdkaXNjb25uZWN0ZWQnIH0pO1xuICBjb25uZWN0KCk7XG59KTtcbiJdLAogICJtYXBwaW5ncyI6ICI7Ozs7Ozs7Ozs7QUFJQSwyQkFBZ0Y7OztBQ0l6RSxNQUFNLGtCQUFrRjtBQUFBLElBQzdGLEtBQUssRUFBRSxLQUFLLElBQUksV0FBVyxNQUFNO0FBQUEsSUFDakMsS0FBSyxFQUFFLEtBQUssSUFBSSxXQUFXLE1BQU07QUFBQSxJQUNqQyxLQUFLLEVBQUUsS0FBSyxJQUFJLFdBQVcsS0FBSztBQUFBO0FBQUEsSUFDaEMsS0FBSyxFQUFF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
