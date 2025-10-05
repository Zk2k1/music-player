// 基础状态
const audio = document.getElementById('audio');
const titleEl = document.getElementById('title');
const artistEl = document.getElementById('artist');
const coverEl = document.getElementById('cover');
const btnPlay = document.getElementById('btnPlay');
const btnPrev = document.getElementById('btnPrev');
const btnNext = document.getElementById('btnNext');
const btnShuffle = document.getElementById('btnShuffle');
const btnRepeat = document.getElementById('btnRepeat');
const progress = document.getElementById('progress');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const volumeEl = document.getElementById('volume');
const lyricsEl = document.getElementById('lyrics');
const playlistEl = document.getElementById('playlist');
const searchInput = document.getElementById('searchInput');
const searchBtn = document.getElementById('searchBtn');
const searchResultsEl = document.getElementById('searchResults');
const platformSelect = document.getElementById('platformSelect');
const savePlaylistBtn = document.getElementById('savePlaylistBtn');
const clearPlaylistBtn = document.getElementById('clearPlaylistBtn');

const STORAGE_KEY = 'player.playlist.v1';
const NETEASE_API_BASE = 'http://localhost:3000'; // 需先本地启动 NeteaseCloudMusicApi
const COMMON_API_BASE = 'http://localhost:3200'; // 普通适配器服务基址
const JK_API_BASE = 'https://jkapi.com/api/music'; // 无铭API音乐接口
const JK_API_KEY = '36330a13a19df1cca869eeb814886be2';

let state = {
  queue: [], // { id, title, artist, url, cover, lrc }
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  repeatMode: 'off', // off | one
  currentLyrics: [], // [{timeMs, text}]
  platform: 'demo',
};

// Demo LRC（时间戳仅示意）- 需在 DemoAdapter 之前定义，避免 TDZ 错误
const demoLrc = `
[00:00.00] Demo Lyrics
[00:10.00] When the music starts to play
[00:20.00] Feel the rhythm night and day
[00:30.00] Sing along and move your feet
[00:40.00] Let the melody repeat
`;

// Demo 数据源（免跨域）
const DemoAdapter = {
  name: 'demo',
  async search(query) {
    const seed = query.trim() || 'Demo';
    const list = [
      {
        id: 'demo-1',
        title: `${seed} Song 1`,
        artist: 'Demo Artist',
        url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3',
        cover: 'https://picsum.photos/seed/demo1/200/200',
        lrc: demoLrc,
      },
      {
        id: 'demo-2',
        title: `${seed} Song 2`,
        artist: 'Demo Artist',
        url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3',
        cover: 'https://picsum.photos/seed/demo2/200/200',
        lrc: demoLrc,
      },
    ];
    return list;
  },
};

// JK 无铭音乐 API 适配器（需 apiKey）
const JkApiAdapter = {
  name: 'jkapi',
  async search(query) {
    if (!JK_API_KEY) {
      throw new Error('JK API 未配置 apiKey');
    }
    // 按官方示例：plat=wy&type=json&apiKey=密钥&name=关键词
    const buildUrl = () => {
      const sp = new URLSearchParams();
      sp.set('plat', 'wy');
      sp.set('type', 'json');
      sp.set('apiKey', JK_API_KEY);
      sp.set('name', query);
      return `${JK_API_BASE}?${sp.toString()}`;
    };

    const tryFetch = async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(url, {
          credentials: 'omit',
          headers: { 'Accept': 'application/json, text/plain;q=0.9, */*;q=0.8' },
          signal: ctl.signal,
        });
        const ct = res.headers.get('content-type') || '';
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          return { ok: false, status: res.status, json: null, text, contentType: ct };
        }
        if (ct.includes('application/json')) {
          const json = await res.json().catch(() => null);
          return { ok: true, status: res.status, json, text: null, contentType: ct };
        }
        const text = await res.text().catch(() => '');
        // 尝试纯文本 JSON
        const trimmed = (text || '').trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
          try { return { ok: true, status: res.status, json: JSON.parse(trimmed), text: null, contentType: ct }; } catch {}
        }
        return { ok: true, status: res.status, json: null, text, contentType: ct };
      } catch (e) {
        return { ok: false, status: 0, json: null, text: String(e && e.name === 'AbortError' ? '请求超时' : (e?.message || e)), contentType: '' };
      } finally {
        clearTimeout(timer);
      }
    };
    const url = buildUrl();
    const res = await tryFetch(url);
    if (!res.ok) {
      throw new Error(`JK API 响应错误(${res.status})：${String(res.text || '').slice(0, 200)}`);
    }
    if (!res.json) {
      throw new Error(`JK API 返回非 JSON：${String(res.text || '无返回').slice(0, 200)}`);
    }
    const data = res.json;
    // 依据示例：成功时 code=1，字段：name/album/artist/music_url
    const ok = (data.code === 1) || (data.status === 1) || (data.success === true);
    if (!ok) {
      const msg = data.msg || data.message || '请求失败';
      throw new Error(`JK API: ${msg}`);
    }
    const item = {
      id: `jkapi-${(data.id || data.mid || data.songmid || data.name || '0')}-${Date.now()}`,
      title: data.name || '未知标题',
      artist: data.artist || '',
      url: data.music_url || data.url || '',
      cover: data.pic || data.cover || '',
      lrc: data.lrc || data.lyric || '',
      _platform: 'jkapi',
    };
    return [item];
  },
};

// 网易云适配器（基于 NeteaseCloudMusicApi）
const NeteaseAdapter = {
  name: 'netease',
  async search(query) {
    const res = await fetch(`${NETEASE_API_BASE}/cloudsearch?keywords=${encodeURIComponent(query)}&limit=20&type=1`, { credentials: 'omit' });
    const data = await res.json();
    const songs = (data.result && data.result.songs) || [];
    return songs.map(s => ({
      id: `netease-${s.id}`,
      title: s.name,
      artist: s.ar && s.ar.length ? s.ar.map(a => a.name).join('/') : '',
      // 真正播放 url 与歌词在 playTrack 时再解析
      url: '',
      cover: s.al && s.al.picUrl ? `${s.al.picUrl}?param=200y200` : '',
      lrc: '',
      _rawId: s.id,
      _platform: 'netease',
    }));
  },
  async resolveUrlAndLyric(rawId) {
    const [urlRes, lrcRes] = await Promise.all([
      fetch(`${NETEASE_API_BASE}/song/url/v1?id=${rawId}&level=standard`),
      fetch(`${NETEASE_API_BASE}/lyric?id=${rawId}`),
    ]);
    const urlData = await urlRes.json();
    const lrcData = await lrcRes.json();
    const url = urlData && urlData.data && urlData.data[0] && urlData.data[0].url ? urlData.data[0].url : '';
    const lrc = (lrcData && lrcData.lrc && lrcData.lrc.lyric) || '';
    return { url, lrc };
  },
};

// 普通适配器（指向 3200）
const CommonAdapter = {
  name: 'common',
  async search(query) {
    // 仅取第一条结果的 songmid，并同步获取歌词
    const url = `${COMMON_API_BASE}/getSearchByKey?key=${encodeURIComponent(query)}`;
    const res = await fetch(url, { credentials: 'omit' });
    const json = await res.json();
    const list = json && json.response && json.response.data && json.response.data.song && Array.isArray(json.response.data.song.list)
      ? json.response.data.song.list : [];
    if (!list.length) return [];
    const first = list[0];
    const songmid = first.songmid || first.strMediaMid || '';
    let lrc = '';
     if (songmid) {
       try {
         const lrcRes = await fetch(`${COMMON_API_BASE}/getLyric?songmid=${encodeURIComponent(songmid)}`, { credentials: 'omit' });
         const lrcJson = await lrcRes.json();
         console.log('歌词接口返回:', lrcJson); // 调试用
         // 兼容多种可能的字段路径
         lrc = (lrcJson?.response?.lyric || lrcJson?.lyric || lrcJson?.data?.lyric || lrcJson?.data?.response?.lyric || '') || '';
       } catch (e) {
         console.warn('获取歌词失败:', e);
       }
     }
    const title = first.songname || first.name || '';
    const artist = Array.isArray(first.singer) ? first.singer.map(s => s.name).join('/') : '';
    // QQ 相册图片可用 albummid 构造，也可留空
    const cover = first.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${first.albummid}.jpg` : '';
    return [{
      id: `common-${songmid || Date.now()}`,
      title,
      artist,
      url: '',
      cover,
      lrc,
      _songmid: songmid,
      _platform: 'common',
    }];
  },
   async resolveLyricBySongmid(songmid) {
     const lrcRes = await fetch(`${COMMON_API_BASE}/getLyric?songmid=${encodeURIComponent(songmid)}`, { credentials: 'omit' });
     const lrcJson = await lrcRes.json();
     console.log('懒加载歌词接口返回:', lrcJson); // 调试用
     const lrc = (lrcJson?.response?.lyric || lrcJson?.lyric || lrcJson?.data?.lyric || lrcJson?.data?.response?.lyric || '') || '';
     return { lrc };
   },
};

// 多源（普通 + 无铭）
const MultiCommonJkAdapter = {
  name: 'multi_common_jk',
  async search(query) {
    const [a, b] = await Promise.all([
      CommonAdapter.search(query).catch(() => []),
      JkApiAdapter.search(query).catch(() => []),
    ]);
     // 合并字段：按歌手姓名匹配，优先用 JK 的 url，普通的歌词
     const map = new Map();
     for (const t of [...a, ...b]) {
       // 只按第一个歌手姓名匹配，忽略标题差异和后续歌手，去除括号内容
       const firstArtist = (t.artist || '').split(/[/、,;]/)[0].trim();
       const cleanArtist = firstArtist.replace(/[（(].*?[）)]/g, '').trim();
       const key = cleanArtist.toLowerCase();
       if (!key) continue; // 跳过没有歌手的曲目
       
       const prev = map.get(key) || {};
       map.set(key, {
         id: prev.id || t.id,
         title: t.title || prev.title || '',
         artist: t.artist || prev.artist || '',
         url: (t._platform === 'jkapi' && t.url) ? t.url : (prev.url || t.url || ''),
         cover: t.cover || prev.cover || '',
         lrc: (t._platform === 'common' && t.lrc) ? t.lrc : (prev.lrc || t.lrc || ''),
         _songmid: t._songmid || prev._songmid,
         _platform: 'multi_common_jk',
       });
     }
    return Array.from(map.values());
  },
};

const Adapters = {
  demo: DemoAdapter,
  netease: NeteaseAdapter,
  common: CommonAdapter,
  multi_common_jk: MultiCommonJkAdapter,
  jkapi: JkApiAdapter,
  // qq: { search: async (q) => [] },
  // spotify: { search: async (q) => [] },
};

// 初始化
init();

function init() {
  loadPlaylistFromStorage();
  bindUI();
  if (state.queue.length > 0) {
    loadTrack(0);
  }
}

function bindUI() {
  btnPlay.addEventListener('click', togglePlay);
  btnPrev.addEventListener('click', playPrev);
  btnNext.addEventListener('click', playNext);
  btnShuffle.addEventListener('click', () => {
    state.isShuffle = !state.isShuffle;
    btnShuffle.style.opacity = state.isShuffle ? '1' : '0.6';
  });
  btnRepeat.addEventListener('click', () => {
    state.repeatMode = state.repeatMode === 'one' ? 'off' : 'one';
    btnRepeat.style.opacity = state.repeatMode === 'one' ? '1' : '0.6';
  });
  volumeEl.addEventListener('input', () => {
    audio.volume = Number(volumeEl.value);
  });
  progress.addEventListener('input', onSeek);
  audio.addEventListener('timeupdate', onTimeUpdate);
  audio.addEventListener('loadedmetadata', updateDuration);
  audio.addEventListener('ended', onEnded);
  audio.addEventListener('error', () => {
    const err = audio.error;
    let msg = '音频加载失败';
    if (err) {
      switch (err.code) {
        case MediaError.MEDIA_ERR_ABORTED: msg = '加载被中止'; break;
        case MediaError.MEDIA_ERR_NETWORK: msg = '网络错误，无法加载音频'; break;
        case MediaError.MEDIA_ERR_DECODE: msg = '音频解码失败（格式不被支持或文件损坏）'; break;
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: msg = '不支持的音频源或跨域受限'; break;
        default: msg = '未知错误';
      }
    }
    showPlayerTip(msg);
  });

  document.addEventListener('keydown', onHotkeys);

  searchBtn.addEventListener('click', onSearch);
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSearch();
  });
  platformSelect.addEventListener('change', () => {
    state.platform = platformSelect.value;
  });

  savePlaylistBtn.addEventListener('click', savePlaylistToStorage);
  clearPlaylistBtn.addEventListener('click', () => {
    state.queue = [];
    state.currentIndex = -1;
    renderPlaylist();
    persist();
    resetNowPlaying();
  });
}

function onHotkeys(e) {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'ArrowRight': seekBy(5); break;
    case 'ArrowLeft': seekBy(-5); break;
    case 'ArrowUp': setVolumeBy(0.05); break;
    case 'ArrowDown': setVolumeBy(-0.05); break;
  }
}

function setVolumeBy(delta) {
  const next = Math.min(1, Math.max(0, Number(volumeEl.value) + delta));
  volumeEl.value = String(next);
  audio.volume = next;
}

function seekBy(sec) {
  if (Number.isFinite(audio.currentTime)) {
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + sec));
  }
}

function onSeek() {
  if (!audio.duration) return;
  const ratio = Number(progress.value) / Number(progress.max);
  audio.currentTime = audio.duration * ratio;
}

function onTimeUpdate() {
  if (!audio.duration) return;
  const ratio = audio.currentTime / audio.duration;
  progress.value = String(Math.floor(Number(progress.max) * ratio));
  currentTimeEl.textContent = formatTime(audio.currentTime);
  // 歌词同步
  highlightLyricAt(audio.currentTime * 1000);
}

function updateDuration() {
  durationEl.textContent = formatTime(audio.duration || 0);
}

function onEnded() {
  if (state.repeatMode === 'one') {
    play();
    return;
  }
  playNext();
}

function togglePlay() { state.isPlaying ? pause() : play(); }

function play() {
  if (state.currentIndex < 0) {
    if (state.queue.length > 0) {
      loadTrack(0);
    } else {
      showPlayerTip('请先从搜索结果加入歌曲或点击“立即播放”');
      return;
    }
  }
  audio.play().then(() => {
    state.isPlaying = true;
    btnPlay.textContent = '⏸';
  }).catch(err => {
    console.warn('播放失败：', err);
    if (!audio.src) {
      showPlayerTip('当前无可播放音频地址');
    } else {
      showPlayerTip('播放失败，请稍后再试');
    }
  });
}

function pause() {
  audio.pause();
  state.isPlaying = false;
  btnPlay.textContent = '▶️';
}

function playPrev() {
  if (state.queue.length === 0) return;
  if (state.isShuffle) {
    loadTrack(randomIndex());
  } else {
    const next = (state.currentIndex - 1 + state.queue.length) % state.queue.length;
    loadTrack(next);
  }
  play();
}

function playNext() {
  if (state.queue.length === 0) return;
  if (state.isShuffle) {
    loadTrack(randomIndex());
  } else {
    const next = (state.currentIndex + 1) % state.queue.length;
    loadTrack(next);
  }
  play();
}

function randomIndex() {
  if (state.queue.length <= 1) return state.currentIndex;
  let idx = state.currentIndex;
  while (idx === state.currentIndex) {
    idx = Math.floor(Math.random() * state.queue.length);
  }
  return idx;
}

async function loadTrack(index) {
  const track = state.queue[index];
  if (!track) return;
  state.currentIndex = index;
  // 若为平台曲目且尚未解析真实 url/歌词，则先解析
  if (!track.url && track._platform === 'netease' && track._rawId) {
    try {
      const { url, lrc } = await NeteaseAdapter.resolveUrlAndLyric(track._rawId);
      track.url = url || track.url;
      if (lrc) track.lrc = lrc;
    } catch (e) {
      console.warn('解析网易云链接失败', e);
    }
  } else if (!track.lrc && track._platform === 'common' && track._songmid) {
    try {
      const { lrc } = await CommonAdapter.resolveLyricBySongmid(track._songmid);
      if (lrc) track.lrc = lrc;
    } catch (e) {
      console.warn('解析普通适配器歌词失败', e);
    }
  }
  audio.src = track.url;
  titleEl.textContent = track.title || '未知标题';
  artistEl.textContent = track.artist || '';
  coverEl.src = track.cover || '';
   // 解析歌词
   console.log('当前曲目歌词:', track.lrc); // 调试用
   state.currentLyrics = parseLRC(track.lrc || '');
   console.log('解析后歌词行数:', state.currentLyrics.length); // 调试用
   renderLyrics(state.currentLyrics);
   highlightLyricAt(0);
  // 更新列表高亮
  renderPlaylist();
}

function addToPlaylist(track) {
  if (state.queue.find(t => t.id === track.id)) return;
  state.queue.push(track);
  renderPlaylist();
  persist();
  if (state.currentIndex === -1) {
    loadTrack(0);
  }
}

function removeFromPlaylist(id) {
  const idx = state.queue.findIndex(t => t.id === id);
  if (idx === -1) return;
  state.queue.splice(idx, 1);
  if (state.currentIndex >= state.queue.length) state.currentIndex = state.queue.length - 1;
  renderPlaylist();
  persist();
}

function moveInPlaylist(from, to) {
  if (from === to) return;
  const item = state.queue.splice(from, 1)[0];
  state.queue.splice(to, 0, item);
  if (state.currentIndex === from) state.currentIndex = to;
  renderPlaylist();
  persist();
}

function renderPlaylist() {
  playlistEl.innerHTML = '';
  state.queue.forEach((t, i) => {
    const li = document.createElement('li');
    if (i === state.currentIndex) li.style.outline = '2px solid var(--accent)';
    const img = document.createElement('img'); img.src = t.cover || ''; img.className = 'cover';
    const meta = document.createElement('div'); meta.className = 'meta';
    const title = document.createElement('div'); title.className = 'title'; title.textContent = t.title;
    const artist = document.createElement('div'); artist.className = 'artist'; artist.textContent = t.artist;
    meta.append(title, artist);
    const actions = document.createElement('div'); actions.className = 'actions';
    const playBtn = document.createElement('button'); playBtn.textContent = '播放'; playBtn.addEventListener('click', () => { loadTrack(i); play(); });
    const delBtn = document.createElement('button'); delBtn.textContent = '移除'; delBtn.addEventListener('click', () => removeFromPlaylist(t.id));
    actions.append(playBtn, delBtn);
    li.append(img, meta, actions);
    // 拖拽排序
    li.draggable = true;
    li.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(i)); });
    li.addEventListener('dragover', (e) => { e.preventDefault(); });
    li.addEventListener('drop', (e) => { e.preventDefault(); const from = Number(e.dataTransfer.getData('text/plain')); moveInPlaylist(from, i); });
    playlistEl.appendChild(li);
  });
}

async function onSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  const adapter = Adapters[state.platform] || DemoAdapter;
  renderSearchMessage('正在搜索...');
  try {
    const results = await adapter.search(q);
    if (!Array.isArray(results) || results.length === 0) {
      renderSearchMessage('未找到相关结果');
      return;
    }
    renderSearchResults(results);
  } catch (e) {
    console.warn('搜索失败：', e);
    if (state.platform === 'netease') {
      renderSearchMessage('无法连接网易云 API。请先启动本地 NeteaseCloudMusicApi（默认 http://localhost:3000）。');
    } else if (state.platform === 'jkapi') {
      renderSearchMessage(`JK API 请求失败：${e?.message || e}`);
    } else {
      renderSearchMessage('搜索失败，请稍后重试');
    }
  }
}

function renderSearchResults(results) {
  searchResultsEl.innerHTML = '';
  results.forEach(t => {
    const li = document.createElement('li');
    const img = document.createElement('img'); img.src = t.cover || ''; img.className = 'cover';
    const meta = document.createElement('div'); meta.className = 'meta';
    const title = document.createElement('div'); title.className = 'title'; title.textContent = t.title;
    const artist = document.createElement('div'); artist.className = 'artist'; artist.textContent = t.artist;
    meta.append(title, artist);
    const actions = document.createElement('div'); actions.className = 'actions';
    const addBtn = document.createElement('button'); addBtn.textContent = '加入歌单'; addBtn.addEventListener('click', () => addToPlaylist(t));
    const playBtn = document.createElement('button'); playBtn.textContent = '立即播放'; playBtn.addEventListener('click', () => { addToPlaylist(t); loadTrack(state.queue.findIndex(x => x.id === t.id)); play(); });
    actions.append(addBtn, playBtn);
    li.append(img, meta, actions);
    searchResultsEl.appendChild(li);
  });
}

function renderSearchMessage(text) {
  searchResultsEl.innerHTML = '';
  const li = document.createElement('li');
  li.textContent = text;
  searchResultsEl.appendChild(li);
}

function formatTime(sec) {
  sec = Math.floor(sec || 0);
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function parseLRC(lrc) {
  const lines = lrc.split(/\r?\n/);
  const result = [];
  const timeTag = /\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;
  for (const line of lines) {
    let match;
    const text = line.replace(timeTag, '').trim();
    while ((match = timeTag.exec(line)) !== null) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const ms = Number((match[3] || '0').padEnd(3, '0'));
      const timeMs = min * 60000 + sec * 1000 + ms;
      result.push({ timeMs, text });
    }
  }
  return result.sort((a, b) => a.timeMs - b.timeMs);
}

function renderLyrics(parsed) {
  lyricsEl.innerHTML = '';
  for (const item of parsed) {
    const div = document.createElement('div');
    div.className = 'line';
    div.dataset.time = String(item.timeMs);
    div.textContent = item.text || '\u00A0';
    lyricsEl.appendChild(div);
  }
}

function highlightLyricAt(currentMs) {
  if (!state.currentLyrics.length) return;
  let activeIndex = -1;
  for (let i = 0; i < state.currentLyrics.length; i++) {
    const here = state.currentLyrics[i].timeMs;
    const next = i + 1 < state.currentLyrics.length ? state.currentLyrics[i + 1].timeMs : Number.POSITIVE_INFINITY;
    if (currentMs >= here && currentMs < next) { activeIndex = i; break; }
  }
  const children = Array.from(lyricsEl.children);
  children.forEach((el, idx) => {
    if (idx === activeIndex) {
      el.classList.add('active');
      // 居中滚动
      const box = lyricsEl.getBoundingClientRect();
      const line = el.getBoundingClientRect();
      const delta = (line.top + line.height / 2) - (box.top + box.height / 2);
      lyricsEl.scrollTop += delta;
    } else {
      el.classList.remove('active');
    }
  });
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ queue: state.queue })); } catch {}
}

// 简单的播放器区域提示
function showPlayerTip(text) {
  if (!text) return;
  const div = document.createElement('div');
  div.textContent = text;
  div.style.position = 'fixed';
  div.style.left = '50%';
  div.style.top = '20px';
  div.style.transform = 'translateX(-50%)';
  div.style.background = 'rgba(0,0,0,0.7)';
  div.style.color = '#fff';
  div.style.padding = '8px 12px';
  div.style.borderRadius = '8px';
  div.style.zIndex = '9999';
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 1500);
}

function savePlaylistToStorage() {
  persist();
  if (savePlaylistBtn) {
    const original = savePlaylistBtn.textContent;
    savePlaylistBtn.disabled = true;
    savePlaylistBtn.textContent = '已保存';
    setTimeout(() => {
      savePlaylistBtn.textContent = original;
      savePlaylistBtn.disabled = false;
    }, 800);
  }
}

function loadPlaylistFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (Array.isArray(obj.queue)) { state.queue = obj.queue; }
    renderPlaylist();
  } catch {}
}

function resetNowPlaying() {
  titleEl.textContent = '未播放';
  artistEl.textContent = '';
  coverEl.src = '';
  lyricsEl.innerHTML = '';
  state.currentIndex = -1;
  pause();
}

