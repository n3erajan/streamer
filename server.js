const express = require('express')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const app = express()
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
const PORT = 8080
const BASE_URL = 'https://stream.nirajan-paudel.com.np'
const MOVIES_DIR = path.join(__dirname, 'movies')

// Ensure movies directory exists
if (!fs.existsSync(MOVIES_DIR)) fs.mkdirSync(MOVIES_DIR, { recursive: true })

// --- YouTube helpers ---

const YT_DLP = path.join(__dirname, 'yt-dlp.exe')
// Change this to 'edge', 'firefox', 'brave', or 'opera' if you use a different browser on this machine
const BROWSER_FOR_COOKIES = 'chrome'
const ytInfoCache = new Map()
const ytStreamCache = new Map()
const ytSearchCache = new Map()

function formatDuration(sec) {
  if (!sec || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function ytThumb(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
}

function getCookieArgs() {
  const cookiesFile = path.join(__dirname, 'cookies.txt')
  if (fs.existsSync(cookiesFile)) {
    return ['--cookies', cookiesFile]
  }
  return ['--cookies-from-browser', BROWSER_FOR_COOKIES]
}

// ═══════════════════════════════════════════════════════════════
//  InnerTube API — Direct HTTP calls to YouTube's internal API
//  Replaces yt-dlp subprocess spawning for search, info, streams
// ═══════════════════════════════════════════════════════════════

const INNERTUBE_BASE = 'https://www.youtube.com/youtubei/v1'
const INNERTUBE_WEB_CONTEXT = {
  client: {
    clientName: 'WEB',
    clientVersion: '2.20241120.01.00',
    hl: 'en',
    gl: 'US',
  },
}
const INNERTUBE_ANDROID_CONTEXT = {
  client: {
    clientName: 'ANDROID',
    clientVersion: '19.09.37',
    androidSdkVersion: 30,
    hl: 'en',
    gl: 'US',
  },
}

async function innertubeFetch(endpoint, body) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${INNERTUBE_BASE}/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timeout)
  }
}

function parseDurationText(text) {
  if (!text) return 0
  const parts = text.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] || 0
}


// Search via InnerTube — returns { results, continuationToken }
async function innertubeSearch(query, continuationToken = null) {
  const body = { context: INNERTUBE_WEB_CONTEXT }
  if (continuationToken) {
    body.continuation = continuationToken
  } else {
    body.query = query
  }

  const data = await innertubeFetch('search', body)

  let sections = []
  if (continuationToken) {
    sections = data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || []
  } else {
    sections = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || []
  }

  const results = []
  let nextToken = null

  for (const section of sections) {
    if (section.continuationItemRenderer) {
      nextToken = section.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      continue
    }
    const items = section?.itemSectionRenderer?.contents || []
    for (const item of items) {
      if (item.continuationItemRenderer) {
        nextToken = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
        continue
      }
      const vr = item?.videoRenderer
      if (!vr?.videoId) continue
      results.push({
        id: vr.videoId,
        title: vr.title?.runs?.[0]?.text || 'Untitled',
        channel: vr.ownerText?.runs?.[0]?.text || '',
        duration: parseDurationText(vr.lengthText?.simpleText),
        thumbnail: ytThumb(vr.videoId),
      })
    }
  }
  return { results, continuationToken: nextToken }
}

// Browse via InnerTube (Home Feed)
async function innertubeBrowse(continuationToken = null) {
  const body = { context: INNERTUBE_WEB_CONTEXT }
  if (continuationToken) {
    body.continuation = continuationToken
  } else {
    body.browseId = 'FEwhat_to_watch'
  }

  const data = await innertubeFetch('browse', body)

  let sections = []
  if (continuationToken) {
    sections = data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction?.continuationItems || 
               data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || []
  } else {
    sections = data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.richGridRenderer?.contents || []
  }

  const results = []
  let nextToken = null

  for (const section of sections) {
    if (section.continuationItemRenderer) {
      nextToken = section.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      continue
    }
    const item = section.richItemRenderer?.content?.videoRenderer
    if (item && item.videoId) {
      results.push({
        id: item.videoId,
        title: item.title?.runs?.[0]?.text || 'Untitled',
        channel: item.ownerText?.runs?.[0]?.text || '',
        duration: parseDurationText(item.lengthText?.simpleText),
        thumbnail: ytThumb(item.videoId),
      })
    }
  }

  // Fallback to Trending search if YouTube blocks the logged-out home feed
  if (results.length === 0 && !continuationToken) {
    return innertubeSearch('Trending')
  }

  return { results, continuationToken: nextToken }
}

// Next via InnerTube (Related Videos)
async function innertubeNext(videoId, continuationToken = null) {
  const body = { context: INNERTUBE_WEB_CONTEXT }
  if (continuationToken) {
    body.continuation = continuationToken
  } else {
    body.videoId = videoId
  }

  const data = await innertubeFetch('next', body)

  let items = []
  if (continuationToken) {
    items = data?.onResponseReceivedEndpoints?.[0]?.appendContinuationItemsAction?.continuationItems || 
            data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction?.continuationItems || []
  } else {
    items = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || []
  }

  const results = []
  let nextToken = null

  for (const item of items) {
    if (item.continuationItemRenderer) {
      nextToken = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      continue
    }
    const compactVideo = item.compactVideoRenderer
    if (compactVideo && compactVideo.videoId) {
      results.push({
        id: compactVideo.videoId,
        title: compactVideo.title?.runs?.[0]?.text || 'Untitled',
        channel: compactVideo.longBylineText?.runs?.[0]?.text || compactVideo.shortBylineText?.runs?.[0]?.text || '',
        duration: parseDurationText(compactVideo.lengthText?.simpleText),
        thumbnail: ytThumb(compactVideo.videoId),
      })
    }
    const lockup = item.lockupViewModel
    if (lockup && lockup.contentId) {
      let durationStr = ''
      try {
        const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || []
        for (const o of overlays) {
          if (o.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text) {
            durationStr = o.thumbnailBottomOverlayViewModel.badges[0].thumbnailBadgeViewModel.text
            break
          }
        }
      } catch (e) {}

      results.push({
        id: lockup.contentId,
        title: lockup.metadata?.lockupMetadataViewModel?.title?.content || 'Untitled',
        channel: lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '',
        duration: parseDurationText(durationStr),
        thumbnail: ytThumb(lockup.contentId),
      })
    }
  }
  return { results, continuationToken: nextToken }
}

// Player via InnerTube — returns { info, streamUrl } or throws
// Strategy: WEB client for info (most reliable), extract stream URLs from response
async function innertubePlayer(videoId) {
  // Try multiple client types for best results
  const clients = [
    { name: 'WEB', context: INNERTUBE_WEB_CONTEXT },
    {
      name: 'IOS',
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '19.45.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          osName: 'iOS',
          osVersion: '17.6.1',
          hl: 'en',
          gl: 'US',
        },
      },
    },
  ]

  let lastError = null
  for (const { name, context, extra } of clients) {
    try {
      const data = await innertubeFetch('player', {
        context,
        videoId,
        contentCheckOk: true,
        racyCheckOk: true,
        ...(extra || {}),
      })

      const status = data?.playabilityStatus?.status
      if (status && status !== 'OK') {
        lastError = new Error(`${name}: ${status} — ${data?.playabilityStatus?.reason || 'blocked'}`)
        continue
      }

      const details = data?.videoDetails
      if (!details) {
        lastError = new Error(`${name}: no videoDetails`)
        continue
      }

      const info = {
        title: details.title || 'YouTube Video',
        thumbnail: details.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || ytThumb(videoId),
        duration: parseInt(details.lengthSeconds) || 0,
        channel: details.author || '',
        description: (details.shortDescription || '').substring(0, 300),
      }

      // Extract best combined (audio+video) MP4 stream URL
      let streamUrl = null
      const combined = (data?.streamingData?.formats || [])
        .filter(f => f.url && f.mimeType?.startsWith('video/mp4'))
        .sort((a, b) => (b.width || 0) - (a.width || 0))

      if (combined.length > 0) {
        streamUrl = combined[0].url
      }

      return { info, streamUrl }
    } catch (e) {
      lastError = e
    }
  }

  throw lastError || new Error('All InnerTube player clients failed')
}

// ═══════════════════════════════════════════════════════════════
//  Public API functions — InnerTube /next for info, yt-dlp for streams
// ═══════════════════════════════════════════════════════════════

// Single /next call that returns BOTH video info AND related videos.
// This replaces the old getYouTubeInfo + innertubeNext sequential pair.
async function getVideoPageData(videoId) {
  const data = await innertubeFetch('next', {
    context: INNERTUBE_WEB_CONTEXT,
    videoId,
  })

  // --- Extract video info from primary results ---
  const primaryContents = data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || []
  const pri = primaryContents.find(c => c.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer
  const sec = primaryContents.find(c => c.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer

  const info = {
    title: pri?.title?.runs?.[0]?.text || 'YouTube Video',
    thumbnail: ytThumb(videoId),
    duration: 0,
    channel: sec?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || '',
    description: (sec?.attributedDescription?.content || '').substring(0, 300),
  }

  // Cache the info so subsequent requests (e.g. replays) are instant
  ytInfoCache.set(videoId, info)
  setTimeout(() => ytInfoCache.delete(videoId), 60 * 60 * 1000)

  // --- Extract related videos from secondary results ---
  const items = data?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || []
  const relatedVideos = []
  let relatedContinuation = null

  for (const item of items) {
    if (item.continuationItemRenderer) {
      relatedContinuation = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token
      continue
    }
    const compactVideo = item.compactVideoRenderer
    if (compactVideo && compactVideo.videoId) {
      relatedVideos.push({
        id: compactVideo.videoId,
        title: compactVideo.title?.runs?.[0]?.text || 'Untitled',
        channel: compactVideo.longBylineText?.runs?.[0]?.text || compactVideo.shortBylineText?.runs?.[0]?.text || '',
        duration: parseDurationText(compactVideo.lengthText?.simpleText),
        thumbnail: ytThumb(compactVideo.videoId),
      })
    }
    const lockup = item.lockupViewModel
    if (lockup && lockup.contentId) {
      let durationStr = ''
      try {
        const overlays = lockup.contentImage?.thumbnailViewModel?.overlays || []
        for (const o of overlays) {
          if (o.thumbnailBottomOverlayViewModel?.badges?.[0]?.thumbnailBadgeViewModel?.text) {
            durationStr = o.thumbnailBottomOverlayViewModel.badges[0].thumbnailBadgeViewModel.text
            break
          }
        }
      } catch (e) {}
      relatedVideos.push({
        id: lockup.contentId,
        title: lockup.metadata?.lockupMetadataViewModel?.title?.content || 'Untitled',
        channel: lockup.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]?.text?.content || '',
        duration: parseDurationText(durationStr),
        thumbnail: ytThumb(lockup.contentId),
      })
    }
  }

  return { info, relatedVideos, relatedContinuation }
}

// Lightweight info getter — uses cache first, then /next
function getYouTubeInfo(videoId) {
  if (ytInfoCache.has(videoId)) return Promise.resolve(ytInfoCache.get(videoId))
  return getVideoPageData(videoId).then(d => d.info)
}

function getYouTubeStreamUrl(videoId) {
  const cached = ytStreamCache.get(videoId)
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.url)

  // Go straight to yt-dlp — InnerTube /player is blocked for unauthenticated requests
  const cookiesFile = path.join(__dirname, 'cookies.txt')
  const cookieArgs = fs.existsSync(cookiesFile)
    ? ['--cookies', cookiesFile]
    : []

  return new Promise((resolve, reject) => {
    execFile(
      YT_DLP,
      [
        '-f', 'b[ext=mp4]/b/best',
        '-g',
        '--no-warnings',
        '--no-playlist',
        ...cookieArgs,
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      { maxBuffer: 10 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(new Error(`yt-dlp stream failed: ${err.message}`))
        const urls = stdout
          .trim()
          .split('\n')
          .filter((l) => l.startsWith('http'))
        if (urls.length > 0) {
          const result = {
            video: urls[0],
            audio: urls.length > 1 ? urls[1] : null,
          }
          ytStreamCache.set(videoId, {
            url: result,
            expires: Date.now() + 15 * 60 * 1000,
          })
          resolve(result)
        } else {
          reject(new Error('No stream URL found'))
        }
      },
    )
  })
}



// Shared helper: cross-populate info cache from search results
function populateInfoCache(results) {
  results.forEach(r => {
    if (r.id && !ytInfoCache.has(r.id)) {
      ytInfoCache.set(r.id, {
        title: r.title,
        thumbnail: r.thumbnail,
        duration: r.duration,
        channel: r.channel,
        description: '',
      })
      setTimeout(() => ytInfoCache.delete(r.id), 60 * 60 * 1000)
    }
  })
}

// ═══════════════════════════════════════════════════════════════
//  Public API functions — InnerTube first, yt-dlp fallback
// ═══════════════════════════════════════════════════════════════
async function searchYouTube(query, continuationToken = null) {
  const cacheKey = `${query}:${continuationToken || 'first'}`
  // Only cache if we don't have a continuation token to ensure smooth pagination caching if needed, 
  // but for fresh feeds we don't cache pagination. Let's just bypass cache for search to be fresh too,
  // or keep a very short cache.
  const cached = ytSearchCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.data

  // Try InnerTube search first (~0.3-0.5s)
  try {
    const data = await innertubeSearch(query, continuationToken)
    if (data.results.length > 0) {
      populateInfoCache(data.results)
      ytSearchCache.set(cacheKey, { data, expires: Date.now() + 5 * 60 * 1000 })
      return data
    }
  } catch (e) {
    console.log(`InnerTube search failed: ${e.message}, falling back to yt-dlp`)
  }

  if (continuationToken) {
     return { results: [], continuationToken: null } // yt-dlp doesn't support our tokens
  }

  // Fallback to yt-dlp (~10-15s)
  return new Promise((resolve, reject) => {
    execFile(YT_DLP, [
      '--dump-json', '--no-warnings', '--flat-playlist', '--no-check-formats',
      `ytsearch30:${query}`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 20000 }, (err, stdout) => {
      if (err) return reject(new Error(`Search failed: ${err.message}`))
      const results = stdout.trim().split('\n').filter(Boolean).map(line => {
        try {
          const d = JSON.parse(line)
          return {
            id: d.id,
            title: d.title || 'Untitled',
            channel: d.channel || d.uploader || '',
            duration: d.duration || 0,
            thumbnail: ytThumb(d.id),
          }
        } catch { return null }
      }).filter(Boolean)

      populateInfoCache(results)
      const data = { results, continuationToken: null }
      ytSearchCache.set(cacheKey, { data, expires: Date.now() + 15 * 60 * 1000 })
      resolve(data)
    })
  })
}

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
          const isFragmented =
            compatibleBrands.includes('iso5') ||
            compatibleBrands.includes('iso6') ||
            compatibleBrands.includes('dash')
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
  const audioOk =
    !codecs.audioCodec || ['aac', 'mp3'].includes(codecs.audioCodec)
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

async function transcodeForWeb(videoPath, outPath, codecs) {
  const cleanup = () => {
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
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
        fs.renameSync(outPath, videoPath)
      } catch (e) {
        console.error(`Failed to replace original file:`, e)
        return false
      }
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

    const audioIsSafe =
      codecs.audioCodec && ['aac', 'mp3'].includes(codecs.audioCodec)
    const audioArgs = audioIsSafe
      ? ['-c:a', 'copy']
      : ['-c:a', 'aac', '-b:a', '160k']

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

// Quick check: does this file need transcoding, and is a cached copy ready?
// Does not start a transcode — just reports status so the caller can decide
// whether to show a "preparing video" interstitial or play immediately.
async function checkVideoStatus(file) {
  const videoPath = path.join(MOVIES_DIR, file)
  const tempName = path.basename(file, '.mp4') + '.tmp.mp4'
  const tempPath = path.join(TRANSCODE_DIR, tempName)
  const originalUrl = `/movies/${encodeURIComponent(file)}`

  if (pendingTranscodes.has(tempPath)) return { ready: false }

  const codecs = await probeCodecs(videoPath)
  if (isWebSafe(codecs)) return { ready: true, url: originalUrl }

  return {
    ready: false,
    needsStart: true,
    videoPath,
    cachedPath: tempPath,
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
    const description = meta.description || ''
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
  res.header(
    'Access-Control-Expose-Headers',
    'Accept-Ranges, Content-Encoding, Content-Length, Content-Range',
  )
  next()
})

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
  next()
})

// --- Static files from movies/ ---

app.use('/movies', express.static(MOVIES_DIR, { dotfiles: 'allow' }))

// --- Shared styles moved to views/partials/styles.ejs ---

// --- Homepage ---

app.get('/', async (req, res) => {
  const movies = await scanMovies()

  res.render('index', { movies })
})

// --- Movie player page ---

app.get('/watch/:slug', async (req, res) => {
  const movies = await scanMovies()
  const movie = movies.find((m) => m.slug === req.params.slug)

  if (!movie) {
    return res.status(404).render('404')
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
    return res.render('preparing', { title })
  }

  const video = status.url

  res.render('player', {
    title,
    description,
    thumb,
    pageUrl,
    year,
    video,
    BASE_URL,
  })
})

// --- YouTube routes ---

app.get('/youtube', async (req, res) => {
  const query = req.query.q || ''

  // If the input is a YouTube URL or an exact 11-character video ID, redirect to the player
  if (query) {
    const match = query.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/)
    if (match) {
      return res.redirect(`/youtube/watch/${match[1]}`)
    }
    if (/^[a-zA-Z0-9_-]{11}$/.test(query)) {
      return res.redirect(`/youtube/watch/${query}`)
    }
  }

  let results = []
  let continuationToken = null
  let error = null
  let isSearch = false

  try {
    if (query) {
      isSearch = true
      const data = await searchYouTube(query)
      results = data.results
      continuationToken = data.continuationToken
    } else {
      const data = await innertubeBrowse()
      results = data.results
      continuationToken = data.continuationToken
    }
  } catch (e) {
    error = e.message
  }

  res.render('youtube-browser', {
    query,
    results,
    continuationToken,
    error,
    isSearch,
  })
})

app.get('/youtube/watch/:id', async (req, res) => {
  const videoId = req.params.id
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID')
  }

  // Pre-warm the stream cache in the background — don't await it.
  // By the time the browser parses the HTML and requests the stream URL,
  // yt-dlp will likely have already finished.
  getYouTubeStreamUrl(videoId).catch(() => {})

  // Single /next call gets BOTH video info AND related videos (~0.5s)
  let info = { title: 'YouTube Video', channel: '', description: '', thumbnail: ytThumb(videoId) }
  let relatedVideos = []
  let relatedContinuation = null

  // Check cache first (populated by search/browse results)
  if (ytInfoCache.has(videoId)) {
    info = ytInfoCache.get(videoId)
    // Still fetch related videos (fast, ~0.5s)
    try {
      const nextData = await innertubeNext(videoId)
      relatedVideos = nextData.results
      relatedContinuation = nextData.continuationToken
    } catch (e) {
      console.log(`Failed to fetch related videos: ${e.message}`)
    }
  } else {
    // No cache — get everything from one /next call
    try {
      const pageData = await getVideoPageData(videoId)
      info = pageData.info
      relatedVideos = pageData.relatedVideos
      relatedContinuation = pageData.relatedContinuation
    } catch (err) {
      console.log(`getVideoPageData failed: ${err.message}`)
    }
  }

  const title = info.title || 'YouTube Video'
  const thumb = info.thumbnail || ytThumb(videoId)
  const description = info.description || ''
  const channel = info.channel || ''

  res.render('youtube-player', {
    videoId,
    title,
    thumb,
    pageUrl: `${BASE_URL}/youtube/watch/${videoId}`,
    videoUrl: `${BASE_URL}/youtube-stream/${videoId}.mp4`,
    description,
    channel,
    info,
    relatedVideos,
    relatedContinuation,
    formatDuration,
    BASE_URL
  })
})

// --- Async API Endpoints for Infinite Scroll ---

app.get('/api/youtube/home', async (req, res) => {
  try {
    const continuation = req.query.continuation
    const data = await innertubeBrowse(continuation)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/youtube/search', async (req, res) => {
  try {
    const query = req.query.q || ''
    const continuation = req.query.continuation
    const data = await searchYouTube(query, continuation)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/youtube/related', async (req, res) => {
  try {
    const videoId = req.query.videoId || ''
    const continuation = req.query.continuation
    if (!videoId && !continuation) return res.json({ results: [] })
    
    const data = await innertubeNext(videoId, continuation)
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// --- YouTube stream redirect ---

app.get('/youtube-stream/:id.mp4', async (req, res) => {
  const videoId = req.params.id
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID')
  }

  try {
    const streamUrls = await getYouTubeStreamUrl(videoId)
    res.redirect(302, streamUrls.video)
  } catch (e) {
    res.status(500).send(`Failed to fetch YouTube stream: ${e.message}`)
  }
})

// --- MP4 range-serve fallback (express.static handles it, but just in case) ---

app.use((err, req, res, next) => {
  console.error('Express error:', err)
  res.status(500).send('Internal Server Error')
})

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason)
})

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})

app.listen(PORT, async () => {
  console.log(`Stream Server running on ${BASE_URL}`)
  console.log(`Serving from: ${MOVIES_DIR}`)
  const movies = await scanMovies()
  console.log(`${movies.length} movie(s) found`)
})
