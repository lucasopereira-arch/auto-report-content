const CLICKUP_TOKEN = process.env.CLICKUP_TOKEN;
const YOUTUBE_KEY   = process.env.YOUTUBE_KEY;

const LISTS = {
  instagram: '901300920768',
  victor:    '901314630051',
  andre:     '901314629869',
  turbocast: '901314630142',
};

const YT_CHANNELS = {
  victor:    '@victor.peixoto',
  andre:     '@andremusso1',
  turbocast: '@Turbo.podcast',
};

// Thresholds in seconds
const CORTE_CURTO_MAX = 120;  // < 2min
const CORTE_LONGO_MAX = 600;  // 2–10min, above = YT LONGO

// ── ClickUp helpers ──────────────────────────────────────

async function fetchTasks(listId, startTs, endTs) {
  const params = new URLSearchParams({
    include_closed: 'true',
    subtasks: 'true',
    date_done_gt: String(startTs),
    date_done_lt: String(endTs),
    page: '0',
  });
  const url = `https://api.clickup.com/api/v2/list/${listId}/task?${params}`;
  const res = await fetch(url, { headers: { Authorization: CLICKUP_TOKEN } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`ClickUp list ${listId}: ${res.status} ${txt}`);
  }
  const data = await res.json();
  return data.tasks || [];
}

function getFormat(task) {
  const cf = task.custom_fields || [];
  const field = cf.find(f => f.name === 'Formato do post');
  if (!field) return null;
  // dropdown: value is the option id, type_config.options has the labels
  if (field.type === 'drop_down' || field.type === 'dropdown') {
    const opts = field.type_config?.options || [];
    const selected = opts.find(o => o.orderindex === field.value || o.id === field.value);
    return selected ? selected.name.toUpperCase() : null;
  }
  // fallback
  if (typeof field.value === 'string') return field.value.toUpperCase();
  if (Array.isArray(field.value) && field.value[0]) {
    return (field.value[0].name || field.value[0]).toUpperCase();
  }
  return null;
}

function hasStatus(task, statuses) {
  return statuses.includes((task.status?.status || '').toLowerCase());
}

function countFormats(tasks, { onlySubtasks, statuses, formatFilter }) {
  const counts = {};
  for (const t of tasks) {
    const isSub = !!t.parent;
    if (onlySubtasks && !isSub) continue;
    if (!onlySubtasks && isSub) continue;
    if (!hasStatus(t, statuses)) continue;
    const fmt = getFormat(t);
    if (!fmt) continue;
    if (formatFilter && !formatFilter.includes(fmt)) continue;
    counts[fmt] = (counts[fmt] || 0) + 1;
  }
  return counts;
}

async function processClickUp(startTs, endTs) {
  const [igTasks, victorTasks, andreTasks, castTasks] = await Promise.all([
    fetchTasks(LISTS.instagram,  startTs, endTs),
    fetchTasks(LISTS.victor,     startTs, endTs),
    fetchTasks(LISTS.andre,      startTs, endTs),
    fetchTasks(LISTS.turbocast,  startTs, endTs),
  ]);

  // Instagram: only subtasks, status postado
  const ig = countFormats(igTasks, { onlySubtasks: true, statuses: ['postado'] });

  // Victor: parent = postado (YT LONGO), subtasks = postado (LINKEDIN)
  const victorParent = countFormats(victorTasks, { onlySubtasks: false, statuses: ['postado'] });
  const victorSub    = countFormats(victorTasks, { onlySubtasks: true,  statuses: ['postado'], formatFilter: ['LINKEDIN'] });
  const victor = { ...victorParent, ...victorSub };

  // André: parent = complete (YT LONGO), subtasks = postado (LINKEDIN, REELS, IMG ÚNICA)
  const andreParent = countFormats(andreTasks, { onlySubtasks: false, statuses: ['complete'] });
  const andreSub    = countFormats(andreTasks, { onlySubtasks: true,  statuses: ['postado'], formatFilter: ['LINKEDIN', 'REELS', 'IMG ÚNICA'] });
  const andre = { ...andreParent, ...andreSub };

  // TurboCast: parent = complete
  const cast = countFormats(castTasks, { onlySubtasks: false, statuses: ['complete'] });

  return { ig, victor, andre, cast };
}

// ── YouTube helpers ───────────────────────────────────────

function parseISO8601(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1]||0)*3600) + (parseInt(m[2]||0)*60) + parseInt(m[3]||0);
}

async function getChannelId(handle) {
  const url = `https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=${encodeURIComponent(handle)}&key=${YOUTUBE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  return data.items?.[0]?.id;
}

async function fetchYTVideos(channelId, publishedAfter, publishedBefore) {
  let videoIds = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      part: 'id', channelId, type: 'video',
      publishedAfter, publishedBefore,
      maxResults: '50', key: YOUTUBE_KEY,
      ...(pageToken ? { pageToken } : {}),
    });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await res.json();
    videoIds = videoIds.concat((data.items||[]).map(v => v.id.videoId));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  if (!videoIds.length) return { 'YT LONGO': 0, 'CORTE LONGO': 0, 'CORTE CURTO': 0 };

  const ids = videoIds.join(',');
  const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${ids}&key=${YOUTUBE_KEY}`);
  const data = await res.json();

  const counts = { 'YT LONGO': 0, 'CORTE LONGO': 0, 'CORTE CURTO': 0 };
  for (const item of data.items || []) {
    const dur = parseISO8601(item.contentDetails.duration);
    if (dur < CORTE_CURTO_MAX)      counts['CORTE CURTO']++;
    else if (dur < CORTE_LONGO_MAX) counts['CORTE LONGO']++;
    else                            counts['YT LONGO']++;
  }
  return counts;
}

async function processYouTube(publishedAfter, publishedBefore) {
  const [victorId, andreId, castId] = await Promise.all([
    getChannelId(YT_CHANNELS.victor),
    getChannelId(YT_CHANNELS.andre),
    getChannelId(YT_CHANNELS.turbocast),
  ]);

  const [victorYT, andreYT, castYT] = await Promise.all([
    fetchYTVideos(victorId, publishedAfter, publishedBefore),
    fetchYTVideos(andreId,  publishedAfter, publishedBefore),
    fetchYTVideos(castId,   publishedAfter, publishedBefore),
  ]);

  return { victorYT, andreYT, castYT };
}

// ── Main handler ─────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
  }

  try {
    // Timestamps in milliseconds for ClickUp
    const startTs = new Date(startDate + 'T00:00:00.000Z').getTime();
    const endTs   = new Date(endDate   + 'T23:59:59.999Z').getTime();

    // ISO strings for YouTube
    const publishedAfter  = new Date(startDate + 'T00:00:00.000Z').toISOString();
    const publishedBefore = new Date(endDate   + 'T23:59:59.999Z').toISOString();

    const [clickup, youtube] = await Promise.all([
      processClickUp(startTs, endTs),
      processYouTube(publishedAfter, publishedBefore),
    ]);

    const report = {
      'André Musso': {
        ...clickup.andre,
        'CORTE CURTO': youtube.andreYT['CORTE CURTO'],
        'CORTE LONGO': youtube.andreYT['CORTE LONGO'],
      },
      'Victor Peixoto': {
        ...clickup.victor,
        'CORTE CURTO': youtube.victorYT['CORTE CURTO'],
        'CORTE LONGO': youtube.victorYT['CORTE LONGO'],
      },
      'Instagram Turbo': clickup.ig,
      'Turbo Cast': {
        ...clickup.cast,
        'CORTE CURTO': youtube.castYT['CORTE CURTO'],
        'CORTE LONGO': youtube.castYT['CORTE LONGO'],
        'YT LONGO': clickup.cast['YT LONGO'] || youtube.castYT['YT LONGO'],
      },
    };

    return res.status(200).json({ ok: true, report, period: { startDate, endDate } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}
