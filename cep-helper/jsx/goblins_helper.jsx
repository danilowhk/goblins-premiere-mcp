/* Goblins CEP Helper - ExtendScript side (ES3). Written from scratch for Goblins.
 *
 * Only the edits our UXP plugin cannot do on Premiere 26.5.2: razor, speed/reverse, clip volume
 * level, FCP XML import into a bin, and an experimental audio crossfade. Every op:
 *   - checks app.project.path and the sequence id against the request and refuses otherwise,
 *   - touches only the clips/tracks/bin it names (binary search by time, never a project-wide
 *     search or a usage search),
 *   - reads the result back from Premiere after applying and returns
 *     { ok, applied, readBack, undoSteps, warnings, error? } as a JSON string.
 * The Node side (src/) decides nothing about approval: it only runs ops the hub sends after the
 * person approved them in the Goblins UXP panel.
 *
 * Input arrives as a JS object literal produced by JSON.stringify on the Node side.
 * docs/cep-helper.md documents each call, the undo behaviour and the host checks.
 */
var GoblinsCEP = (function () {
  var VERSION = '0.1.0';
  var MAX_SCAN = 200000; // hard bound for any loop over items

  // ---------- JSON out (ExtendScript has no reliable JSON object) ----------
  function q(s) {
    s = String(s);
    var out = '"';
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      var code = s.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 32 || code === 0x2028 || code === 0x2029) {
        var h = code.toString(16);
        while (h.length < 4) h = '0' + h;
        out += '\\u' + h;
      } else out += c;
    }
    return out + '"';
  }
  function enc(v) {
    if (v === null || v === undefined) return 'null';
    var t = typeof v;
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return q(v);
    if (v instanceof Array) {
      var a = [];
      for (var i = 0; i < v.length; i++) a.push(enc(v[i]));
      return '[' + a.join(',') + ']';
    }
    var parts = [];
    for (var k in v) if (v.hasOwnProperty(k)) parts.push(q(k) + ':' + enc(v[k]));
    return '{' + parts.join(',') + '}';
  }

  function Refusal(code, message, detail) {
    this.code = code;
    this.message = message;
    this.detail = detail;
  }
  function refuse(code, message, detail) {
    throw new Refusal(code, message, detail);
  }

  // ---------- tick strings (ticks can exceed 2^53 on 9 h+ sequences) ----------
  function digits(v) {
    var s = String(v);
    if (!/^\d+$/.test(s)) {
      // QE may hand back a Number; render it without exponent.
      var n = Number(v);
      if (!isFinite(n) || n < 0) refuse('bad_time', 'not a tick value: ' + s);
      s = n.toFixed(0);
    }
    s = s.replace(/^0+(?=\d)/, '');
    return s;
  }
  function cmp(a, b) {
    a = digits(a);
    b = digits(b);
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    // No chained ternary here: ExtendScript parses `c ? x : a > b ? 1 : 0` as
    // `((c ? x : a) > b) ? 1 : 0`, so this returned 1 for a < b (BUG-20261109-18).
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  // ---------- guards ----------
  function norm(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
  }
  function checkProject(req) {
    if (!app.project) refuse('no_project', 'No project is open in Premiere.');
    var actual = norm(app.project.path);
    if (!req.projectPath || norm(req.projectPath) !== actual)
      refuse('wrong_project', 'The open project is not the one this edit was approved for.', {
        expected: req.projectPath,
        actual: app.project.path
      });
  }
  function findSequence(id) {
    var seqs = app.project.sequences;
    for (var i = 0; i < seqs.numSequences && i < MAX_SCAN; i++)
      if (String(seqs[i].sequenceID) === String(id)) return seqs[i];
    return null;
  }
  function checkSequence(req, mustBeActive) {
    var seq = findSequence(req.sequenceId);
    if (!seq) refuse('wrong_sequence', 'Sequence not found in this project.');
    if (mustBeActive) {
      var act = app.project.activeSequence;
      if (!act || String(act.sequenceID) !== String(req.sequenceId))
        refuse(
          'wrong_sequence',
          'This edit needs the sequence open and active in the Timeline (QE acts on the active sequence only).',
          { active: act ? act.name : null, wanted: seq.name }
        );
    }
    if (req.sequenceName && seq.name !== req.sequenceName)
      refuse('wrong_sequence', 'Sequence name differs from the approved request.', {
        expected: req.sequenceName,
        actual: seq.name
      });
    return seq;
  }
  function qeSeq() {
    app.enableQE();
    if (typeof qe === 'undefined' || !qe.project)
      refuse('qe_unavailable', 'QE DOM is not available in this Premiere.');
    var s = qe.project.getActiveSequence();
    if (!s) refuse('qe_unavailable', 'QE returned no active sequence.');
    return s;
  }

  // ---------- tracks and clips ----------
  function domTracks(seq, type) {
    return type === 'video' ? seq.videoTracks : seq.audioTracks;
  }
  function domTrack(seq, type, index) {
    var tracks = domTracks(seq, type);
    if (type !== 'video' && type !== 'audio')
      refuse('bad_request', 'trackType must be video or audio');
    if (index < 0 || index >= tracks.numTracks)
      refuse('track_not_found', type + ' track ' + index + ' does not exist');
    return tracks[index];
  }
  function qeTrack(qs, type, index) {
    return type === 'video' ? qs.getVideoTrackAt(index) : qs.getAudioTrackAt(index);
  }
  // Index of the last clip whose start <= t, or -1.
  function lastStartingBefore(clips, t) {
    var lo = 0,
      hi = clips.numItems - 1,
      ans = -1,
      guard = 0;
    while (lo <= hi && guard++ < 64) {
      var mid = (lo + hi) >> 1;
      if (cmp(clips[mid].start.ticks, t) <= 0) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }
  function clipInfo(c, i) {
    return {
      index: i,
      nodeId: String(c.nodeId),
      name: String(c.name),
      start: digits(c.start.ticks),
      end: digits(c.end.ticks),
      inPoint: digits(c.inPoint.ticks),
      outPoint: digits(c.outPoint.ticks)
    };
  }
  // What sits at time t on a track: a clip strictly spanning t, and whether a cut is exactly at t.
  function stateAt(track, t) {
    var clips = track.clips;
    var i = lastStartingBefore(clips, t);
    var r = { spanning: null, cutAt: false };
    if (i < 0) return r;
    var c = clips[i];
    if (cmp(c.start.ticks, t) === 0) {
      r.cutAt = i > 0 && cmp(clips[i - 1].end.ticks, t) === 0;
      r.startsAt = clipInfo(c, i);
    } else if (cmp(c.end.ticks, t) > 0) r.spanning = clipInfo(c, i);
    return r;
  }
  function findClip(seq, a) {
    var track = domTrack(seq, a.trackType, a.trackIndex);
    var clips = track.clips;
    var i = lastStartingBefore(clips, a.clipStart);
    if (i < 0 || cmp(clips[i].start.ticks, a.clipStart) !== 0)
      refuse('clip_not_found', 'No clip starts at the approved time on that track.');
    var c = clips[i];
    if (a.name && String(c.name) !== String(a.name))
      refuse('clip_mismatch', 'The clip at that time is not the approved clip.', {
        expected: a.name,
        actual: String(c.name)
      });
    return { track: track, clip: c, index: i };
  }
  // The QE item for a DOM clip, by binary search on start time (QE lists gaps and transitions too).
  function qeItemAt(qt, t) {
    var lo = 0,
      hi = qt.numItems - 1,
      guard = 0;
    while (lo <= hi && guard++ < 64) {
      var mid = (lo + hi) >> 1;
      var it = qt.getItemAt(mid);
      var c = cmp(it.start.ticks, t);
      if (c === 0) {
        // Neighbours with the same start (a transition, an empty slot) - pick the clip.
        for (var k = Math.max(0, mid - 2); k <= Math.min(qt.numItems - 1, mid + 2); k++) {
          var x = qt.getItemAt(k);
          if (x.type === 'Clip' && cmp(x.start.ticks, t) === 0) return x;
        }
        return null;
      }
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  // ---------- ops ----------
  var ops = {};

  ops.ping = function () {
    return { ok: true, applied: 0, readBack: { version: VERSION, hasProject: !!app.project } };
  };

  ops.info = function (req) {
    checkProject(req);
    var seq = checkSequence(req, false);
    var st = seq.getSettings();
    var act = app.project.activeSequence;
    return {
      ok: true,
      applied: 0,
      readBack: {
        version: VERSION,
        projectPath: app.project.path,
        sequenceId: String(seq.sequenceID),
        sequenceName: seq.name,
        isActive: !!act && String(act.sequenceID) === String(seq.sequenceID),
        timebase: digits(seq.timebase),
        zeroPoint: digits(seq.zeroPoint),
        videoDisplayFormat: Number(st.videoDisplayFormat),
        videoTracks: seq.videoTracks.numTracks,
        audioTracks: seq.audioTracks.numTracks
      }
    };
  };

  function formatted(seq, ticks) {
    var t = new Time();
    t.ticks = String(ticks);
    var st = seq.getSettings();
    return t.getFormatted(st.videoFrameRate, st.videoDisplayFormat);
  }

  ops.razor = function (req) {
    checkProject(req);
    var seq = checkSequence(req, true);
    if (cmp(seq.zeroPoint, 0) !== 0)
      refuse(
        'sequence_start_offset',
        'Sequences with a start timecode other than 0 are not supported yet.'
      );
    var t = digits(req.time);
    // Node snapped t to a frame; the formatted-timecode check below catches a changed timebase.
    var pm = formatted(seq, t);
    if (String(pm) !== String(req.timecode))
      refuse(
        'timecode_mismatch',
        'Premiere formats this time differently from the approved timecode.',
        {
          expected: req.timecode,
          premiere: pm
        }
      );
    var targets = req.tracks; // [{trackType, trackIndex}] or 'all'
    var before = {};
    var all = [];
    var types = ['video', 'audio'];
    for (var ti = 0; ti < 2; ti++) {
      var trs = domTracks(seq, types[ti]);
      for (var i = 0; i < trs.numTracks; i++) {
        var key = types[ti] + i;
        before[key] = stateAt(trs[i], t);
        all.push({ trackType: types[ti], trackIndex: i, key: key });
      }
    }
    var toCut = [];
    var skipped = [];
    if (targets === 'all') {
      targets = [];
      for (var at = 0; at < all.length; at++) {
        var tr0 = domTrack(seq, all[at].trackType, all[at].trackIndex);
        if (before[all[at].key].spanning && !(tr0.isLocked && tr0.isLocked()))
          targets.push({ trackType: all[at].trackType, trackIndex: all[at].trackIndex });
      }
    }
    for (var j = 0; j < targets.length; j++) {
      var tg = targets[j];
      var tr = domTrack(seq, tg.trackType, tg.trackIndex);
      if (tr.isLocked && tr.isLocked())
        refuse('track_locked', tg.trackType + ' track ' + tg.trackIndex + ' is locked.');
      var k2 = tg.trackType + tg.trackIndex;
      if (before[k2].spanning) toCut.push(tg);
      else
        skipped.push({ track: k2, reason: before[k2].cutAt ? 'already_cut' : 'no_clip_at_time' });
    }
    if (!toCut.length)
      refuse('nothing_to_cut', 'No clip spans that time on the approved tracks.', skipped);
    var qs = qeSeq();
    var calls = 0;
    for (var m = 0; m < toCut.length; m++) {
      qeTrack(qs, toCut[m].trackType, toCut[m].trackIndex).razor(
        String(req.timecode),
        !!req.includeLinked,
        true
      );
      calls++;
    }
    // Read back every track: requested ones must now have a cut at t; others must be unchanged.
    var cut = [];
    var missing = [];
    var unexpected = [];
    var wanted = {};
    for (var w = 0; w < toCut.length; w++) wanted[toCut[w].trackType + toCut[w].trackIndex] = true;
    for (var a = 0; a < all.length; a++) {
      var after = stateAt(domTrack(seq, all[a].trackType, all[a].trackIndex), t);
      var was = before[all[a].key];
      if (wanted[all[a].key]) {
        if (after.cutAt)
          cut.push({ track: all[a].key, left: was.spanning.nodeId, right: after.startsAt });
        else missing.push(all[a].key);
      } else if (was.spanning && after.cutAt) unexpected.push(all[a].key);
    }
    var ok = missing.length === 0 && (unexpected.length === 0 || !!req.includeLinked);
    return {
      ok: ok,
      applied: cut.length + (req.includeLinked ? unexpected.length : 0),
      undoSteps: calls,
      readBack: {
        time: t,
        timecode: pm,
        cut: cut,
        notCut: missing,
        alsoCut: unexpected,
        skipped: skipped
      },
      error: ok
        ? undefined
        : {
            code: missing.length ? 'readback_mismatch' : 'unexpected_change',
            message: missing.length
              ? 'Razor did not cut: ' + missing.join(', ')
              : 'Razor also cut tracks that were not approved: ' + unexpected.join(', ')
          }
    };
  };

  function clipSpeedState(c) {
    return {
      nodeId: String(c.nodeId),
      speed: Number(c.getSpeed()),
      reversed: !!c.isSpeedReversed(),
      start: digits(c.start.ticks),
      end: digits(c.end.ticks)
    };
  }

  ops.speed = function (req) {
    checkProject(req);
    var seq = checkSequence(req, true);
    var f = Number(req.speed);
    if (!(f >= 0.05 && f <= 20))
      refuse('bad_request', 'speed must be between 0.05 and 20 (1 = 100%)');
    var found = findClip(seq, req.clip);
    var before = clipSpeedState(found.clip);
    var next =
      found.index + 1 < found.track.clips.numItems ? found.track.clips[found.index + 1] : null;
    var nextBefore = next ? { nodeId: String(next.nodeId), start: digits(next.start.ticks) } : null;
    var qs = qeSeq();
    var item = qeItemAt(qeTrack(qs, req.clip.trackType, req.clip.trackIndex), req.clip.clipStart);
    if (!item) refuse('qe_item_not_found', 'QE could not find the clip at that time.');
    // QETrackItem.setSpeed(speedFactor, '', reverse, maintainPitch?, ripple) - undocumented QE.
    item.setSpeed(f, '', !!req.reverse, false, !!req.ripple);
    var again = findClip(seq, req.clip);
    var after = clipSpeedState(again.clip);
    var problems = [];
    if (Math.abs(Math.abs(after.speed) - f) > 0.001)
      problems.push('speed is ' + after.speed + ', wanted ' + f);
    if (after.reversed !== !!req.reverse) problems.push('reverse is ' + after.reversed);
    var nextAfter = null;
    if (nextBefore) {
      var nidx = again.index + 1;
      var nx = nidx < again.track.clips.numItems ? again.track.clips[nidx] : null;
      nextAfter = nx ? { nodeId: String(nx.nodeId), start: digits(nx.start.ticks) } : null;
      if (!req.ripple && (!nextAfter || nextAfter.start !== nextBefore.start))
        problems.push('the next clip moved although ripple was off');
    }
    return {
      ok: problems.length === 0,
      applied: problems.length === 0 ? 1 : 0,
      undoSteps: 1,
      readBack: { before: before, after: after, nextBefore: nextBefore, nextAfter: nextAfter },
      error: problems.length
        ? { code: 'readback_mismatch', message: problems.join('; ') }
        : undefined
    };
  };

  // Volume > Level is stored as a linear value where 1.0 = +15 dB (Premiere's ceiling).
  function toDb(v) {
    return v > 0 ? (20 * Math.log(v)) / Math.LN10 + 15 : -Infinity;
  }
  function fromDb(db) {
    return Math.pow(10, (db - 15) / 20);
  }
  function volumeParam(clip) {
    var comps = clip.components;
    for (var i = 0; i < comps.numItems; i++) {
      var c = comps[i];
      var mn = String(c.matchName || '');
      if (String(c.displayName) === 'Volume' || (/Volume/.test(mn) && !/Channel/.test(mn))) {
        var props = c.properties;
        for (var p = 0; p < props.numItems; p++)
          if (String(props[p].displayName) === 'Level')
            return { param: props[p], component: c, how: 'name' };
        if (props.numItems === 2) return { param: props[1], component: c, how: 'index1' };
      }
    }
    return null;
  }

  ops.volume = function (req) {
    checkProject(req);
    var seq = checkSequence(req, false);
    if (req.clip.trackType !== 'audio') refuse('bad_request', 'volume needs an audio clip');
    var db = Number(req.levelDb);
    if (!(db >= -60 && db <= 15)) refuse('bad_request', 'levelDb must be between -60 and +15');
    var found = findClip(seq, req.clip);
    var vp = volumeParam(found.clip);
    if (!vp) refuse('no_volume_param', 'This clip has no Volume > Level parameter.');
    var keyed = !!vp.param.isTimeVarying();
    var keys = 0;
    if (keyed) {
      // A stopwatch that is on with no keyframes has nothing to lose, so it is turned off below
      // without asking (BUG-20261109-43). Premiere returns null, not [], from getKeys() when
      // there are none: then findNextKey from 0 decides; if that fails the count is unknown
      // (-1) and the edit is refused like a keyed one.
      var ks = vp.param.getKeys();
      if (ks) keys = ks.length;
      else {
        try {
          var t0 = new Time();
          t0.ticks = '0';
          keys = vp.param.findNextKey(t0) ? -1 : 0;
        } catch (e) {
          keys = -1;
        }
      }
      if (keys !== 0 && !req.clearKeyframes)
        refuse(
          'has_keyframes',
          'Volume > Level has ' +
            (keys < 0 ? 'keyframes' : keys + ' keyframe(s)') +
            '. Setting one value on top of keyframes is what produced the silent failures and +5.6/+14.7 dB jumps; approve "clear keyframes" to replace them.',
          { keyframes: keys }
        );
    }
    var beforeDb = keyed ? null : Math.round(toDb(Number(vp.param.getValue())) * 1000) / 1000;
    var steps = 0;
    if (keyed) {
      vp.param.setTimeVarying(false);
      steps++;
    }
    vp.param.setValue(fromDb(db), 1);
    steps++;
    // Re-find the clip and parameter: never trust the object we wrote through.
    var again = findClip(seq, req.clip);
    var vp2 = volumeParam(again.clip);
    var raw = Number(vp2.param.getValue());
    var afterDb = toDb(raw);
    var stillKeyed = !!vp2.param.isTimeVarying();
    var gain = null;
    try {
      var act = app.project.activeSequence;
      if (act && String(act.sequenceID) === String(seq.sequenceID)) {
        var it = qeItemAt(qeTrack(qeSeq(), 'audio', req.clip.trackIndex), req.clip.clipStart);
        if (it) gain = Number(it.staticClipGain);
      }
    } catch (e) {}
    var off = Math.abs(afterDb - db);
    var problems = [];
    if (!(off <= 0.1))
      problems.push('Level reads ' + afterDb.toFixed(2) + ' dB, wanted ' + db + ' dB');
    if (stillKeyed) problems.push('Level still has keyframes');
    var warnings = [];
    if (db >= 14.99)
      warnings.push(
        '+15 dB is the ceiling and is saved in the .prproj with no value; readers that treat a missing value as 0 dB are off by 15 dB.'
      );
    return {
      ok: problems.length === 0,
      applied: problems.length === 0 ? 1 : 0,
      undoSteps: steps,
      warnings: warnings,
      readBack: {
        beforeDb: beforeDb,
        hadKeyframes: keys,
        afterDb: Math.round(afterDb * 1000) / 1000,
        rawValue: raw,
        stillKeyframed: stillKeyed,
        paramFoundBy: vp2.how,
        audioGainStatic: gain
      },
      error: problems.length
        ? { code: 'readback_mismatch', message: problems.join('; ') }
        : undefined
    };
  };

  function binByPath(path) {
    var cur = app.project.rootItem;
    for (var i = 0; i < path.length; i++) {
      var next = null;
      var ch = cur.children;
      for (var j = 0; j < ch.numItems && j < MAX_SCAN; j++)
        if (ch[j].type === ProjectItemType.BIN && ch[j].name === path[i]) {
          if (next) refuse('bin_ambiguous', 'Two bins named "' + path[i] + '" at the same level.');
          next = ch[j];
        }
      if (!next)
        refuse('bin_not_found', 'Bin "' + path.slice(0, i + 1).join(' / ') + '" not found.');
      cur = next;
    }
    return cur;
  }
  function binListing(bin) {
    var out = {};
    var ch = bin.children;
    for (var j = 0; j < ch.numItems && j < MAX_SCAN; j++)
      out[String(ch[j].nodeId)] = { name: String(ch[j].name), type: Number(ch[j].type) };
    return out;
  }
  function sequenceIds() {
    var out = {};
    var s = app.project.sequences;
    for (var i = 0; i < s.numSequences && i < MAX_SCAN; i++)
      out[String(s[i].sequenceID)] = String(s[i].name);
    return out;
  }

  ops.binContents = function (req) {
    checkProject(req);
    var bin = binByPath(req.binPath);
    return {
      ok: true,
      applied: 0,
      readBack: { nodeId: String(bin.nodeId), items: binListing(bin) }
    };
  };

  ops.importXml = function (req) {
    checkProject(req);
    var f = new File(req.xmlPath);
    if (!f.exists) refuse('file_not_found', 'XML file not found: ' + req.xmlPath);
    var bin = binByPath(req.binPath);
    if (req.binNodeId && String(bin.nodeId) !== String(req.binNodeId))
      refuse('bin_mismatch', 'The bin at that path is not the approved bin.');
    var beforeItems = binListing(bin);
    var beforeSeqs = sequenceIds();
    if (req.refuseIfNamePresent) {
      for (var k in beforeItems)
        if (beforeItems.hasOwnProperty(k) && beforeItems[k].name === req.refuseIfNamePresent)
          refuse('already_imported', 'The bin already has "' + req.refuseIfNamePresent + '".');
    }
    var res = app.project.importFiles([f.fsName], true, bin, false);
    var afterItems = binListing(bin);
    var afterSeqs = sequenceIds();
    var newItems = [];
    for (var a in afterItems)
      if (afterItems.hasOwnProperty(a) && !beforeItems.hasOwnProperty(a))
        newItems.push({ nodeId: a, name: afterItems[a].name, type: afterItems[a].type });
    var newSeqs = [];
    for (var s in afterSeqs)
      if (afterSeqs.hasOwnProperty(s) && !beforeSeqs.hasOwnProperty(s))
        newSeqs.push({ id: s, name: afterSeqs[s] });
    var ok = newItems.length > 0;
    return {
      ok: ok,
      applied: newItems.length,
      undoSteps: 1,
      readBack: {
        importReturned: !!res,
        newItems: newItems,
        newSequences: newSeqs,
        binNodeId: String(bin.nodeId)
      },
      warnings:
        newSeqs.length === 0 ? ['No new sequence appeared; the XML may hold media only.'] : [],
      error: ok
        ? undefined
        : { code: 'nothing_imported', message: 'Import returned but the bin has no new items.' }
    };
  };

  // Experimental: an audio crossfade centred on the cut between two adjacent clips.
  ops.crossfade = function (req) {
    checkProject(req);
    var seq = checkSequence(req, true);
    var track = domTrack(seq, 'audio', req.trackIndex);
    var t = digits(req.cutTime);
    var st = stateAt(track, t);
    if (!st.cutAt) refuse('no_cut', 'There is no cut between two adjacent clips at that time.');
    var left = track.clips[st.startsAt.index - 1];
    var countBefore = track.transitions ? track.transitions.numItems : -1;
    var qs = qeSeq();
    var item = qeItemAt(qeTrack(qs, 'audio', req.trackIndex), left.start.ticks);
    if (!item) refuse('qe_item_not_found', 'QE could not find the left clip.');
    var tr = qe.project.getAudioTransitionByName(req.transitionName || 'Constant Power');
    if (!tr) refuse('transition_not_found', 'Audio transition not found: ' + req.transitionName);
    item.addTransition(tr, false, String(req.durationTimecode), '00:00:00:00', 0.5, false, true);
    var t2 = domTrack(seq, 'audio', req.trackIndex).transitions;
    var found = null;
    for (var i = 0; t2 && i < t2.numItems && i < MAX_SCAN; i++)
      if (cmp(t2[i].start.ticks, t) <= 0 && cmp(t2[i].end.ticks, t) >= 0)
        found = { start: digits(t2[i].start.ticks), end: digits(t2[i].end.ticks) };
    return {
      ok: !!found,
      applied: found ? 1 : 0,
      undoSteps: 1,
      readBack: {
        transitionsBefore: countBefore,
        transitionsAfter: t2 ? t2.numItems : -1,
        atCut: found
      },
      error: found
        ? undefined
        : { code: 'readback_mismatch', message: 'No transition spans the cut after applying.' }
    };
  };

  // Read-only host research: which methods QE exposes on a clip in this Premiere build.
  ops.probe = function (req) {
    checkProject(req);
    var seq = checkSequence(req, true);
    var found = findClip(seq, req.clip);
    var it = qeItemAt(
      qeTrack(qeSeq(), req.clip.trackType, req.clip.trackIndex),
      found.clip.start.ticks
    );
    var methods = [];
    if (it && it.reflect)
      for (var i = 0; i < it.reflect.methods.length; i++)
        methods.push(String(it.reflect.methods[i].name));
    return {
      ok: true,
      applied: 0,
      readBack: { qeType: it ? String(it.type) : null, methods: methods }
    };
  };

  function run(name, req) {
    var t0 = new Date().getTime();
    var out;
    try {
      if (!ops.hasOwnProperty(name)) refuse('unknown_op', 'Unknown op: ' + name);
      out = ops[name](req || {});
    } catch (e) {
      if (e instanceof Refusal)
        out = {
          ok: false,
          applied: 0,
          refused: true,
          error: { code: e.code, message: e.message, detail: e.detail }
        };
      else
        out = {
          ok: false,
          applied: 0,
          error: {
            code: 'script_error',
            message: String(e && e.message ? e.message : e),
            line: e && e.line
          }
        };
    }
    out.op = name;
    out.ms = new Date().getTime() - t0;
    return enc(out);
  }

  return { run: run, version: VERSION };
})();
