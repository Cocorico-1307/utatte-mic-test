
  // ★公開前に、先生ページに表示されたGASウェブアプリURL（/execで終わるもの）へ置き換えます。
  const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbz-OJ66nAeT_79QMYl6cybkNrBP7O9qzXHHrk5HcVzTvWgVUcHubhLjwaDsqJPEbE8hzg/exec';

  let apiUrl = '';
  let songs = [];
  let selectedSong = null;
  let audioContext = null;
  let analyser = null;
  let micStream = null;
  let timeData = null;
  let animationId = null;
  let songStartPerf = 0;
  let isRunning = false;
  let lastPitchCheck = 0;
  let currentPitch = null;
  let currentRms = 0;
  let stats = [];
  let guideNodes = [];
  let classroomPaused = false;
  let classroomStatusTimer = null;
  let currentLessonCode = '';
  let pendingSaveRequestId = '';
  let lastCanvasWidth = 0;
  let lastCanvasHeight = 0;

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('resize', resizeCanvas);

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'utatte-score-save') return;
    if (!pendingSaveRequestId || data.requestId !== pendingSaveRequestId) return;

    pendingSaveRequestId = '';
    const saveStatus = document.getElementById('saveStatus');
    if (data.ok) {
      saveStatus.textContent = '✅ スプレッドシートに記録しました。';
      saveStatus.className = 'status success';
    } else {
      saveStatus.textContent = '❌ 記録できませんでした：' + (data.message || '先生に確認してください。');
      saveStatus.className = 'status error';
    }
  });

  function init() {
    setupSchoolSelectors();

    const jsStatus = document.getElementById('jsStatus');
    if (jsStatus) {
      jsStatus.textContent = '準備OK';
      jsStatus.className = 'small success';
    }

    document.getElementById('loadLessonButton')?.addEventListener('click', loadSongs);
    document.getElementById('songSelect')?.addEventListener('change', onSongChange);
    document.getElementById('startButton')?.addEventListener('click', startGame);
    document.getElementById('stopButton')?.addEventListener('click', () => stopGame(true));
    document.getElementById('retryButton')?.addEventListener('click', startGame);

    const guideVolume = document.getElementById('guideVolume');
    const guideVolumeValue = document.getElementById('guideVolumeValue');
    if (guideVolume && guideVolumeValue) {
      const syncGuideVolumeLabel = () => {
        guideVolumeValue.value = guideVolume.value;
        guideVolumeValue.textContent = guideVolume.value;
      };
      guideVolume.addEventListener('input', syncGuideVolumeLabel);
      syncGuideVolumeLabel();
    }

    apiUrl = normalizeApiUrl(DEFAULT_API_URL);
    currentLessonCode = normalizeLessonCode(sessionStorage.getItem('singScoreLessonCode') || '');
    document.getElementById('lessonCode').value = currentLessonCode;

    resizeCanvas();
    drawIdleCanvas();

    if (!apiUrl) {
      setStatus('先生の初回設定がまだ終わっていません。GASウェブアプリURLをindex.htmlへ設定してください。', 'error');
      document.getElementById('loadLessonButton').disabled = true;
      return;
    }

    if (currentLessonCode) {
      loadSongs();
    } else {
      setStatus('先生から聞いた利用コードを入力して「教材を読み込む」を押してください。');
    }
  }

  function normalizeApiUrl(value) {
    const raw = String(value || '').trim();
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') return '';
      if (url.hostname !== 'script.google.com') return '';

      const path = url.pathname;
      const isGasWebApp =
        path.endsWith('/exec') &&
        path.includes('/macros/') &&
        path.includes('/s/');

      if (!isGasWebApp) return '';

      url.search = '';
      url.hash = '';
      return url.toString();
    } catch (_) {
      return '';
    }
  }

  function normalizeLessonCode(value) {
    // 児童用利用コードは数字8桁だけ。
    return String(value || '').replace(/\D/g, '').slice(0, 8);
  }

  function jsonp(params) {
    return new Promise((resolve, reject) => {
      const callbackName = '__singScoreCb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      const timeout = setTimeout(() => cleanup(new Error('通信がタイムアウトしました。')), 12000);

      function cleanup(error, data) {
        clearTimeout(timeout);
        delete window[callbackName];
        script.remove();
        error ? reject(error) : resolve(data);
      }

      window[callbackName] = data => cleanup(null, data);
      script.onerror = () => cleanup(new Error('GASとの通信に失敗しました。'));
      const url = new URL(apiUrl);
      Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
      url.searchParams.set('callback', callbackName);
      url.searchParams.set('_', Date.now());
      script.src = url.toString();
      document.head.appendChild(script);
    });
  }

  async function loadSongs() {
    const select = document.getElementById('songSelect');
    const message = document.getElementById('lessonMessage');
    currentLessonCode = normalizeLessonCode(document.getElementById('lessonCode').value);
    if (!currentLessonCode) {
      message.textContent = '利用コードを入力してください。';
      message.className = 'small error';
      return;
    }

    sessionStorage.setItem('singScoreLessonCode', currentLessonCode);
    select.disabled = true;
    select.innerHTML = '<option>読み込み中…</option>';
    document.getElementById('startButton').disabled = true;
    message.textContent = '確認中…';
    message.className = 'small muted';

    try {
      const data = await jsonp({
        action: 'songs',
        lessonCode: currentLessonCode,
      });
      if (!data?.ok) throw new Error(data?.message || '教材を読み込めませんでした。');
      songs = Array.isArray(data.songs) ? data.songs : [];
      document.getElementById('appTitle').textContent = data.appName || 'うたってスコア！';
      applyClassroomPaused(Boolean(data.classroomPaused));
      select.innerHTML = '';
      select.disabled = false;

      if (!songs.length) {
        select.innerHTML = '<option>公開中の曲がありません</option>';
        selectedSong = null;
        drawIdleCanvas();
        message.textContent = '利用コードは確認できました。公開中の曲はありません。';
        message.className = 'small muted';
        return;
      }

      songs.forEach(song => {
        const option = document.createElement('option');
        option.value = song.songId;
        option.textContent = song.artist ? `${song.title}（${song.artist}）` : song.title;
        select.appendChild(option);
      });

      message.textContent = '利用コードOK';
      message.className = 'small success';
      onSongChange();
      startClassroomStatusPolling();
    } catch (err) {
      songs = [];
      selectedSong = null;
      select.disabled = true;
      select.innerHTML = '<option>利用コードを確認してください</option>';
      document.getElementById('startButton').disabled = true;
      message.textContent = err.message || '読み込みに失敗しました。';
      message.className = 'small error';
      setStatus('利用コードを確認してください。', 'error');
    }
  }

  function startClassroomStatusPolling() {
    if (classroomStatusTimer) clearInterval(classroomStatusTimer);
    if (!apiUrl) return;
    checkClassroomStatus();
    classroomStatusTimer = setInterval(checkClassroomStatus, 6000);
  }

  async function checkClassroomStatus() {
    if (!apiUrl || !currentLessonCode) return;
    try {
      const data = await jsonp({
        action: 'status',
        lessonCode: currentLessonCode,
      });
      if (!data?.ok) return;
      if (!data.lessonOpen) {
        songs = [];
        selectedSong = null;
        document.getElementById('songSelect').disabled = true;
        document.getElementById('startButton').disabled = true;
        document.getElementById('lessonMessage').textContent = '利用コードが無効になりました。';
        document.getElementById('lessonMessage').className = 'small error';
        setStatus('先生に利用コードを確認してください。', 'error');
        return;
      }
      applyClassroomPaused(Boolean(data.classroomPaused));
    } catch (_) {
      // 一時的な通信失敗では歌唱中の画面を強制終了しません。
    }
  }

  function applyClassroomPaused(paused) {
    classroomPaused = Boolean(paused);
    const overlay = document.getElementById('classroomPauseOverlay');
    const startButton = document.getElementById('startButton');
    overlay.classList.toggle('hidden', !classroomPaused);
    if (classroomPaused) {
      if (isRunning) {
        stopGame(false).finally(() => {
          startButton.disabled = true;
          setStatus('先生が児童ページを停止しています。');
        });
      } else {
        startButton.disabled = true;
        setStatus('先生が児童ページを停止しています。');
      }
    } else if (!isRunning) {
      startButton.disabled = !(selectedSong && currentLessonCode);
      if (selectedSong) setStatus('スタートすると、はじめの音のあとにカウントが鳴ります。');
    }
  }

  function onSongChange() {
    const id = document.getElementById('songSelect').value;
    selectedSong = songs.find(song => song.songId === id) || null;
    document.getElementById('resultCard').classList.add('hidden');
    document.getElementById('saveStatus').textContent = '記録はまだ送信していません。';
    document.getElementById('saveStatus').className = 'status muted';
    prepareLyrics(0);
    drawIdleCanvas();
    const firstNote = selectedSong?.notes?.find(note => note.midi != null);
    document.getElementById('targetNote').textContent = firstNote ? midiToJapaneseNoteName(firstNote.midi) : '―';
    document.getElementById('startButton').disabled = classroomPaused || !selectedSong || !currentLessonCode;
    if (selectedSong) setStatus('スタートすると、はじめの音のあとにカウントが鳴ります。');
  }

  function setupSchoolSelectors() {
    const attendance = document.getElementById('attendanceNumber');
    attendance.innerHTML = '';
    for (let number = 1; number <= 35; number++) {
      const option = document.createElement('option');
      option.value = number;
      option.textContent = number + '番';
      attendance.appendChild(option);
    }

    document.getElementById('gradeSelect').value =
      sessionStorage.getItem('singScoreGrade') || '3';
    document.getElementById('classSelect').value =
      sessionStorage.getItem('singScoreClass') || '1';
    const savedAttendance = sessionStorage.getItem('singScoreAttendance');
    attendance.value = /^([1-9]|[12][0-9]|3[0-5])$/.test(savedAttendance || '') ? savedAttendance : '1';

    ['gradeSelect', 'classSelect', 'attendanceNumber'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => {
        sessionStorage.setItem('singScoreGrade', document.getElementById('gradeSelect').value);
        sessionStorage.setItem('singScoreClass', document.getElementById('classSelect').value);
        sessionStorage.setItem('singScoreAttendance', document.getElementById('attendanceNumber').value);
        // ランキングは全学年共通なので、学年・組を変えても内容は変わりません。
      });
    });
  }

  async function getMicrophoneStream() {
    // Chromebookではマイク入力が小さいことがあるため、
    // 自動ゲインを有効にして歌声を拾いやすくします。
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
        },
        video: false,
      });
    } catch (err) {
      // 端末が細かい制約に対応していない場合は標準設定で再試行。
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
  }

  async function startGame() {
    if (classroomPaused) {
      alert('先生が児童ページを停止しています。再開されるまで待ってください。');
      return;
    }
    if (!currentLessonCode) {
      alert('利用コードを入力して教材を読み込んでください。');
      return;
    }
    if (!selectedSong) {
      alert('曲を選んでください。');
      return;
    }
    const grade = Number(document.getElementById('gradeSelect').value);
    const classNumber = Number(document.getElementById('classSelect').value);
    const attendanceNumber = Number(document.getElementById('attendanceNumber').value);
    if (grade < 3 || grade > 6 || classNumber < 1 || classNumber > 3 ||
        attendanceNumber < 1 || attendanceNumber > 35) {
      alert('学年・組・出席番号を選んでください。');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('このブラウザはマイク入力に対応していません。ChromeまたはEdgeで開いてください。');
      return;
    }

    await stopGame(false);
    document.getElementById('resultCard').classList.add('hidden');
    document.getElementById('startButton').disabled = true;
    setStatus('マイクを準備しています…');

    try {
      micStream = await getMicrophoneStream();

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      timeData = new Float32Array(analyser.fftSize);

      stats = selectedSong.notes.map(note => ({
        totalSamples: 0,
        voicedSamples: 0,
        pitchQualitySum: 0,
        centsSum: 0,
        centsSquareSum: 0,
        pitchSampleCount: 0,
        excellentSamples: 0,
        firstVoiceAt: null,
        midi: note.midi,
      }));

      document.getElementById('stopButton').classList.remove('hidden');
      await showStartingNote();
      if (!audioContext) return;
      const savedCount = Number(selectedSong.countIn);
      const countBeats = Number.isFinite(savedCount) ? savedCount : 4;
      await runCountIn(countBeats, Number(selectedSong.bpm || 100));
      if (!audioContext) return;

      const synchronizedStartDelayMs = 80;
      const synchronizedAudioStart = audioContext.currentTime + synchronizedStartDelayMs / 1000;

      isRunning = true;
      songStartPerf = performance.now() + synchronizedStartDelayMs;
      lastPitchCheck = 0;
      currentPitch = null;
      currentRms = 0;

      if (document.getElementById('guideTone').checked) {
        scheduleGuideMelody(synchronizedAudioStart);
      }

      setStatus('ガイドメロディーに合わせて、うたってください！');
      animate();
    } catch (err) {
      await releaseAudio();
      document.getElementById('startButton').disabled = false;
      document.getElementById('stopButton').classList.add('hidden');
      setStatus('マイクを使えませんでした。ブラウザのマイク許可を確認してください。', 'error');
      console.error(err);
    }
  }

  async function showStartingNote() {
    const firstNote = selectedSong?.notes?.find(note => note.midi != null);
    if (!firstNote || !audioContext) return;

    setCountdownDisplay({
      label: 'はじめの音',
      main: midiToJapaneseNoteName(firstNote.midi),
      sub: `${midiToNoteName(firstNote.midi)}　よく聴いてね`,
      noteMode: true,
      beatCount: 0,
      activeBeat: 0,
    });
    setStatus(`はじめの音は ${midiToJapaneseNoteName(firstNote.midi)} です`);
    playReferenceTone(firstNote.midi, 1.15);
    await sleep(1550);
  }

  async function runCountIn(beats, bpm) {
    const count = Math.max(0, Math.min(8, Math.round(Number(beats) || 0)));
    if (!count || !audioContext) {
      hideCountdown();
      return;
    }

    const safeBpm = Math.max(30, Math.min(300, Number(bpm) || 100));
    const beatMs = 60000 / safeBpm;
    setStatus('カウントをよく聴いてね');

    for (let i = 1; i <= count; i++) {
      setCountdownDisplay({
        label: 'カウント',
        main: String(i),
        sub: i === count ? 'つぎから歌います' : '拍に合わせて準備しよう',
        noteMode: false,
        beatCount: count,
        activeBeat: i,
      });
      playCountClick(i === 1);
      await sleep(beatMs);
      if (!audioContext) return;
    }

    setCountdownDisplay({
      label: '',
      main: 'スタート！',
      sub: '',
      noteMode: true,
      beatCount: 0,
      activeBeat: 0,
    });
    hideCountdown();
  }

  function setCountdownDisplay({ label, main, sub, noteMode, beatCount, activeBeat }) {
    const overlay = document.getElementById('countdown');
    const mainElement = document.getElementById('countdownMain');
    document.getElementById('countdownLabel').textContent = label || '';
    mainElement.textContent = main || '';
    mainElement.classList.toggle('note-name', Boolean(noteMode));
    document.getElementById('countdownSub').textContent = sub || '';

    const beatRow = document.getElementById('countdownBeats');
    beatRow.innerHTML = '';
    for (let i = 1; i <= Number(beatCount || 0); i++) {
      const circle = document.createElement('span');
      circle.textContent = i;
      if (i < activeBeat) circle.className = 'done';
      if (i === activeBeat) circle.className = 'active';
      beatRow.appendChild(circle);
    }
    overlay.classList.remove('hidden');
  }

  function hideCountdown() {
    document.getElementById('countdown').classList.add('hidden');
  }

  function animate(now = performance.now()) {
    if (!isRunning || !selectedSong) return;
    const elapsed = (now - songStartPerf) / 1000;
    const duration = getSongDuration(selectedSong);

    if (now - lastPitchCheck >= 45) {
      analyser.getFloatTimeDomainData(timeData);
      const result = autoCorrelate(timeData, audioContext.sampleRate);
      currentPitch = result.frequency;
      currentRms = result.rms;
      lastPitchCheck = now;
      collectScoreSample(elapsed, currentPitch);
    }

    drawPitchCanvas(elapsed);
    prepareLyrics(elapsed);
    updateHud(elapsed, duration);

    if (elapsed >= duration + 0.15) {
      finishGame();
      return;
    }
    animationId = requestAnimationFrame(animate);
  }

  function collectScoreSample(elapsed, frequency) {
    const index = findActiveNoteIndex(elapsed);
    if (index < 0) return;
    const note = selectedSong.notes[index];
    if (note.midi == null) return;
    const stat = stats[index];
    stat.totalSamples++;
    if (!frequency) return;

    stat.voicedSamples++;
    if (stat.firstVoiceAt == null) stat.firstVoiceAt = elapsed;
    const targetFreq = midiToFrequency(note.midi);
    const signedCents = Math.max(-300, Math.min(300, 1200 * Math.log2(frequency / targetFreq)));
    const cents = Math.abs(signedCents);
    const quality = pitchQuality(cents);
    stat.pitchQualitySum += quality;
    stat.centsSum += signedCents;
    stat.centsSquareSum += signedCents * signedCents;
    stat.pitchSampleCount++;
    if (cents <= 50) stat.excellentSamples++;
  }

  function pitchQuality(cents) {
    if (cents <= 25) return 1;
    if (cents <= 50) return .88;
    if (cents <= 100) return .58;
    if (cents <= 200) return .22;
    return 0;
  }

  async function finishGame() {
    isRunning = false;
    cancelAnimationFrame(animationId);
    const result = calculateResults();
    showResult(result);

    // 音価どおりのガイドを使った場合も採点結果を保存します。
    submitScore(result);

    await releaseAudio();
    document.getElementById('startButton').disabled = classroomPaused || !selectedSong || !currentLessonCode;
    document.getElementById('stopButton').classList.add('hidden');
    setStatus('採点が終わりました！');
  }

  function calculateResults() {
    const noteStats = stats
      .map((stat, index) => ({ stat, note: selectedSong.notes[index] }))
      .filter(item => item.note.midi != null);

    const details = noteStats.map(({ stat, note }) => {
      const pitch = stat.voicedSamples ? stat.pitchQualitySum / stat.voicedSamples : 0;
      const onset = stat.firstVoiceAt == null
        ? 0
        : Math.max(0, 1 - Math.abs(stat.firstVoiceAt - note.start) / 0.38);
      const sustain = stat.totalSamples
        ? Math.min(1, (stat.voicedSamples / stat.totalSamples) * 1.08)
        : 0;
      const rhythm = onset * 0.65 + sustain * 0.35;

      let stability = 0;
      if (stat.pitchSampleCount >= 2) {
        const mean = stat.centsSum / stat.pitchSampleCount;
        const variance = Math.max(
          0,
          stat.centsSquareSum / stat.pitchSampleCount - mean * mean
        );
        const deviation = Math.sqrt(variance);
        stability = Math.max(0, Math.min(1, 1 - deviation / 105));
      } else if (stat.pitchSampleCount === 1) {
        stability = 0.45;
      }

      return {
        pitch,
        rhythm,
        sustain,
        stability,
        duration: Number(note.duration || 0),
      };
    });

    const longDetails = details.filter(detail => detail.duration >= 0.8);
    const longToneSource = longDetails.length ? longDetails : details;
    const longToneValues = longToneSource.map(detail =>
      detail.sustain * 0.65 + detail.pitch * 0.35
    );

    const totalSamples = noteStats.reduce((sum, item) => sum + item.stat.totalSamples, 0);
    const voicedSamples = noteStats.reduce((sum, item) => sum + item.stat.voicedSamples, 0);
    const singingQuality = totalSamples
      ? Math.min(1, (voicedSamples / totalSamples) * 1.08)
      : 0;

    const pitchScore = roundScore(100 * average(details.map(detail => detail.pitch)));
    const rhythmScore = roundScore(100 * average(details.map(detail => detail.rhythm)));
    const stabilityScore = roundScore(100 * average(details.map(detail => detail.stability)));
    const longToneScore = roundScore(100 * average(longToneValues));
    const singingScore = roundScore(100 * singingQuality);
    const totalScore = roundScore(
      pitchScore * 0.45 +
      rhythmScore * 0.25 +
      stabilityScore * 0.15 +
      longToneScore * 0.10 +
      singingScore * 0.05
    );

    let combo = 0;
    let maxCombo = 0;
    let excellentNoteCount = 0;
    details.forEach(detail => {
      const hit = detail.pitch >= 0.72 && detail.rhythm >= 0.62 && detail.sustain >= 0.48;
      if (hit) {
        combo++;
        maxCombo = Math.max(maxCombo, combo);
      } else {
        combo = 0;
      }
      if (detail.pitch >= 0.9 && detail.rhythm >= 0.75) excellentNoteCount++;
    });

    return {
      pitchScore,
      rhythmScore,
      stabilityScore,
      longToneScore,
      singingScore,
      totalScore,
      maxCombo,
      excellentNoteCount,
      noteCount: noteStats.length,
      rankLabel: getScoreRank(totalScore),
    };
  }

  function showResult(result) {
    const card = document.getElementById('resultCard');
    card.classList.remove('hidden');

    animateScoreRing(result.totalScore);
    animateResultNumber(result.totalScore);

    document.getElementById('rankBadge').textContent = result.rankLabel;
    document.getElementById('resultTitle').textContent = getResultTitle(result.totalScore);
    document.getElementById('resultComment').textContent = getResultComment(result);

    setResultMetric('pitch', result.pitchScore);
    setResultMetric('rhythm', result.rhythmScore);
    setResultMetric('stability', result.stabilityScore);
    setResultMetric('longTone', result.longToneScore);
    setResultMetric('singing', result.singingScore);

    document.getElementById('excellentNotes').textContent = result.excellentNoteCount;
    document.getElementById('maxCombo').textContent = result.maxCombo;
    document.getElementById('judgedNotes').textContent = result.noteCount;
    document.getElementById('resultTip').textContent = getPracticeTip(result);

    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setResultMetric(prefix, score) {
    const resultId = prefix + 'Result';
    const barId = prefix + 'Bar';
    document.getElementById(resultId).textContent = formatScore(score);
    const bar = document.getElementById(barId);
    bar.style.width = '0%';
    requestAnimationFrame(() => {
      bar.style.width = `${Math.max(0, Math.min(100, Number(score) || 0))}%`;
    });
  }

  function animateScoreRing(target) {
    const ring = document.getElementById('scoreRing');
    const startedAt = performance.now();
    const duration = 1000;
    const targetAngle = Math.max(0, Math.min(360, Number(target || 0) * 3.6));
    function tick(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      ring.style.setProperty('--score-angle', `${targetAngle * eased}deg`);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function animateResultNumber(target) {
    const element = document.getElementById('totalResult');
    const startedAt = performance.now();
    const duration = 1000;
    function tick(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatScore(target * eased);
      if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function getScoreRank(score) {
    const value = Number(score || 0);
    if (value >= 98) return 'SSS';
    if (value >= 95) return 'SS';
    if (value >= 90) return 'S';
    if (value >= 80) return 'A';
    if (value >= 70) return 'B';
    if (value >= 60) return 'C';
    return 'D';
  }

  function getResultTitle(score) {
    if (score >= 98) return '奇跡のハーモニー！';
    if (score >= 95) return '圧巻の歌声！';
    if (score >= 90) return 'すばらしい歌唱！';
    if (score >= 80) return 'とてもいい歌声！';
    if (score >= 70) return 'いい調子です！';
    if (score >= 60) return 'しっかり歌えました！';
    return 'ここから伸びます！';
  }

  function getResultComment(result) {
    if (result.totalScore >= 90) {
      return `ぴったり音符 ${result.excellentNoteCount}音、最大 ${result.maxCombo}コンボ！`;
    }
    if (result.totalScore >= 75) {
      return '音程バーをよく見ながら、最後まで安定して歌えました。';
    }
    if (result.totalScore >= 55) {
      return '歌い始めの音と拍を意識すると、さらに点数が上がりそうです。';
    }
    return 'まずは小さな声でも大丈夫。はじめの音をよく聴いて歌ってみよう。';
  }

  function getPracticeTip(result) {
    const metrics = [
      { label: '音程', value: result.pitchScore, tip: '目標の音程バーの中央をねらって、声をゆっくり動かしてみよう。' },
      { label: 'リズム', value: result.rhythmScore, tip: '歌詞の最初を、カウントや音程バーの左端に合わせてみよう。' },
      { label: '安定感', value: result.stabilityScore, tip: '息を一定に流し、声を揺らしすぎないように伸ばしてみよう。' },
      { label: 'ロングトーン', value: result.longToneScore, tip: '伸ばす音を途中で切らず、最後まで同じ声で保ってみよう。' },
      { label: '歌唱率', value: result.singingScore, tip: '休符以外は声を途切れさせず、歌詞の最後まで歌ってみよう。' },
    ];
    metrics.sort((a, b) => a.value - b.value);
    return `次のチャレンジ：${metrics[0].label}アップ！ ${metrics[0].tip}`;
  }

  function roundScore(value) {
    return Math.round(Math.max(0, Math.min(100, Number(value) || 0)) * 10) / 10;
  }

  function formatScore(value) {
    return Number(value || 0).toFixed(1);
  }

  function submitScore(result) {
    const requestId = (crypto.randomUUID ? crypto.randomUUID() :
      'req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    pendingSaveRequestId = requestId;

    const saveStatus = document.getElementById('saveStatus');
    saveStatus.textContent = '記録を保存しています…';
    saveStatus.className = 'status muted';

    const form = document.createElement('form');
    form.method = 'POST';
    form.action = apiUrl;
    form.target = 'scoreSink';
    form.className = 'hidden';

    const fields = {
      action: 'saveScore',
      requestId,
      lessonCode: currentLessonCode,
      songId: selectedSong.songId,
      grade: document.getElementById('gradeSelect').value,
      classNumber: document.getElementById('classSelect').value,
      attendanceNumber: document.getElementById('attendanceNumber').value,
      pitchScore: result.pitchScore,
      rhythmScore: result.rhythmScore,
      stabilityScore: result.stabilityScore,
      longToneScore: result.longToneScore,
      singingScore: result.singingScore,
      totalScore: result.totalScore,
      maxCombo: result.maxCombo,
      excellentNoteCount: result.excellentNoteCount,
      noteCount: result.noteCount,
    };

    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    });

    document.body.appendChild(form);
    form.submit();
    setTimeout(() => form.remove(), 2500);

    setTimeout(() => {
      if (pendingSaveRequestId === requestId) {
        saveStatus.textContent = '保存確認に時間がかかっています。先生ページで記録を確認してください。';
        saveStatus.className = 'status muted';
      }
    }, 8000);
  }

  async function stopGame(showMessage) {
    isRunning = false;
    cancelAnimationFrame(animationId);
    hideCountdown();
    await releaseAudio();
    document.getElementById('startButton').disabled = classroomPaused || !selectedSong || !currentLessonCode;
    document.getElementById('stopButton').classList.add('hidden');
    if (showMessage) setStatus(classroomPaused ? '先生が児童ページを停止しています。' : '途中で終了しました。');
  }

  async function releaseAudio() {
    guideNodes.forEach(node => {
      try { node.stop(); } catch (_) {}
    });
    guideNodes = [];
    if (micStream) micStream.getTracks().forEach(track => track.stop());
    micStream = null;
    analyser = null;
    timeData = null;
    if (audioContext) {
      try { await audioContext.close(); } catch (_) {}
    }
    audioContext = null;
  }

  function scheduleGuideMelody(startAt = audioContext.currentTime + .08) {
    const volumeStep = Math.max(1, Math.min(10, Number(document.getElementById('guideVolume')?.value || 4)));
    const peakGain = 0.025 + volumeStep * 0.018;

    selectedSong.notes.forEach(note => {
      if (note.midi == null) return;

      const noteStart = startAt + Number(note.start || 0);
      // 見本の音は、先生が入力した音価の長さだけしっかり鳴らします。
      const soundingDuration = Math.max(0.06, Number(note.duration || 0.25));
      const noteEnd = noteStart + soundingDuration;
      const attackEnd = noteStart + Math.min(0.025, soundingDuration * 0.25);
      const releaseStart = Math.max(attackEnd, noteEnd - Math.min(0.06, soundingDuration * 0.35));

      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(midiToFrequency(note.midi), noteStart);
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.linearRampToValueAtTime(peakGain, attackEnd);
      gain.gain.setValueAtTime(peakGain, releaseStart);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteEnd);
      osc.connect(gain).connect(audioContext.destination);
      osc.start(noteStart);
      osc.stop(noteEnd + 0.03);
      guideNodes.push(osc);
    });
  }

  function playReferenceTone(midi, duration) {
    if (!audioContext) return;
    const now = audioContext.currentTime;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.value = midiToFrequency(midi);
    gain.gain.setValueAtTime(.001, now);
    gain.gain.linearRampToValueAtTime(.18, now + .05);
    gain.gain.setValueAtTime(.18, now + Math.max(.08, duration - .12));
    gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    osc.connect(gain).connect(audioContext.destination);
    osc.start(now);
    osc.stop(now + duration + .03);
  }

  function playCountClick(accent = false) {
    if (!audioContext) return;

    // 特定の音高を持たない短いノイズクリック。
    // 「はじめの音」の音程記憶を邪魔しにくいカウントです。
    const duration = accent ? 0.075 : 0.055;
    const sampleRate = audioContext.sampleRate;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < frameCount; i++) {
      const envelope = Math.pow(1 - i / frameCount, 3);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(accent ? 0.28 : 0.20, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

    source.buffer = buffer;
    source.connect(gain).connect(audioContext.destination);
    source.start();
  }

  function drawIdleCanvas() {
    resizeCanvas();
    const ctx = document.getElementById('pitchCanvas').getContext('2d');
    ctx.clearRect(0, 0, lastCanvasWidth, lastCanvasHeight);
    drawBackground(ctx);
    if (!selectedSong) {
      drawCenteredText(ctx, '曲を選んでください', lastCanvasWidth / 2, lastCanvasHeight / 2, 28);
      return;
    }
    drawPitchCanvas(0);
  }

  function drawPitchCanvas(elapsed) {
    const canvas = document.getElementById('pitchCanvas');
    resizeCanvas();
    const ctx = canvas.getContext('2d');
    const w = lastCanvasWidth;
    const h = lastCanvasHeight;
    ctx.clearRect(0, 0, w, h);
    drawBackground(ctx);

    if (!selectedSong?.notes?.length) return;
    const pitched = selectedSong.notes.filter(n => n.midi != null);
    if (!pitched.length) {
      drawCenteredText(ctx, '音程データがありません', w / 2, h / 2, 28);
      return;
    }
    const midiValues = pitched.map(n => n.midi);
    const minMidi = Math.min(...midiValues) - 2;
    const maxMidi = Math.max(...midiValues) + 2;
    const top = 28;
    const bottom = h - 28;
    const past = 1.65;
    const future = 5.4;
    const windowSec = past + future;
    const playX = w * (past / windowSec);

    ctx.font = `${Math.max(11, Math.round(w / 85))}px system-ui`;
    ctx.textBaseline = 'middle';

    for (let midi = Math.ceil(minMidi); midi <= Math.floor(maxMidi); midi++) {
      const y = midiToY(midi, minMidi, maxMidi, top, bottom);
      ctx.strokeStyle = midi % 12 === 0 ? 'rgba(255,255,255,.18)' : 'rgba(255,255,255,.07)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (midi % 12 === 0) {
        ctx.fillStyle = 'rgba(255,255,255,.55)';
        ctx.fillText(midiToNoteName(midi), 8, y - 9);
      }
    }

    selectedSong.notes.forEach(note => {
      const x = ((note.start - elapsed + past) / windowSec) * w;
      const barWidth = Math.max(5, (note.duration / windowSec) * w - 2);
      if (x + barWidth < 0 || x > w) return;
      if (note.midi == null) {
        ctx.fillStyle = 'rgba(255,255,255,.18)';
        ctx.fillRect(x, h / 2 - 3, barWidth, 6);
        return;
      }
      const y = midiToY(note.midi, minMidi, maxMidi, top, bottom);
      const isActive = elapsed >= note.start && elapsed < note.start + note.duration;
      ctx.fillStyle = isActive ? '#fbbf24' : '#60a5fa';
      roundRect(ctx, x, y - 8, barWidth, 16, 7);
      ctx.fill();
    });

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(playX, 12); ctx.lineTo(playX, h - 12); ctx.stroke();

    if (currentPitch) {
      const midi = frequencyToMidi(currentPitch);
      const y = midiToY(midi, minMidi, maxMidi, top, bottom);
      const active = getActiveNote(elapsed);
      let dotColor = '#fb7185';
      if (active?.midi != null) {
        const cents = Math.abs((midi - active.midi) * 100);
        dotColor = cents <= 50 ? '#34d399' : cents <= 100 ? '#fbbf24' : '#fb7185';
      }
      ctx.fillStyle = dotColor;
      ctx.beginPath(); ctx.arc(playX, y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 3; ctx.stroke();
    }
  }

  function drawBackground(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, lastCanvasHeight);
    gradient.addColorStop(0, '#152744');
    gradient.addColorStop(1, '#0a1426');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, lastCanvasWidth, lastCanvasHeight);
  }

  function updateHud(elapsed, duration) {
    const active = getActiveNote(elapsed);
    document.getElementById('currentNote').textContent = currentPitch ? midiToNoteName(Math.round(frequencyToMidi(currentPitch))) : '―';
    document.getElementById('targetNote').textContent = active?.midi != null ? midiToNoteName(active.midi) : '―';
    document.getElementById('remaining').textContent = `${Math.max(0, Math.ceil(duration - elapsed))}秒`;
    document.getElementById('meterFill').style.width = `${Math.min(100, currentRms * 1800)}%`;

    if (active?.midi != null && currentPitch) {
      const cents = Math.abs(1200 * Math.log2(currentPitch / midiToFrequency(active.midi)));
      document.getElementById('livePitchScore').textContent = cents <= 35 ? 'ぴったり' : cents <= 80 ? 'もう少し' : 'ちがうよ';
    } else {
      document.getElementById('livePitchScore').textContent = '―';
    }
  }

  function prepareLyrics(elapsed) {
    if (!selectedSong?.notes?.length) {
      document.getElementById('currentLyric').textContent = '曲を選んでください';
      document.getElementById('nextLyric').textContent = '';
      return;
    }
    let currentIndex = -1;
    for (let i = 0; i < selectedSong.notes.length; i++) {
      if (selectedSong.notes[i].start <= elapsed + .05) currentIndex = i;
      else break;
    }
    const current = currentIndex >= 0 ? selectedSong.notes[currentIndex] : selectedSong.notes[0];
    let next = '';
    for (let i = Math.max(0, currentIndex + 1); i < selectedSong.notes.length; i++) {
      if (selectedSong.notes[i].lyric) {
        next = selectedSong.notes[i].lyric;
        break;
      }
    }
    document.getElementById('currentLyric').textContent = current?.lyric || '♪';
    document.getElementById('nextLyric').textContent = next ? `つぎ：${next}` : '';
  }

  function findActiveNoteIndex(elapsed) {
    if (!selectedSong) return -1;
    for (let i = 0; i < selectedSong.notes.length; i++) {
      const n = selectedSong.notes[i];
      if (elapsed >= n.start && elapsed < n.start + n.duration) return i;
      if (n.start > elapsed) break;
    }
    return -1;
  }

  function getActiveNote(elapsed) {
    const index = findActiveNoteIndex(elapsed);
    return index >= 0 ? selectedSong.notes[index] : null;
  }

  function getSongDuration(song) {
    return Math.max(...song.notes.map(n => n.start + n.duration), 1);
  }

  function resizeCanvas() {
    const canvas = document.getElementById('pitchCanvas');
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(320, Math.floor(rect.width * dpr));
    const h = Math.max(240, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    lastCanvasWidth = w;
    lastCanvasHeight = h;
  }

  function autoCorrelate(buffer, sampleRate) {
    // RMS（音量）を計算
    let rms = 0;
    let mean = 0;
    for (let i = 0; i < buffer.length; i++) mean += buffer[i];
    mean /= buffer.length;

    const centered = new Float32Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      const v = buffer[i] - mean;
      centered[i] = v;
      rms += v * v;
    }
    rms = Math.sqrt(rms / buffer.length);

    // 旧版0.018はChromebookの内蔵マイクには厳しすぎる場合がある。
    // 小さめの歌声も拾いつつ、無音ノイズは除外。
    if (rms < 0.0035) return { frequency: null, rms };

    // 小学生の歌声＋教材音域を広めにカバー
    const minFreq = 75;
    const maxFreq = 1300;
    const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxLag = Math.min(
      Math.floor(sampleRate / minFreq),
      Math.floor(centered.length / 2)
    );

    let bestLag = -1;
    let bestCorr = -1;
    const correlations = new Float32Array(maxLag + 1);

    // 正規化自己相関。
    // 単純な差分法より、入力音量が小さい端末でも安定しやすい。
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sumXY = 0;
      let sumXX = 0;
      let sumYY = 0;
      const len = centered.length - lag;

      for (let i = 0; i < len; i++) {
        const x = centered[i];
        const y = centered[i + lag];
        sumXY += x * y;
        sumXX += x * x;
        sumYY += y * y;
      }

      const denom = Math.sqrt(sumXX * sumYY);
      const corr = denom > 1e-9 ? sumXY / denom : 0;
      correlations[lag] = corr;

      // 最初の強い局所ピークを優先し、倍音への飛びを減らす
      const prev = lag > minLag ? correlations[lag - 1] : -1;
      if (lag > minLag + 1 && prev > correlations[lag - 2] && prev >= corr && prev > 0.52) {
        bestLag = lag - 1;
        bestCorr = prev;
        break;
      }

      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    // 旧版0.55より少し緩め。声としての周期性は残す。
    if (bestLag <= 0 || bestCorr < 0.42) return { frequency: null, rms };

    // 放物線補間で周波数を少し滑らかにする
    const c0 = correlations[bestLag] || bestCorr;
    const c1 = correlations[bestLag - 1] || c0;
    const c2 = correlations[bestLag + 1] || c0;
    const denom = (c1 - 2 * c0 + c2);
    let shift = 0;
    if (Math.abs(denom) > 1e-6) {
      shift = 0.5 * (c1 - c2) / denom;
      shift = Math.max(-0.5, Math.min(0.5, shift));
    }

    const frequency = sampleRate / (bestLag + shift);
    if (!Number.isFinite(frequency) || frequency < minFreq || frequency > maxFreq) {
      return { frequency: null, rms };
    }

    return { frequency, rms };
  }

  function midiToFrequency(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }
  function frequencyToMidi(freq) { return 69 + 12 * Math.log2(freq / 440); }
  function midiToNoteName(midi) {
    const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    const rounded = Math.round(midi);
    return names[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
  }
  function midiToJapaneseNoteName(midi) {
    const names = ['ド', 'ド♯', 'レ', 'レ♯', 'ミ', 'ファ', 'ファ♯', 'ソ', 'ソ♯', 'ラ', 'ラ♯', 'シ'];
    const rounded = Math.round(midi);
    return names[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1);
  }
  function midiToY(midi, minMidi, maxMidi, top, bottom) {
    return bottom - ((midi - minMidi) / Math.max(1, maxMidi - minMidi)) * (bottom - top);
  }
  function average(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
  function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  function setStatus(message, type) {
    const el = document.getElementById('status');
    el.textContent = message;
    el.style.color = type === 'error' ? 'var(--bad)' : 'var(--sub)';
  }
  function drawCenteredText(ctx, text, x, y, size) {
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.font = `800 ${size}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.textAlign = 'left';
  }
  function roundRect(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
