const express = require('express')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const app = express()
const PORT = 8080
const BASE_URL = 'https://tubi.nirajan-paudel.com.np'
const MOVIES_DIR = path.join(__dirname, 'movies')

// Ensure movies directory exists
if (!fs.existsSync(MOVIES_DIR)) fs.mkdirSync(MOVIES_DIR, { recursive: true })

// --- Helpers ---

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '') // strip extension
    .replace(/[^a-z0-9]+/g, '-') // non-alphanum → dash
    .replace(/^-|-$/g, '') // trim dashes
}

function titleFromSlug(slug) {
  return slug
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

// --- Auto thumbnail extraction (ffmpeg) ---

// Get video duration in seconds using ffprobe. Falls back to null on failure.
function getDuration(videoPath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath,
      ],
      (err, stdout) => {
        if (err) return resolve(null)
        const seconds = parseFloat(stdout)
        resolve(Number.isFinite(seconds) ? seconds : null)
      },
    )
  })
}

// Grab a single frame from the video and save it as a JPEG thumbnail.
// Picks a random-ish timestamp (10%-60% into the video) so we avoid black
// intro frames / studio cards, and so repeated regen gives some variety.
function extractThumbnail(videoPath, outPath) {
  return new Promise(async (resolve) => {
    const duration = await getDuration(videoPath)
    const pickSeconds = duration
      ? Math.max(1, duration * (0.1 + Math.random() * 0.5))
      : 5 // fallback if duration probe fails

    execFile(
      'ffmpeg',
      [
        '-y',
        '-ss',
        String(pickSeconds),
        '-i',
        videoPath,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=640:-1',
        outPath,
      ],
      (err) => {
        if (err) {
          console.error(
            `Thumbnail extraction failed for ${path.basename(videoPath)}:`,
            err.message,
          )
          return resolve(false)
        }
        resolve(true)
      },
    )
  })
}

// Tracks in-flight extraction jobs so we never run ffmpeg twice for the same file
// (e.g. two people hitting the homepage at once before the first job finishes).
const pendingThumbnails = new Map()

function ensureThumbnail(videoPath, jpgPath) {
  if (fs.existsSync(jpgPath)) return Promise.resolve(true)

  if (pendingThumbnails.has(jpgPath)) return pendingThumbnails.get(jpgPath)

  const job = extractThumbnail(videoPath, jpgPath).finally(() => {
    pendingThumbnails.delete(jpgPath)
  })
  pendingThumbnails.set(jpgPath, job)
  return job
}

// --- Codec compatibility check + cached transcode ---
//
// Phones (especially iOS Safari, and most Android browsers/WebViews) only
// reliably support H.264 video + AAC audio inside an mp4. Movie rips often
// have H.264 video but AC3/DTS/EAC3 audio, or HEVC video — either mismatch
// makes the browser silently drop the track it can't decode, which shows up
// as "video plays but no sound" or "audio plays but no picture". We probe
// each file once, and if it isn't web-safe we transcode it into a cached
// copy that is, then serve that copy instead of the original.

const TRANSCODE_DIR = path.join(MOVIES_DIR, '.web-cache')
if (!fs.existsSync(TRANSCODE_DIR))
  fs.mkdirSync(TRANSCODE_DIR, { recursive: true })

function probeCodecs(videoPath) {
  return new Promise((resolve) => {
    execFile(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_entries',
        'stream=codec_name,codec_type:format_tags=compatible_brands',
        videoPath,
      ],
      (err, stdout) => {
        if (err) return resolve(null)
        try {
          const data = JSON.parse(stdout)
          const streams = data.streams || []
          const videoCodec =
            streams.find((s) => s.codec_type === 'video')?.codec_name || null
          const audioCodec =
            streams.find((s) => s.codec_type === 'audio')?.codec_name || null
          const compatibleBrands = data.format?.tags?.compatible_brands || ''
          const isFragmented = compatibleBrands.includes('iso5') || compatibleBrands.includes('iso6') || compatibleBrands.includes('dash')
          resolve({ videoCodec, audioCodec, isFragmented })
        } catch {
          resolve(null)
        }
      },
    )
  })
}

function isWebSafe(codecs) {
  if (!codecs) return true // if we can't tell, don't block playback — assume fine
  if (codecs.isFragmented) return false
  const videoOk = !codecs.videoCodec || codecs.videoCodec === 'h264'
  const audioOk = !codecs.audioCodec || ['aac', 'mp3'].includes(codecs.audioCodec)
  return videoOk && audioOk
}

// Transcode to H.264 + AAC. If the video track is already h264 we just copy
// it (remux) which is near-instant; only the audio gets re-encoded. If the
// video itself is incompatible (e.g. HEVC) it needs a real re-encode — we
// try NVENC (GPU) first since it's dramatically faster than software x264
// on a multi-GB file, and fall back to CPU libx264 automatically if NVENC
// isn't available or the encode fails for any reason (no GPU, driver issue,
// unsupported codec, etc.) so playback never breaks because of this.
function runFfmpeg(args) {
  return new Promise((resolve) => {
    // -nostats -loglevel error keeps stderr small (just real errors), and
    // maxBuffer is raised well above default since a multi-hour run could
    // otherwise overflow Node's 1MB default and get killed mid-transcode.
    execFile(
      'ffmpeg',
      ['-nostats', '-loglevel', 'error', ...args],
      { maxBuffer: 1024 * 1024 * 20 }, // 20MB
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, stderr })
        resolve({ ok: true })
      },
    )
  })
}

// Marker file convention: a cached transcode that has passed duration
// verification gets a sibling ".ok" file written next to it, so future
// requests can trust it without re-probing every time.
function markerPath(cachedPath) {
  return cachedPath + '.ok'
}

async function transcodeForWeb(videoPath, outPath, codecs) {
  const cleanup = () => {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    } catch {}
    try {
      if (fs.existsSync(markerPath(outPath))) fs.unlinkSync(markerPath(outPath))
    } catch {}
  }

  // After any transcode, confirm the output's duration roughly matches the
  // source. ffmpeg can exit with a "success" status code while still having
  // produced a truncated/incomplete file (interrupted process, faststart
  // remux cut short, etc.) — without this check a bad file gets cached
  // forever and silently served as if it were fine.
  async function verifyComplete(sourceDuration) {
    if (sourceDuration == null) return true // can't verify, don't block on it
    const outDuration = await getDuration(outPath)
    if (outDuration == null) return false
    const ok = outDuration >= sourceDuration * 0.95 // allow small rounding slack
    if (ok) {
      try {
        fs.writeFileSync(markerPath(outPath), '')
      } catch {}
    } else {
      console.error(
        `Output duration mismatch for ${path.basename(outPath)}: ` +
          `expected ~${sourceDuration.toFixed(1)}s, got ${outDuration.toFixed(1)}s — treating as failed`,
      )
    }
    return ok
  }

  const sourceDuration = await getDuration(videoPath)

  // Audio-only fix: video is already h264, just remux + fix audio. This is
  // fast on CPU already (no video re-encoding happens), so no GPU needed.
  if (codecs?.videoCodec === 'h264') {
    console.log(`Remuxing (audio fix only) for ${path.basename(videoPath)}...`)
    
    const audioIsSafe = codecs.audioCodec && ['aac', 'mp3'].includes(codecs.audioCodec)
    const audioArgs = audioIsSafe ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']

    const start = Date.now()
    const result = await runFfmpeg([
      '-y',
      '-i',
      videoPath,
      '-c:v',
      'copy',
      ...audioArgs,
      '-movflags',
      '+faststart',
      outPath,
    ])
    if (!result.ok || !(await verifyComplete(sourceDuration))) {
      console.error(
        `Remux failed or incomplete for ${path.basename(videoPath)}`,
      )
      cleanup()
      return false
    }
    console.log(
      `Remux finished in ${Math.round((Date.now() - start) / 1000)}s: ${path.basename(videoPath)}`,
    )
    return true
  }

  // Video itself needs re-encoding (e.g. HEVC source). Try GPU (NVENC) first.
  console.log(
    `Attempting GPU (NVENC) transcode for ${path.basename(videoPath)}...`,
  )
  const gpuStart = Date.now()
  const gpuResult = await runFfmpeg([
    '-y',
    '-hwaccel',
    'cuda',
    '-hwaccel_output_format',
    'cuda',
    '-i',
    videoPath,
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p1', // p1 (fastest) .. p7 (slowest/best quality)
    '-rc',
    'vbr',
    '-cq',
    '23',
    '-b:v',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    outPath,
  ])
  if (gpuResult.ok && (await verifyComplete(sourceDuration))) {
    console.log(
      `GPU transcode finished in ${Math.round((Date.now() - gpuStart) / 1000)}s: ${path.basename(videoPath)}`,
    )
    return true
  }

  if (gpuResult.ok) {
    console.warn(
      `NVENC produced an incomplete file for ${path.basename(videoPath)}, falling back to CPU...`,
    )
  } else {
    console.warn(
      `NVENC transcode failed for ${path.basename(videoPath)} (${gpuResult.stderr?.slice(-300) || 'unknown error'}), falling back to CPU...`,
    )
  }
  cleanup()

  // CPU fallback — slower, but reliable on any machine.
  const cpuStart = Date.now()
  const cpuResult = await runFfmpeg([
    '-y',
    '-threads',
    '0',
    '-i',
    videoPath,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '160k',
    '-movflags',
    '+faststart',
    outPath,
  ])
  if (!cpuResult.ok || !(await verifyComplete(sourceDuration))) {
    console.error(
      `CPU transcode also failed or incomplete for ${path.basename(videoPath)}`,
    )
    cleanup()
    return false
  }
  console.log(
    `CPU transcode finished in ${Math.round((Date.now() - cpuStart) / 1000)}s: ${path.basename(videoPath)}`,
  )
  return true
}

const pendingTranscodes = new Map()

// Cached transcodes get a small marker file (".ok") written right after they
// pass the duration check (see markerPath above), so future requests can
// trust them without re-probing every time. If a cached .web.mp4 exists
// WITHOUT its .ok marker — e.g. it was produced before this verification
// step existed, or the marker write itself got interrupted — we don't trust
// it blindly; we re-verify its duration against the source once, and
// regenerate it if it turns out to be incomplete (this is what catches
// already-corrupted cache entries from before this fix, not just new ones).
async function isCachedFileTrustworthy(cachedPath, videoPath) {
  if (fs.existsSync(markerPath(cachedPath))) return true

  // No marker — verify once now, and write the marker if it checks out so
  // we don't have to do this again next time.
  const [sourceDuration, cachedDuration] = await Promise.all([
    getDuration(videoPath),
    getDuration(cachedPath),
  ])
  if (sourceDuration == null || cachedDuration == null) return true // can't tell, don't block
  const ok = cachedDuration >= sourceDuration * 0.95
  if (ok) {
    try {
      fs.writeFileSync(markerPath(cachedPath), '')
    } catch {}
  } else {
    console.warn(
      `Cached file ${path.basename(cachedPath)} looks incomplete ` +
        `(expected ~${sourceDuration.toFixed(1)}s, found ${cachedDuration.toFixed(1)}s) — will regenerate`,
    )
  }
  return ok
}

// Quick check: does this file need transcoding, and is a cached copy ready?
// Does not start a transcode — just reports status so the caller can decide
// whether to show a "preparing video" interstitial or play immediately.
async function checkVideoStatus(file) {
  const videoPath = path.join(MOVIES_DIR, file)
  const cachedName = path.basename(file, '.mp4') + '.web.mp4'
  const cachedPath = path.join(TRANSCODE_DIR, cachedName)
  const cachedUrl = `/movies/.web-cache/${encodeURIComponent(cachedName)}`
  const originalUrl = `/movies/${encodeURIComponent(file)}`

  if (pendingTranscodes.has(cachedPath)) return { ready: false, url: cachedUrl }

  if (fs.existsSync(cachedPath)) {
    const trustworthy = await isCachedFileTrustworthy(cachedPath, videoPath)
    if (trustworthy) return { ready: true, url: cachedUrl }

    // Bad cache entry — remove it and fall through to re-transcode.
    try {
      fs.unlinkSync(cachedPath)
    } catch {}
    try {
      fs.unlinkSync(markerPath(cachedPath))
    } catch {}
  }

  const codecs = await probeCodecs(videoPath)
  if (isWebSafe(codecs)) return { ready: true, url: originalUrl }

  return {
    ready: false,
    url: cachedUrl,
    needsStart: true,
    videoPath,
    cachedPath,
    codecs,
  }
}

// Kicks off (or reuses) the background transcode job for a file. Returns the
// promise so a caller can await full completion if it wants to.
function startTranscode(videoPath, cachedPath, codecs) {
  let job = pendingTranscodes.get(cachedPath)
  if (!job) {
    job = transcodeForWeb(videoPath, cachedPath, codecs).finally(() => {
      pendingTranscodes.delete(cachedPath)
    })
    pendingTranscodes.set(cachedPath, job)
  }
  return job
}

// Returns the relative URL path (under /movies) that should actually be
// served for this file — either the original, or a cached web-safe copy.
// Awaits the full transcode if one is needed (used by the polling endpoint
// and as a fallback path).
async function ensureWebSafeVideo(file) {
  const status = await checkVideoStatus(file)
  if (status.ready) return status.url

  const job = status.needsStart
    ? startTranscode(status.videoPath, status.cachedPath, status.codecs)
    : pendingTranscodes.get(status.cachedPath) || Promise.resolve(true)

  const ok = await job
  return ok ? status.url : `/movies/${encodeURIComponent(file)}`
}

async function scanMovies() {
  if (!fs.existsSync(MOVIES_DIR)) return []

  const entries = fs.readdirSync(MOVIES_DIR)
  const movies = []

  for (const file of entries) {
    if (!file.toLowerCase().endsWith('.mp4')) continue

    const baseName = path.basename(file, '.mp4')
    const slug = slugify(baseName)
    const videoPath = path.join(MOVIES_DIR, file)

    // Thumbnail: prefer an existing .jpg/.png with same base name (manual override).
    // If neither exists, auto-extract one with ffmpeg and cache it as .jpg.
    const thumbJpg = path.join(MOVIES_DIR, baseName + '.jpg')
    const thumbPng = path.join(MOVIES_DIR, baseName + '.png')

    let thumbFile = null
    if (fs.existsSync(thumbPng)) {
      thumbFile = thumbPng
    } else {
      const ok = await ensureThumbnail(videoPath, thumbJpg)
      if (ok || fs.existsSync(thumbJpg)) thumbFile = thumbJpg
    }

    // Metadata sidecar: same base name + .json
    const metaFile = path.join(MOVIES_DIR, baseName + '.json')
    let meta = {}
    if (fs.existsSync(metaFile)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
      } catch {}
    }

    const title = meta.title || titleFromSlug(slug)
    const description = meta.description || 'Watch together on Rave'
    const year = meta.year || null

    movies.push({
      slug,
      file,
      title,
      description,
      year,
      thumb: thumbFile ? `/movies/${path.basename(thumbFile)}` : null,
      video: `/movies/${encodeURIComponent(file)}`,
      pageUrl: `${BASE_URL}/watch/${slug}`,
    })
  }

  // Sort by title
  movies.sort((a, b) => a.title.localeCompare(b.title))
  return movies
}

// --- CORS & logging ---

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Range')
  res.header('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Encoding, Content-Length, Content-Range')
  next()
})

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
  next()
})

// --- Static files from movies/ ---

app.use('/movies', express.static(MOVIES_DIR, { dotfiles: 'allow' }))

// --- Shared styles ---

const SHARED_STYLES = `
    *{margin:0;padding:0;box-sizing:border-box}
    :root{
      --bg:#0b0b0f;
      --bg-elev:#15151c;
      --card:#1a1a22;
      --card-hover:#232330;
      --text:#f2f2f5;
      --text-dim:#9a9aa6;
      --accent:#ff5a5f;
      --accent-glow:rgba(255,90,95,.35);
    }
    body{
      background:radial-gradient(circle at 20% -10%, #1d1d28 0%, var(--bg) 55%);
      color:var(--text);
      font-family:'Segoe UI',system-ui,-apple-system,sans-serif;
      min-height:100vh;
    }
    a{color:inherit}
`

// --- Homepage ---

app.get('/', async (req, res) => {
  const movies = await scanMovies()

  const cards = movies
    .map(
      (m) => `
      <a class="card" href="/watch/${m.slug}" data-title="${m.title.toLowerCase()}">
        <div class="thumb-wrap">
          ${
            m.thumb
              ? `<img src="${m.thumb}" alt="${m.title}" loading="lazy" />`
              : `<div class="placeholder">${m.title.charAt(0)}</div>`
          }
          <div class="play-overlay">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="white"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </div>
        <div class="card-title">${m.title}</div>
        ${m.year ? `<div class="card-year">${m.year}</div>` : ''}
      </a>`,
    )
    .join('\n')

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Movie Server</title>
  <style>
    ${SHARED_STYLES}
    header{
      padding:32px 32px 24px;
      display:flex;
      align-items:center;
      gap:18px;
      flex-wrap:wrap;
      justify-content:space-between;
    }
    .title-row{
      display:flex;
      align-items:baseline;
      gap:14px;
      flex-wrap:wrap;
    }
    h1{
      font-size:1.9rem;
      font-weight:700;
      letter-spacing:-.02em;
      background:linear-gradient(90deg,#fff,#cfcfe0);
      -webkit-background-clip:text;
      background-clip:text;
      color:transparent;
    }
    .count{color:var(--text-dim);font-size:.95rem}
    .search-wrap{
      position:relative;
      flex:1 1 260px;
      max-width:340px;
    }
    .search-wrap svg{
      position:absolute;
      left:14px;
      top:50%;
      transform:translateY(-50%);
      color:var(--text-dim);
      pointer-events:none;
    }
    #search{
      width:100%;
      background:var(--card);
      border:1px solid rgba(255,255,255,.08);
      border-radius:999px;
      padding:10px 16px 10px 40px;
      color:var(--text);
      font-size:.92rem;
      outline:none;
      transition:border-color .2s ease, background .2s ease;
    }
    #search::placeholder{color:var(--text-dim)}
    #search:focus{border-color:var(--accent);background:var(--card-hover)}
    main{padding:0 32px 56px}
    .grid{
      display:grid;
      grid-template-columns:repeat(auto-fill,minmax(190px,1fr));
      gap:22px;
    }
    .no-results{
      display:none;
      color:var(--text-dim);
      text-align:center;
      margin-top:60px;
      font-size:1rem;
    }

    @media (max-width:640px){
      header{padding:22px 16px 18px;gap:14px}
      h1{font-size:1.5rem}
      .search-wrap{flex:1 1 100%;max-width:none}
      main{padding:0 16px 40px}
      .grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:14px}
      .card-title{font-size:.82rem;padding:9px 10px 1px}
      .card-year{font-size:.72rem;padding:0 10px 9px}
      .placeholder{font-size:2rem}
    }
    @media (max-width:400px){
      .grid{grid-template-columns:repeat(2,1fr);gap:12px}
    }
    .card{
      background:var(--card);
      border-radius:12px;
      overflow:hidden;
      text-decoration:none;
      color:var(--text);
      display:block;
      transition:transform .2s ease, box-shadow .2s ease, background .2s ease;
      border:1px solid rgba(255,255,255,.04);
    }
    .card:hover{
      transform:translateY(-4px) scale(1.015);
      background:var(--card-hover);
      box-shadow:0 14px 30px -10px var(--accent-glow), 0 0 0 1px rgba(255,255,255,.06);
    }
    .thumb-wrap{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;background:#000}
    .card img{width:100%;height:100%;object-fit:cover;display:block}
    .placeholder{
      width:100%;height:100%;
      background:linear-gradient(135deg,#2a2a38,#181820);
      display:flex;align-items:center;justify-content:center;
      font-size:2.6rem;font-weight:700;color:#666;
    }
    .play-overlay{
      position:absolute;inset:0;
      display:flex;align-items:center;justify-content:center;
      background:rgba(0,0,0,0);
      opacity:0;
      transition:opacity .2s ease, background .2s ease;
    }
    .play-overlay svg{
      filter:drop-shadow(0 2px 6px rgba(0,0,0,.5));
      transform:scale(.85);
      transition:transform .2s ease;
    }
    .card:hover .play-overlay{opacity:1;background:rgba(0,0,0,.25)}
    .card:hover .play-overlay svg{transform:scale(1)}
    .card-title{
      padding:12px 14px 2px;
      font-size:.92rem;
      font-weight:600;
      line-height:1.3;
      white-space:nowrap;
      overflow:hidden;
      text-overflow:ellipsis;
    }
    .card-year{padding:0 14px 12px;font-size:.78rem;color:var(--text-dim)}
    .empty{
      color:var(--text-dim);
      margin-top:60px;
      text-align:center;
      font-size:1rem;
    }
    .empty code{
      background:var(--bg-elev);
      padding:2px 8px;
      border-radius:4px;
      color:var(--accent);
    }
  </style>
</head>
<body>
  <header>
    <div class="title-row">
      <h1>Movies</h1>
      ${movies.length ? `<span class="count" id="count">${movies.length} title${movies.length === 1 ? '' : 's'}</span>` : ''}
    </div>
    ${
      movies.length
        ? `<div class="search-wrap">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="search" type="search" placeholder="Search movies..." autocomplete="off" />
          </div>`
        : ''
    }
  </header>
  <main>
  ${
    movies.length
      ? `<div class="grid" id="grid">${cards}</div><p class="no-results" id="no-results">No movies match your search.</p>`
      : `<p class="empty">Drop .mp4 files into the <code>movies/</code> folder to get started.</p>`
  }
  </main>
  ${
    movies.length
      ? `<script>
    const search = document.getElementById('search')
    const cardsEls = Array.from(document.querySelectorAll('.card'))
    const countEl = document.getElementById('count')
    const noResults = document.getElementById('no-results')
    const grid = document.getElementById('grid')

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase()
      let visible = 0
      for (const card of cardsEls) {
        const match = card.dataset.title.includes(q)
        card.style.display = match ? '' : 'none'
        if (match) visible++
      }
      countEl.textContent = \`\${visible} title\${visible === 1 ? '' : 's'}\`
      noResults.style.display = visible === 0 ? 'block' : 'none'
      grid.style.display = visible === 0 ? 'none' : 'grid'
    })
  </script>`
      : ''
  }
</body>
</html>`)
})

// --- Movie player page ---

app.get('/watch/:slug', async (req, res) => {
  const movies = await scanMovies()
  const movie = movies.find((m) => m.slug === req.params.slug)

  if (!movie) {
    return res.status(404).send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Not found</title>
  <style>${SHARED_STYLES}
    body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}
    h1{font-size:1.4rem;color:var(--text-dim)}
    a{color:var(--accent);text-decoration:none;font-weight:600}
  </style>
</head>
<body>
  <h1>Movie not found</h1>
  <a href="/">&larr; Back to all movies</a>
</body>
</html>`)
  }

  const { title, description, thumb, pageUrl, year } = movie

  // Check whether this file is already web-safe (H.264 + AAC) or has a
  // cached transcoded copy ready. If a transcode is needed and hasn't been
  // started yet, kick it off in the background and show a short "preparing
  // video" page that auto-refreshes, rather than holding the HTTP response
  // open for what could be a slow re-encode.
  const status = await checkVideoStatus(movie.file)

  if (!status.ready) {
    if (status.needsStart) {
      startTranscode(status.videoPath, status.cachedPath, status.codecs)
    }
    return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Preparing ${title}…</title>
  <meta http-equiv="refresh" content="4">
  <style>${SHARED_STYLES}
    body{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:18px;text-align:center;padding:24px}
    .spinner{
      width:40px;height:40px;border-radius:50%;
      border:3px solid rgba(255,255,255,.12);
      border-top-color:var(--accent);
      animation:spin 0.9s linear infinite;
    }
    @keyframes spin{to{transform:rotate(360deg)}}
    h1{font-size:1.1rem;font-weight:600}
    p{color:var(--text-dim);font-size:.88rem;max-width:320px}
    a{color:var(--accent);text-decoration:none;font-size:.85rem;font-weight:600;margin-top:8px}
  </style>
</head>
<body>
  <div class="spinner"></div>
  <h1>Preparing ${title} for playback…</h1>
  <p>This file needs a one-time conversion for phone/browser compatibility. This page will refresh automatically.</p>
  <a href="/">&larr; Back to all movies</a>
</body>
</html>`)
  }

  const video = status.url

  res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${title}</title>

  <meta property="og:type"        content="video.movie" />
  <meta property="og:title"       content="${title}" />
  <meta property="og:description" content="${description}" />
  <meta property="og:url"         content="${pageUrl}" />
  ${thumb ? `<meta property="og:image" content="${BASE_URL}${thumb}" />` : ''}
  <meta property="og:video"       content="${BASE_URL}${video}" />
  <meta property="og:video:type"  content="video/mp4" />
  <meta property="og:video:secure_url" content="${BASE_URL}${video}" />
  <meta name="author" content="neerajan" />
  <meta property="og:site_name" content="neerajan" />

  <style>
    ${SHARED_STYLES}
    body{
      background:#000;
      display:flex;
      flex-direction:column;
      align-items:center;
      min-height:100vh;
    }
    .player-wrap{
      width:100%;
      max-width:1000px;
      margin-top:env(safe-area-inset-top, 0);
    }
    video{
      width:100%;
      display:block;
      background:#000;
      box-shadow:0 0 60px rgba(0,0,0,.6);
    }
    .info{
      padding:16px 18px 28px;
      width:100%;
      max-width:1000px;
    }
    .info h2{font-size:1.15rem;font-weight:700;margin-bottom:2px}
    .info .year{color:var(--text-dim);font-size:.85rem;margin-bottom:8px}
    .info p{color:var(--text-dim);font-size:.9rem;line-height:1.5;max-width:640px}
    .back{
      position:fixed;
      top:16px;
      left:16px;
      background:rgba(20,20,26,.75);
      backdrop-filter:blur(6px);
      color:#ddd;
      padding:7px 16px;
      border-radius:999px;
      text-decoration:none;
      font-size:.85rem;
      font-weight:600;
      z-index:10;
      border:1px solid rgba(255,255,255,.08);
      transition:background .2s ease, color .2s ease;
    }
    .back:hover{background:var(--accent);color:#fff}

    @media (max-width:640px){
      .back{top:10px;left:10px;padding:6px 13px;font-size:.8rem}
      .info{padding:14px 16px 24px}
      .info h2{font-size:1.02rem}
      .info p{font-size:.85rem}
    }
  </style>
</head>
<body>
  <a class="back" href="/">&larr; All Movies</a>
  <div class="player-wrap">
    <video id="player" controls playsinline webkit-playsinline preload="metadata"
           poster="${thumb || ''}" width="100%" src="${video}">
      <source src="${video}" type="video/mp4" />
    </video>
  </div>
  <div class="info">
    <h2>${title}</h2>
    ${year ? `<div class="year">${year}</div>` : ''}
    <p>${description}</p>
  </div>
  <script>
    const v = document.getElementById('player')
    v.addEventListener('play',    () => console.log('play'))
    v.addEventListener('pause',   () => console.log('pause'))
    v.addEventListener('seeked',  () => console.log('seeked'))
    v.addEventListener('timeupdate', () => console.log('time', v.currentTime))
    v.addEventListener('ended',   () => console.log('ended'))
  </script>
</body>
</html>`)
})

// --- MP4 range-serve fallback (express.static handles it, but just in case) ---

app.listen(PORT, async () => {
  console.log(`Movie server running on ${BASE_URL}`)
  console.log(`Serving from: ${MOVIES_DIR}`)
  const movies = await scanMovies()
  console.log(`${movies.length} movie(s) found`)
})
