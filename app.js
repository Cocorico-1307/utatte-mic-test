
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
  let latestClassRanking = [];
  const sessionScoreHistory = new Map();
  let latestStudentGrowth = null;

  // 通常の児童URLには出さない、先生専用の仮想テストクラス。
  const teacherTestMode =
    new URLSearchParams(window.location.search).get('teacherTest') === '1';

  document.addEventListener('DOMContentLoaded', init);
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (!isRunning) drawIdleCanvas();
  });

  window.addEventListener('message', event => {
    const data = event.data;
    if (!data || data.source !== 'utatte-score-save') return;
    if (!pendingSaveRequestId || data.requestId !== pendingSaveRequestId) return;

    pendingSaveRequestId = '';
    const saveStatus = document.getElementById('saveStatus');
    if (data.ok) {
      saveStatus.textContent = '✅ スプレッドシートに記録しました。';
      saveStatus.className = 'status success';
      // 新しい記録が入ったので、少し待ってからランキング・クラスの木・うたレベルを更新。
      setTimeout(() => {
        loadClassRanking();
        loadClassGarden();
        loadStudentGrowth(true);
      }, 500);
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
    document.getElementById('refreshRankingButton')?.addEventListener('click', loadClassRanking);
    document.getElementById('refreshGardenButton')?.addEventListener('click', loadClassGarden);
    document.getElementById('refreshStudentGrowthButton')?.addEventListener('click', () => loadStudentGrowth(false));
    applyTeacherTestMode();

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
    // 児童用利用コードは数字4桁だけ。
    const digits = String(value || '').replace(/\D/g, '').slice(0, 4);
    return /^\d{4}$/.test(digits) ? digits : '';
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
    const stageSongTitle = document.getElementById('stageSongTitle');
    if (stageSongTitle) {
      stageSongTitle.textContent = selectedSong
        ? (selectedSong.artist ? `${selectedSong.title}（${selectedSong.artist}）` : selectedSong.title)
        : '曲を選んでください';
    }
    document.getElementById('resultCard').classList.add('hidden');
    document.getElementById('saveStatus').textContent = '記録はまだ送信していません。';
    document.getElementById('saveStatus').className = 'status muted';
    prepareLyrics(0);
    drawIdleCanvas();
    const firstNote = selectedSong?.notes?.find(note => note.midi != null);
    document.getElementById('targetNote').textContent = firstNote ? midiToJapaneseNoteName(firstNote.midi) : '―';
    document.getElementById('startButton').disabled = classroomPaused || !selectedSong || !currentLessonCode;
    if (selectedSong) {
      setStatus('スタートすると、はじめの音のあとにカウントが鳴ります。');
      loadClassRanking();
      loadClassGarden();
      loadStudentGrowth(false);
    } else {
      latestClassRanking = [];
      renderClassRanking([]);
    }
  }


  function applyTeacherTestMode() {
    if (!teacherTestMode) return;

    document.getElementById('teacherTestBanner')?.classList.remove('hidden');

    // 実在クラスを誤って選んで保存するのを防ぎます。
    ['gradeSelect', 'classSelect', 'attendanceNumber'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = true;
    });

    // テスト時はクラス集計を表示しません。
    document.getElementById('classGardenCard')?.classList.add('hidden');
    document.getElementById('classRankingCard')?.classList.add('hidden');
    document.getElementById('studentGrowthCard')?.classList.add('hidden');
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
        // ランキングの中で「自分のクラス」の強調表示だけ更新します。
        renderClassRanking(latestClassRanking);
        latestStudentGrowth = null;
        loadStudentGrowth(false);
        loadClassGarden();
      });
    });
  }


  function focusSingingStage() {
    const stage = document.getElementById('singingStage');
    if (!stage) return;
    requestAnimationFrame(() => {
      stage.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
          autoGainControl: { ideal: false },
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

    // 歌唱開始時に一度だけステージを画面上端へ合わせます。
    // 歌唱中は自動スクロールしないので、音程バーと下の判定表示が安定して見えます。
    focusSingingStage();
    setStatus('マイクを準備しています…');

    try {
      micStream = await getMicrophoneStream();

      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await audioContext.resume();
      const source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 4096;
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
        rmsSum: 0,
        rmsCount: 0,
        rmsPeak: 0,
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
      if (document.getElementById('metronomeMode')?.checked) {
        scheduleMetronome(synchronizedAudioStart);
      }

      setStatus(
        document.getElementById('metronomeMode')?.checked
          ? 'メトロノームの拍に合わせて、うたってください！'
          : 'ガイドメロディーに合わせて、うたってください！'
      );
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

    if (now - lastPitchCheck >= 60) {
      analyser.getFloatTimeDomainData(timeData);
      const result = autoCorrelate(timeData, audioContext.sampleRate);
      currentPitch = result.frequency;
      currentRms = result.rms;
      lastPitchCheck = now;
      collectScoreSample(elapsed, currentPitch, currentRms);
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

  function collectScoreSample(elapsed, frequency, rms) {
    const index = findActiveNoteIndex(elapsed);
    if (index < 0) return;
    const note = selectedSong.notes[index];
    if (note.midi == null) return;
    const stat = stats[index];

    // 曲中メトロノームのクリックがスピーカーからマイクへ回り込み、
    // 「大きい声」と誤判定されないよう、拍頭のごく短い区間だけ採点から除外します。
    if (document.getElementById('metronomeMode')?.checked) {
      const bpm = Math.max(30, Math.min(300, Number(selectedSong?.bpm || 100)));
      const beatSec = 60 / bpm;
      const phase = ((elapsed % beatSec) + beatSec) % beatSec;
      const distanceToBeat = Math.min(phase, beatSec - phase);
      if (distanceToBeat < 0.045) return;
    }

    stat.totalSamples++;

    const safeRms = Math.max(0, Number(rms) || 0);
    stat.rmsSum += safeRms;
    stat.rmsCount++;
    stat.rmsPeak = Math.max(stat.rmsPeak, safeRms);

    if (!frequency) return;

    stat.voicedSamples++;
    if (stat.firstVoiceAt == null) stat.firstVoiceAt = elapsed;

    const targetFreq = midiToFrequency(note.midi);
    const signedCents = Math.max(
      -600,
      Math.min(600, 1200 * Math.log2(frequency / targetFreq))
    );
    const cents = Math.abs(signedCents);

    stat.pitchQualitySum += pitchQuality(cents);
    stat.centsSum += signedCents;
    stat.centsSquareSum += signedCents * signedCents;
    stat.pitchSampleCount++;

    // 前よりやさしめ。半音弱くらいまで「よく合っている」扱い。
    if (cents <= 80) stat.excellentSamples++;
  }

  function pitchQuality(cents) {
    // 子どもの歌声・自然なしゃくり・ビブラートを考慮して、
    // 以前より広めの許容幅にしています。
    if (cents <= 50) return 1.00;
    if (cents <= 100) return 0.96;
    if (cents <= 150) return 0.88;
    if (cents <= 220) return 0.72;
    if (cents <= 300) return 0.50;
    if (cents <= 420) return 0.25;
    return 0;
  }

  function loudnessQuality(rms) {
    // 大きい声ほど加点。ただし無理に叫ばなくても
    // 「しっかりした声」で上限に届くよう飽和させます。
    const x = Math.max(0, Number(rms) || 0);
    const points = [
      [0.003, 0],
      [0.006, 25],
      [0.010, 45],
      [0.016, 65],
      [0.025, 80],
      [0.040, 92],
      [0.060, 100],
    ];

    if (x <= points[0][0]) return 0;
    for (let i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        const [x0, y0] = points[i - 1];
        const [x1, y1] = points[i];
        const t = (x - x0) / Math.max(0.000001, x1 - x0);
        return (y0 + (y1 - y0) * t) / 100;
      }
    }
    return 1;
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
      const voicedRatio = stat.totalSamples
        ? Math.min(1, stat.voicedSamples / stat.totalSamples)
        : 0;

      // 1サンプルずつ「完全一致」を要求せず、
      // 音全体の中心が目標音に合っているかを重視します。
      // これにより自然なしゃくり・抑揚・ビブラートを減点しにくくします。
      let pitch = 0;
      let stability = 0;

      if (stat.pitchSampleCount > 0) {
        const meanCents = stat.centsSum / stat.pitchSampleCount;
        const centerQuality = pitchQuality(Math.abs(meanCents));
        const sampleQuality = stat.pitchQualitySum / stat.pitchSampleCount;
        pitch = centerQuality * 0.68 + sampleQuality * 0.32;

        if (stat.pitchSampleCount >= 2) {
          const variance = Math.max(
            0,
            stat.centsSquareSum / stat.pitchSampleCount - meanCents * meanCents
          );
          const deviation = Math.sqrt(variance);

          // ±70cent程度の自然な揺れはほぼ減点しない。
          // 「一直線に同じ高さで伸ばす」こと自体を高得点条件にしない。
          const excess = Math.max(0, deviation - 70);
          const smoothness = Math.max(0, Math.min(1, 1 - excess / 230));
          stability = smoothness * 0.65 + voicedRatio * 0.35;
        } else {
          stability = 0.50 * voicedRatio;
        }
      }

      const onset = stat.firstVoiceAt == null
        ? 0
        : Math.max(0, 1 - Math.abs(stat.firstVoiceAt - note.start) / 0.55);

      // 少し途中で息継ぎしても大きく落ちすぎないようにする。
      const sustain = stat.totalSamples
        ? Math.min(1, (stat.voicedSamples / stat.totalSamples) * 1.20)
        : 0;

      const rhythm = onset * 0.55 + sustain * 0.45;

      const averageRms = stat.rmsCount ? stat.rmsSum / stat.rmsCount : 0;
      const loudness = loudnessQuality(averageRms);

      return {
        pitch,
        rhythm,
        sustain,
        stability,
        loudness,
        duration: Number(note.duration || 0),
      };
    });

    const longDetails = details.filter(detail => detail.duration >= 0.8);
    const longToneSource = longDetails.length ? longDetails : details;

    // ロングトーンも「同じ音程に固定」ではなく、
    // 声が続いていることを中心に見る。
    const longToneValues = longToneSource.map(detail =>
      detail.sustain * 0.78 + detail.pitch * 0.22
    );

    const totalSamples = noteStats.reduce((sum, item) => sum + item.stat.totalSamples, 0);
    const voicedSamples = noteStats.reduce((sum, item) => sum + item.stat.voicedSamples, 0);
    const voicedRatio = totalSamples
      ? Math.min(1, voicedSamples / totalSamples)
      : 0;

    const pitchScore = roundScore(100 * average(details.map(detail => detail.pitch)));
    const rhythmScore = roundScore(100 * average(details.map(detail => detail.rhythm)));
    const stabilityScore = roundScore(100 * average(details.map(detail => detail.stability)));
    const longToneScore = roundScore(100 * average(longToneValues));

    // singingScore という内部名は既存データ互換のため残し、
    // 画面上では「声量」として扱います。
    const loudnessAverage = average(details.map(detail => detail.loudness));
    const singingScore = roundScore(
      100 * (loudnessAverage * 0.82 + voicedRatio * 0.18)
    );

    // 声量を25%にして、しっかり声を出すほど総合点に反映。
    const totalScore = roundScore(
      pitchScore * 0.35 +
      rhythmScore * 0.20 +
      stabilityScore * 0.10 +
      longToneScore * 0.10 +
      singingScore * 0.25
    );

    let combo = 0;
    let maxCombo = 0;
    let excellentNoteCount = 0;

    details.forEach(detail => {
      const hit =
        detail.pitch >= 0.68 &&
        detail.rhythm >= 0.55 &&
        detail.sustain >= 0.42;

      if (hit) {
        combo++;
        maxCombo = Math.max(maxCombo, combo);
      } else {
        combo = 0;
      }

      if (detail.pitch >= 0.84 && detail.rhythm >= 0.65) {
        excellentNoteCount++;
      }
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
    updateSessionProgress(result);

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



  async function loadStudentGrowth(announceLevelUp = false) {
    if (teacherTestMode) return;

    const icon = document.getElementById('studentGrowthIcon');
    const levelEl = document.getElementById('studentGrowthLevel');
    const fill = document.getElementById('studentGrowthFill');
    const next = document.getElementById('studentGrowthNext');
    const banner = document.getElementById('levelUpBanner');
    if (!icon || !levelEl || !fill || !next) return;

    if (!apiUrl || !currentLessonCode) {
      latestStudentGrowth = null;
      icon.textContent = '🌱';
      levelEl.textContent = 'うたレベル 1';
      fill.style.width = '0%';
      next.textContent = '教材を読み込むと、これまでの積み重ねが表示されます。';
      if (banner) banner.classList.add('hidden');
      return;
    }

    const grade = Number(document.getElementById('gradeSelect')?.value || 0);
    const classNumber = Number(document.getElementById('classSelect')?.value || 0);
    const attendanceNumber = Number(document.getElementById('attendanceNumber')?.value || 0);
    if (!grade || !classNumber || !attendanceNumber) return;

    next.textContent = 'うたレベルを読み込んでいます…';

    try {
      const previousLevel = latestStudentGrowth ? Number(latestStudentGrowth.level || 1) : null;
      const data = await jsonp({
        action: 'studentGrowth',
        lessonCode: currentLessonCode,
        grade,
        classNumber,
        attendanceNumber,
      });

      if (!data?.ok || !data.growth) {
        throw new Error(data?.message || 'うたレベルを読み込めませんでした。');
      }

      const growth = data.growth;
      latestStudentGrowth = growth;

      const level = Math.max(1, Number(growth.level || 1));
      const progressPercent = Math.max(0, Math.min(100, Number(growth.progressPercent || 0)));
      const pointsToNext = Math.max(1, Number(growth.pointsToNext || 1));

      icon.textContent = growth.stageIcon || '🌱';
      levelEl.textContent = `うたレベル ${level}　${growth.stageLabel || ''}`.trim();
      fill.style.width = `${progressPercent}%`;
      next.textContent = `80点以上のチャレンジを、あと${pointsToNext}回積み重ねるとレベル${level + 1}！`;

      if (banner) {
        if (announceLevelUp && previousLevel != null && level > previousLevel) {
          banner.textContent = `🎉 レベルアップ！ うたレベル ${level} になりました！`;
          banner.classList.remove('hidden');
        } else {
          banner.classList.add('hidden');
          banner.textContent = '';
        }
      }
    } catch (err) {
      latestStudentGrowth = null;
      icon.textContent = '🌱';
      levelEl.textContent = 'うたレベル';
      fill.style.width = '0%';
      next.textContent = err?.message || 'うたレベルを読み込めませんでした。';
      if (banner) banner.classList.add('hidden');
    }
  }

  async function loadClassGarden() {
    if (teacherTestMode) return;
    const icon = document.getElementById('gardenIcon');
    const stage = document.getElementById('gardenStage');
    const fill = document.getElementById('gardenFill');
    const next = document.getElementById('gardenNext');
    if (!icon || !stage || !fill || !next) return;

    if (!apiUrl || !currentLessonCode) {
      icon.textContent = '🌰';
      stage.textContent = '木レベル 1　たね';
      fill.style.width = '0%';
      next.textContent = '教材を読み込むとクラスの木が表示されます。';
      return;
    }

    const grade = Number(document.getElementById('gradeSelect')?.value || 0);
    const classNumber = Number(document.getElementById('classSelect')?.value || 0);
    if (!grade || !classNumber) return;

    next.textContent = 'クラスの木を読み込んでいます…';

    try {
      const data = await jsonp({
        action: 'classGarden',
        lessonCode: currentLessonCode,
        grade,
        classNumber,
      });

      if (!data?.ok || !data.garden) {
        throw new Error(data?.message || 'クラスの木を読み込めませんでした。');
      }

      const garden = data.garden;
      icon.textContent = garden.stageIcon || '🌰';
      stage.textContent = `${garden.className || ''}　${garden.stageLabel || ''}`;
      fill.style.width = `${Math.max(0, Math.min(100, Number(garden.progressPercent || 0)))}%`;

      const level = Math.max(1, Number(garden.level || 1));
      const pointsInLevel = Math.max(0, Number(garden.pointsInLevel || 0));
      const levelSize = Math.max(1, Number(garden.levelSize || 35));
      const pointsToNext = Math.max(1, Number(garden.pointsToNext || levelSize));

      next.textContent =
        `いま ${pointsInLevel}/${levelSize}ポイント　あと${pointsToNext}ポイントで木レベル${level + 1}！`;
    } catch (err) {
      icon.textContent = '🌰';
      stage.textContent = `${grade}年${classNumber}組の木`;
      fill.style.width = '0%';
      next.textContent = err?.message || 'クラスの木を読み込めませんでした。';
    }
  }

  function getCurrentStudentSessionKey() {
    if (!selectedSong) return '';
    const grade = document.getElementById('gradeSelect')?.value || '';
    const classNumber = document.getElementById('classSelect')?.value || '';
    const attendanceNumber = document.getElementById('attendanceNumber')?.value || '';
    return `${selectedSong.songId}|${grade}|${classNumber}|${attendanceNumber}`;
  }

  function updateSessionProgress(result) {
    const box = document.getElementById('sessionProgress');
    if (!box) return;

    const key = getCurrentStudentSessionKey();
    if (!key) {
      box.classList.add('hidden');
      return;
    }

    const score = Number(result.totalScore || 0);
    const previous = sessionScoreHistory.get(key) || { attempts: 0, best: null, last: null };
    const oldBest = previous.best;
    const attempts = previous.attempts + 1;
    const newBest = oldBest == null ? score : Math.max(oldBest, score);

    sessionScoreHistory.set(key, {
      attempts,
      best: newBest,
      last: score,
    });

    if (oldBest == null) {
      box.textContent =
        `🌱 このページでの自己ベスト：${formatScore(score)}点（${attempts}回目）`;
    } else if (score > oldBest) {
      box.textContent =
        `🎉 自己ベスト更新！ ${formatScore(score)}点（前のベストから +${formatScore(score - oldBest)}点）`;
    } else {
      box.textContent =
        `⭐ このページでの自己ベスト：${formatScore(newBest)}点　今回：${formatScore(score)}点（${attempts}回目）`;
    }

    box.classList.remove('hidden');
    box.title = 'この表示は今開いているページの中だけで記録し、サーバーから個人の過去点は読み出しません。';
  }

  async function loadClassRanking() {
    if (teacherTestMode) return;
    const message = document.getElementById('classRankingMessage');
    if (!message) return;

    if (!apiUrl || !currentLessonCode || !selectedSong) {
      latestClassRanking = [];
      renderClassRanking([]);
      message.textContent = '教材を読み込むとランキングが表示されます。';
      message.className = 'small muted';
      return;
    }

    message.textContent = 'ランキングを読み込んでいます…';
    message.className = 'small muted';

    try {
      const data = await jsonp({
        action: 'classRanking',
        lessonCode: currentLessonCode,
        songId: selectedSong.songId,
      });

      if (!data?.ok) {
        throw new Error(data?.message || 'ランキングを読み込めませんでした。');
      }

      latestClassRanking = Array.isArray(data.ranking) ? data.ranking : [];
      renderClassRanking(latestClassRanking);

      if (latestClassRanking.length) {
        message.textContent =
          '5人以上が参加したクラスのみ表示しています。平均点は整数表示です。';
        message.className = 'small success';
      } else {
        message.textContent =
          `まだ表示できるクラスがありません。各クラス${Number(data.minimumParticipants || 5)}人以上参加すると表示されます。`;
        message.className = 'small muted';
      }
    } catch (err) {
      latestClassRanking = [];
      renderClassRanking([]);
      message.textContent = err?.message || 'ランキングの読み込みに失敗しました。';
      message.className = 'small error';
    }
  }

  function renderClassRanking(rows) {
    const list = document.getElementById('classRankingList');
    if (!list) return;

    list.innerHTML = '';
    if (!Array.isArray(rows) || !rows.length) return;

    const ownClass =
      `${document.getElementById('gradeSelect')?.value || ''}年` +
      `${document.getElementById('classSelect')?.value || ''}組`;

    rows.forEach(row => {
      const item = document.createElement('div');
      item.className = 'class-rank-row';
      if (String(row.className) === ownClass) item.classList.add('my-class');

      const place = document.createElement('div');
      place.className = 'class-rank-place';
      place.textContent =
        Number(row.rank) === 1 ? '🥇' :
        Number(row.rank) === 2 ? '🥈' :
        Number(row.rank) === 3 ? '🥉' :
        `${Number(row.rank) || '―'}位`;

      const name = document.createElement('div');
      name.className = 'class-rank-name';
      name.textContent =
        String(row.className || '') +
        (String(row.className || '') === ownClass ? '　← あなたのクラス' : '');

      const score = document.createElement('div');
      score.className = 'class-rank-score';
      score.textContent = `${Math.round(Number(row.averageScore || 0))}点`;

      item.append(place, name, score);
      list.appendChild(item);
    });
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
    return 'はじめの音をよく聴いて、少し大きめの声で歌ってみよう。';
  }

  function getPracticeTip(result) {
    const metrics = [
      { label: '音程', value: result.pitchScore, tip: '目標の音程バーの中央をねらって、声をゆっくり動かしてみよう。' },
      { label: 'リズム', value: result.rhythmScore, tip: '歌詞の最初を、カウントや音程バーの左端に合わせてみよう。' },
      { label: 'なめらかさ', value: result.stabilityScore, tip: '自然な抑揚をつけながら、声が急に飛びすぎないよう歌ってみよう。' },
      { label: 'ロングトーン', value: result.longToneScore, tip: '伸ばす音は、自然な揺れをつけてもOK。最後まで息をつないでみよう。' },
      { label: '声量', value: result.singingScore, tip: '無理に叫ばず、教室の後ろまで届くような声を意識してみよう。' },
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
    const saveStatus = document.getElementById('saveStatus');

    if (teacherTestMode) {
      pendingSaveRequestId = '';
      saveStatus.textContent = '🧪 先生テストモード：この結果は保存していません。';
      saveStatus.className = 'status success';
      return;
    }

    const requestId = (crypto.randomUUID ? crypto.randomUUID() :
      'req-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    pendingSaveRequestId = requestId;
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


  function scheduleMetronome(startAt) {
    if (!audioContext || !selectedSong) return;

    const bpm = Math.max(30, Math.min(300, Number(selectedSong.bpm || 100)));
    const beatSec = 60 / bpm;
    const duration = getSongDuration(selectedSong);

    for (let beat = 0, t = 0; t <= duration + 0.02; beat++, t += beatSec) {
      // 最初の拍だけ少し強く、以降は同じ音程のないクリック。
      scheduleNoiseClick(startAt + t, beat === 0, beat === 0 ? 0.16 : 0.11);
    }
  }

  function scheduleNoiseClick(when, accent = false, level = 0.12) {
    if (!audioContext) return;

    const duration = accent ? 0.038 : 0.030;
    const sampleRate = audioContext.sampleRate;
    const frameCount = Math.max(1, Math.floor(sampleRate * duration));
    const buffer = audioContext.createBuffer(1, frameCount, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < frameCount; i++) {
      const envelope = Math.pow(1 - i / frameCount, 4);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }

    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    gain.gain.setValueAtTime(Math.max(0.001, level), when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + duration);

    source.buffer = buffer;
    source.connect(gain).connect(audioContext.destination);
    source.start(when);
    source.stop(when + duration + 0.01);
    guideNodes.push(source);
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
    scheduleNoiseClick(
      audioContext.currentTime,
      accent,
      accent ? 0.28 : 0.20
    );
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
    // 歌唱中に毎フレームCanvasの大きさを取り直すと、端末によっては
    // 1px前後の再計算が繰り返されて画面がぶれて見えるため固定します。
    if (!lastCanvasWidth || !lastCanvasHeight) resizeCanvas();
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
    const songMinMidi = Math.min(...midiValues);
    const songMaxMidi = Math.max(...midiValues);

    // 表示する音域は「曲の音域＋上下5半音」で固定します。
    // 歌っている音に合わせて縦軸を広げたり縮めたりしないため、
    // 音程バー全体が上下に揺れるような見え方を防げます。
    const minMidi = songMinMidi - 5;
    const maxMidi = songMaxMidi + 5;
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
      ctx.strokeStyle = midi % 12 === 0 ? 'rgba(255,245,224,.18)' : 'rgba(255,245,224,.07)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (midi % 12 === 0) {
        ctx.fillStyle = 'rgba(255,240,205,.62)';
        ctx.fillText(midiToNoteName(midi), 8, y - 9);
      }
    }

    selectedSong.notes.forEach(note => {
      const x = ((note.start - elapsed + past) / windowSec) * w;
      const barWidth = Math.max(5, (note.duration / windowSec) * w - 2);
      if (x + barWidth < 0 || x > w) return;
      if (note.midi == null) {
        ctx.fillStyle = 'rgba(255,245,224,.18)';
        ctx.fillRect(x, h / 2 - 3, barWidth, 6);
        return;
      }
      const y = midiToY(note.midi, minMidi, maxMidi, top, bottom);
      const isActive = elapsed >= note.start && elapsed < note.start + note.duration;
      ctx.fillStyle = isActive ? '#efbd4f' : '#e17a58';
      roundRect(ctx, x, y - 8, barWidth, 16, 7);
      ctx.fill();
    });

    ctx.strokeStyle = '#fff7e6';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(playX, 12); ctx.lineTo(playX, h - 12); ctx.stroke();

    if (currentPitch) {
      const midi = frequencyToMidi(currentPitch);
      const visibleMidi = Math.max(minMidi, Math.min(maxMidi, midi));
      const y = midiToY(visibleMidi, minMidi, maxMidi, top, bottom);
      const active = getActiveNote(elapsed);
      let dotColor = '#d96859';
      if (active?.midi != null) {
        const cents = Math.abs((midi - active.midi) * 100);
        dotColor = cents <= 80 ? '#86ad6c' : cents <= 160 ? '#efbd4f' : '#d96859';
      }
      ctx.fillStyle = dotColor;
      ctx.beginPath(); ctx.arc(playX, y, 10, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,247,230,.92)'; ctx.lineWidth = 3; ctx.stroke();
    }
  }

  function drawBackground(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, lastCanvasHeight);
    gradient.addColorStop(0, '#5a3732');
    gradient.addColorStop(1, '#2b2020');
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
      document.getElementById('livePitchScore').textContent =
        cents <= 70 ? 'ぴったり' :
        cents <= 150 ? 'いい感じ' :
        cents <= 240 ? 'もう少し' : 'ちがうよ';
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
    let currentLyric = '';
    const searchFrom = currentIndex >= 0 ? currentIndex : 0;
    for (let i = searchFrom; i >= 0; i--) {
      if (selectedSong.notes[i].lyric) {
        currentLyric = selectedSong.notes[i].lyric;
        break;
      }
    }

    let next = '';
    for (let i = Math.max(0, currentIndex + 1); i < selectedSong.notes.length; i++) {
      if (selectedSong.notes[i].lyric) {
        next = selectedSong.notes[i].lyric;
        break;
      }
    }

    document.getElementById('currentLyric').textContent = currentLyric || '♪';
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
    // YIN法に近い周期検出。
    // 旧版の「最初の強い自己相関ピーク」を選ぶ方式は、
    // 声の倍音が強いと低いドを1オクターブ高いドとして拾うことがありました。
    // 今回は基音の周期を優先して探し、音域も広げています。

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

    if (rms < 0.0035) return { frequency: null, rms };

    // 約 C2(65Hz) より下～C7(2093Hz) より少し上まで。
    // 先生の鍵盤も C2～C7 に広げます。
    const minFreq = 55;
    const maxFreq = 2300;

    const minTau = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxTau = Math.min(
      Math.floor(sampleRate / minFreq),
      Math.floor(centered.length / 2) - 1
    );

    if (maxTau <= minTau + 2) return { frequency: null, rms };

    const diff = new Float32Array(maxTau + 1);
    const cmnd = new Float32Array(maxTau + 1);
    cmnd[0] = 1;

    for (let tau = 1; tau <= maxTau; tau++) {
      let sum = 0;
      const len = centered.length - tau;
      for (let i = 0; i < len; i++) {
        const delta = centered[i] - centered[i + tau];
        sum += delta * delta;
      }
      diff[tau] = sum;
    }

    let runningSum = 0;
    for (let tau = 1; tau <= maxTau; tau++) {
      runningSum += diff[tau];
      cmnd[tau] = runningSum > 1e-12
        ? diff[tau] * tau / runningSum
        : 1;
    }

    // まず「十分周期的」な最初の谷を探す。
    // YINの考え方により、倍音の山より基音周期を拾いやすくします。
    const threshold = 0.18;
    let tauEstimate = -1;

    for (let tau = minTau; tau <= maxTau; tau++) {
      if (cmnd[tau] < threshold) {
        while (tau + 1 <= maxTau && cmnd[tau + 1] < cmnd[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }

    // 閾値を下回らない声でも、一番周期性の高い谷を使う。
    if (tauEstimate < 0) {
      let bestValue = 1;
      for (let tau = minTau; tau <= maxTau; tau++) {
        if (cmnd[tau] < bestValue) {
          bestValue = cmnd[tau];
          tauEstimate = tau;
        }
      }
      if (tauEstimate < 0 || bestValue > 0.42) {
        return { frequency: null, rms };
      }
    }

    // 放物線補間
    let refinedTau = tauEstimate;
    if (tauEstimate > minTau && tauEstimate < maxTau) {
      const s0 = cmnd[tauEstimate - 1];
      const s1 = cmnd[tauEstimate];
      const s2 = cmnd[tauEstimate + 1];
      const denom = 2 * (2 * s1 - s2 - s0);
      if (Math.abs(denom) > 1e-9) {
        const shift = (s2 - s0) / denom;
        refinedTau += Math.max(-0.5, Math.min(0.5, shift));
      }
    }

    const frequency = sampleRate / refinedTau;
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
    ctx.fillStyle = 'rgba(255,244,220,.78)';
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
