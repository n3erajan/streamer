require('dotenv').config()
const express = require('express')
const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const app = express()
app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.enable('trust proxy')
const PORT = 8080

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol
  const host = req.headers['x-forwarded-host'] || req.headers.host
  return `${proto}://${host}`
}
const MOVIES_DIR = path.join(__dirname, 'movies')

// Ensure movies directory exists
if (!fs.existsSync(MOVIES_DIR)) fs.mkdirSync(MOVIES_DIR, { recursive: true })

// --- YouTube helpers ---

// Find yt-dlp: venv & PATH only (pip installed Python package)
const YT_DLP = (() => {
  const { execSync } = require('child_process')
  const venvPaths = [
    path.join(__dirname, '.venv', 'bin', 'yt-dlp'),
    path.join(__dirname, 'venv', 'bin', 'yt-dlp'),
  ]
  for (const p of venvPaths) {
    if (fs.existsSync(p)) return p
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const found = execSync(`${which} yt-dlp`, {
      encoding: 'utf8',
      stdio: 'pipe',
    })
      .trim()
      .split('\n')[0]
    if (found) return found
  } catch {}
  return 'yt-dlp'
})()

// JS runtime for yt-dlp's n-signature / EJS challenge solver. yt-dlp 2026.x
// only enables `deno` by default; node must be opted in with --js-runtimes.
// Without a working runtime, YouTube returns only storyboard formats and every
// video fails with "Requested format is not available". Node is present on both
// dev and Render. Allow override via YT_JS_RUNTIME (e.g. "deno:/path/to/deno").
// Validated at startup so a missing runtime fails fast instead of silently.
const YT_JS_RUNTIME = (() => {
  const configured = process.env.YT_JS_RUNTIME
  if (configured) return configured
  const { execSync } = require('child_process')
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    execSync(`${which} node`, { encoding: 'utf8', stdio: 'pipe' })
    return 'node'
  } catch {
    console.warn(
      '[yt-dlp] No JS runtime found (node not on PATH). YouTube streams will ' +
        'likely fail with "Requested format is not available". Install Node or ' +
        'set YT_JS_RUNTIME.',
    )
    return 'node'
  }
})()

const ytInfoCache = new Map()
const ytStreamCache = new Map()
const ytSearchCache = new Map()
const ytHomeCache = new Map()

// In-flight stream fetches: maps videoId -> Promise. When a fetch for a video
// is already running, concurrent callers await the SAME promise instead of
// spawning another yt-dlp process. Each yt-dlp invocation (with the EJS plugin
// + Node child processes for the n-challenge/PO-token) uses ~100-150MB and can
// run for up to 60s, so duplicate spawns on a single video click (pre-warm +
// foreground request + browser retries) would instantly OOM a 512MB instance.
const ytStreamInflight = new Map()

// Global cap on concurrent yt-dlp processes (across ALL videos). Each process
// holds ~100-150MB for up to 60s; 2 is the safe ceiling on a 512MB instance
// alongside the Node server itself. Extra callers queue instead of spawning.
// Override with YT_DLP_MAX_CONCURRENCY env var.
const YT_DLP_MAX_CONCURRENCY = Number(process.env.YT_DLP_MAX_CONCURRENCY) || 2
const ytDlpActive = { count: 0, queue: [] }
function acquireYtDlpSlot() {
  return new Promise((resolve) => {
    if (ytDlpActive.count < YT_DLP_MAX_CONCURRENCY) {
      ytDlpActive.count++
      resolve()
    } else {
      ytDlpActive.queue.push(resolve)
    }
  })
}
function releaseYtDlpSlot() {
  const next = ytDlpActive.queue.shift()
  if (next) {
    next() // hands the slot directly to the next waiter (count stays the same)
  } else {
    ytDlpActive.count--
  }
}

function formatDuration(sec) {
  if (!sec || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function ytThumb(id) {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`
}

// Cookie names that indicate a logged-in Google/YouTube session.
// These must be stripped: with login cookies present, yt-dlp switches
// from the android_vr player client to web_safari/tv-downloaded, which
// YouTube restricts to storyboard-only responses (no video/audio formats).
// The visitor/consent cookies (VISITOR_INFO1_LIVE, YSC, etc.) are enough
// to pass bot detection on datacenter IPs without triggering the login
// player path.
const LOGIN_COOKIE_NAMES = new Set([
  'LOGIN_INFO', 'SID', 'HSID', 'SSID', 'APISID', 'SAPISID',
  '__Secure-1PSID', '__Secure-3PSID',
  '__Secure-1PAPISID', '__Secure-3PAPISID',
  '__Secure-1PSIDTS', '__Secure-3PSIDTS',
  '__Secure-1PSIDCC', '__Secure-3PSIDCC', 'SIDCC',
])

function stripLoginCookies(rawCookies) {
  return rawCookies
    .split('\n')
    .filter((line) => {
      if (line.startsWith('#') || line.trim() === '') return true
      // Extract cookie name: second whitespace-delimited token
      const parts = line.split(/\s+/)
      const cookieName = parts[5]
      return cookieName && !LOGIN_COOKIE_NAMES.has(cookieName)
    })
    .join('\n')
}

// Resolve cookie source: env var > local cookies.txt > browser
const COOKIES_PATH = (() => {
  if (process.env.YT_COOKIES) {
    const tmp = path.join(__dirname, '.yt-cookies-tmp.txt')
    let cookies = process.env.YT_COOKIES
    if (
      (cookies.startsWith('"') && cookies.endsWith('"')) ||
      (cookies.startsWith("'") && cookies.endsWith("'"))
    )
      cookies = cookies.slice(1, -1)
    cookies = cookies.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (!cookies.endsWith('\n')) cookies += '\n'

    // Use the full cookies (including login cookies) by default.
    // The login cookies (SID, SAPISID, __Secure-1PSID, etc.) are REQUIRED to
    // pass YouTube's "Sign in to confirm you're not a bot" check on datacenter
    // IPs (production servers like Render). Stripping them leaves only anonymous
    // visitor cookies, which YouTube rejects on datacenter IPs. Set
    // YT_STRIP_LOGIN_COOKIES=1 to re-enable the old stripping behavior.
    const strip = process.env.YT_STRIP_LOGIN_COOKIES === '1'
    const final = strip ? stripLoginCookies(cookies) : cookies
    const originalLines = cookies.split('\n').filter((l) => l.trim()).length
    const finalLines = final.split('\n').filter((l) => l.trim()).length

    try {
      fs.writeFileSync(tmp, final, 'utf8')
      const first = final.split('\n')[0]
      console.log(
        `[cookies] Wrote ${final.length} chars to ${tmp} ` +
          `(${originalLines - finalLines} login cookies stripped` +
          (strip ? '' : ', stripping disabled') +
          '). First line: ' +
          first.slice(0, 80),
      )
    } catch (e) {
      console.error(`[cookies] Failed to write temp cookie file: ${e.message}`)
    }
    return tmp
  }
  const local = path.join(__dirname, 'cookies.txt')
  if (fs.existsSync(local)) {
    console.log(`[cookies] Using local ${local}`)
    return local
  }
  console.log(
    '[cookies] No cookie source found — yt-dlp will fall back to --cookies-from-browser',
  )
  return null
})()

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
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8'

async function innertubeFetch(endpoint, body, opts = {}) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeout || 15000)
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent':
      opts.userAgent ||
      'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
  }
  if (opts.cookieHeader) headers['Cookie'] = opts.cookieHeader
  try {
    const res = await fetch(
      `${INNERTUBE_BASE}/${endpoint}?key=${INNERTUBE_API_KEY}&prettyPrint=false`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
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
    sections =
      data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction
        ?.continuationItems || []
  } else {
    sections =
      data?.contents?.twoColumnSearchResultsRenderer?.primaryContents
        ?.sectionListRenderer?.contents || []
  }

  const results = []
  let nextToken = null

  for (const section of sections) {
    if (section.continuationItemRenderer) {
      nextToken =
        section.continuationItemRenderer?.continuationEndpoint
          ?.continuationCommand?.token
      continue
    }
    const items = section?.itemSectionRenderer?.contents || []
    for (const item of items) {
      if (item.continuationItemRenderer) {
        nextToken =
          item.continuationItemRenderer?.continuationEndpoint
            ?.continuationCommand?.token
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

// Browse via InnerTube (Home Feed) — cached 30 min
async function innertubeBrowse(continuationToken = null) {
  const cacheKey = continuationToken || 'initial'
  const cached = ytHomeCache.get(cacheKey)
  if (cached && cached.expires > Date.now()) return cached.data

  const body = { context: INNERTUBE_WEB_CONTEXT }
  if (continuationToken) {
    body.continuation = continuationToken
  } else {
    body.browseId = 'FEwhat_to_watch'
  }

  const data = await innertubeFetch('browse', body)

  let sections = []
  if (continuationToken) {
    sections =
      data?.onResponseReceivedActions?.[0]?.appendContinuationItemsAction
        ?.continuationItems ||
      data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction
        ?.continuationItems ||
      []
  } else {
    sections =
      data?.contents?.twoColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer
        ?.content?.richGridRenderer?.contents || []
  }

  const results = []
  let nextToken = null

  for (const section of sections) {
    if (section.continuationItemRenderer) {
      nextToken =
        section.continuationItemRenderer?.continuationEndpoint
          ?.continuationCommand?.token
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

  const resultData = { results, continuationToken: nextToken }
  ytHomeCache.set(cacheKey, {
    data: resultData,
    expires: Date.now() + 30 * 60 * 1000,
  })
  return resultData
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
    items =
      data?.onResponseReceivedEndpoints?.[0]?.appendContinuationItemsAction
        ?.continuationItems ||
      data?.onResponseReceivedCommands?.[0]?.appendContinuationItemsAction
        ?.continuationItems ||
      []
  } else {
    items =
      data?.contents?.twoColumnWatchNextResults?.secondaryResults
        ?.secondaryResults?.results || []
  }

  const results = []
  let nextToken = null

  for (const item of items) {
    if (item.continuationItemRenderer) {
      nextToken =
        item.continuationItemRenderer?.continuationEndpoint?.continuationCommand
          ?.token
      continue
    }
    const compactVideo = item.compactVideoRenderer
    if (compactVideo && compactVideo.videoId) {
      results.push({
        id: compactVideo.videoId,
        title: compactVideo.title?.runs?.[0]?.text || 'Untitled',
        channel:
          compactVideo.longBylineText?.runs?.[0]?.text ||
          compactVideo.shortBylineText?.runs?.[0]?.text ||
          '',
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
          if (
            o.thumbnailBottomOverlayViewModel?.badges?.[0]
              ?.thumbnailBadgeViewModel?.text
          ) {
            durationStr =
              o.thumbnailBottomOverlayViewModel.badges[0]
                .thumbnailBadgeViewModel.text
            break
          }
        }
      } catch (e) {}

      results.push({
        id: lockup.contentId,
        title:
          lockup.metadata?.lockupMetadataViewModel?.title?.content ||
          'Untitled',
        channel:
          lockup.metadata?.lockupMetadataViewModel?.metadata
            ?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]
            ?.text?.content || '',
        duration: parseDurationText(durationStr),
        thumbnail: ytThumb(lockup.contentId),
      })
    }
  }
  return { results, continuationToken: nextToken }
}

// ═══════════════════════════════════════════════════════════════
//  Fast stream resolver — direct android_vr InnerTube /player call
//
//  Replicates exactly what yt-dlp does with its android_vr client
//  (its default primary client). android_vr (Oculus Quest) is special:
//    - REQUIRE_JS_PLAYER: false  → no n-signature transform needed
//    - No PO token policy        → no pot= required, URLs work directly
//  One POST to /player, ~200-500ms, no Python, no subprocess, no youtubei.js.
//  Falls back to yt-dlp for anything this doesn't handle.
// ═══════════════════════════════════════════════════════════════

function readCookieHeader() {
  if (!COOKIES_PATH) return undefined
  try {
    const content = fs.readFileSync(COOKIES_PATH, 'utf8')
    const lines = content.split('\n')
    const cookieParts = []
    for (const line of lines) {
      if (!line || line.startsWith('#')) continue
      const parts = line.split('\t')
      if (parts.length >= 7) {
        // yt-dlp can update the file with \r\n line endings. We MUST strip \r
        // otherwise Node's fetch will throw 'Invalid character in header content'.
        const name = parts[5].trim()
        const value = parts[6].replace(/\r$/, '')
        cookieParts.push(`${name}=${value}`)
      }
    }
    return cookieParts.join('; ') || undefined
  } catch {
    return undefined
  }
}

// Cache the visitor ID so we only fetch the watch page once per process
let cachedVisitorData = null
let cachedSts = null
let visitorPromise = null

async function getVisitorDataAndSts(videoId) {
  if (cachedVisitorData && cachedSts) return { visitorData: cachedVisitorData, sts: cachedSts }
  if (visitorPromise) return visitorPromise

  visitorPromise = (async () => {
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
        signal: AbortSignal.timeout(8000),
      })
      const html = await res.text()
      // Extract ytcfg from the page
      const ytcfgMatch = html.match(/ytcfg\.set\s*\(\s*({.+?})\s*\)\s*;/)
      if (ytcfgMatch) {
        const ytcfg = JSON.parse(ytcfgMatch[1])
        cachedVisitorData = ytcfg.VISITOR_DATA || null
      }
      // Extract signature timestamp from player URL
      const stsMatch = html.match(/"signatureTimestamp"\s*:\s*(\d+)/)
      if (stsMatch) cachedSts = parseInt(stsMatch[1], 10)
      // Fallback: extract from ytInitialPlayerResponse
      if (!cachedSts) {
        const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*({.+?});\s*\n/)
        if (prMatch) {
          const pr = JSON.parse(prMatch[1])
          cachedSts = pr?.playbackContext?.contentPlaybackContext?.signatureTimestamp || null
        }
      }
    } catch {
      // Non-fatal — proceed without visitor data
    }
    return { visitorData: cachedVisitorData, sts: cachedSts }
  })()

  return visitorPromise
}

async function runAndroidVrForStreamUrl(videoId) {
  const { visitorData, sts } = await getVisitorDataAndSts(videoId)
  const cookie = readCookieHeader()
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
    'X-Youtube-Client-Name': '28',
    'X-Youtube-Client-Version': '1.65.10',
    'Origin': 'https://www.youtube.com',
  }
  if (cookie) headers['Cookie'] = cookie
  if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData

  const body = {
    context: {
      client: {
        clientName: 'ANDROID_VR',
        clientVersion: '1.65.10',
        deviceMake: 'Oculus',
        deviceModel: 'Quest 3',
        androidSdkVersion: 32,
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        osName: 'Android',
        osVersion: '12L',
        hl: 'en',
        timeZone: 'UTC',
        utcOffsetMinutes: 0,
      },
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        ...(sts ? { signatureTimestamp: sts } : {}),
      },
    },
  }

  const res = await fetch(
    'https://www.youtube.com/youtubei/v1/player',
    {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    },
  )

  if (!res.ok) throw new Error(`android_vr /player returned HTTP ${res.status}`)
  const data = await res.json()

  console.log(`[android-vr] YouTube response for ${videoId}: playabilityStatus =`, JSON.stringify(data?.playabilityStatus))

  const status = data?.playabilityStatus?.status
  if (status !== 'OK') {
    const reason = data?.playabilityStatus?.reason || status
    throw new Error(`Video not playable: ${reason}`)
  }

  const sd = data?.streamingData
  if (!sd) throw new Error('No streamingData in player response')

  // ── Priority 1: Progressive mp4 (video+audio in one file) ────────────────
  // Lowest quality = fastest initial load; autoUpgrade handles the rest.
  const progressive = (sd.formats || [])
    .filter((f) => f.url && f.mimeType?.includes('video/mp4'))
    .sort(
      (a, b) =>
        (b.width || 0) - (a.width || 0) ||
        (b.bitrate || 0) - (a.bitrate || 0),
    )

  if (progressive.length > 0) {
    // Pick the LOWEST progressive format for the default stream
    // so the video starts playing as fast as possible.
    const lowest = progressive[progressive.length - 1]
    console.log(
      `[android-vr] Got progressive stream for ${videoId}: ${lowest.qualityLabel}`,
    )
    return { video: lowest.url, audio: null, type: 'progressive' }
  }

  // ── Priority 2: HLS master playlist ─────────────────────────────────────
  // Only used when progressive is unavailable. Needs hls.js or Safari.
  if (sd.hlsManifestUrl) {
    console.log(`[android-vr] Got HLS manifest for ${videoId} (no progressive)`)
    return { video: sd.hlsManifestUrl, audio: null, type: 'hls' }
  }

  throw new Error('No usable stream format found in android_vr response')
}

// ═══════════════════════════════════════════════════════════════
//  Public API functions — InnerTube /next for info, android_vr/yt-dlp for streams
// ═══════════════════════════════════════════════════════════════

// Single /next call that returns BOTH video info AND related videos.
// This replaces the old getYouTubeInfo + innertubeNext sequential pair.
async function getVideoPageData(videoId) {
  const data = await innertubeFetch('next', {
    context: INNERTUBE_WEB_CONTEXT,
    videoId,
  })

  // --- Extract video info from primary results ---
  const primaryContents =
    data?.contents?.twoColumnWatchNextResults?.results?.results?.contents || []
  const pri = primaryContents.find(
    (c) => c.videoPrimaryInfoRenderer,
  )?.videoPrimaryInfoRenderer
  const sec = primaryContents.find(
    (c) => c.videoSecondaryInfoRenderer,
  )?.videoSecondaryInfoRenderer

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
  const items =
    data?.contents?.twoColumnWatchNextResults?.secondaryResults
      ?.secondaryResults?.results || []
  const relatedVideos = []
  let relatedContinuation = null

  for (const item of items) {
    if (item.continuationItemRenderer) {
      relatedContinuation =
        item.continuationItemRenderer?.continuationEndpoint?.continuationCommand
          ?.token
      continue
    }
    const compactVideo = item.compactVideoRenderer
    if (compactVideo && compactVideo.videoId) {
      relatedVideos.push({
        id: compactVideo.videoId,
        title: compactVideo.title?.runs?.[0]?.text || 'Untitled',
        channel:
          compactVideo.longBylineText?.runs?.[0]?.text ||
          compactVideo.shortBylineText?.runs?.[0]?.text ||
          '',
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
          if (
            o.thumbnailBottomOverlayViewModel?.badges?.[0]
              ?.thumbnailBadgeViewModel?.text
          ) {
            durationStr =
              o.thumbnailBottomOverlayViewModel.badges[0]
                .thumbnailBadgeViewModel.text
            break
          }
        }
      } catch (e) {}
      relatedVideos.push({
        id: lockup.contentId,
        title:
          lockup.metadata?.lockupMetadataViewModel?.title?.content ||
          'Untitled',
        channel:
          lockup.metadata?.lockupMetadataViewModel?.metadata
            ?.contentMetadataViewModel?.metadataRows?.[0]?.metadataParts?.[0]
            ?.text?.content || '',
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
  return getVideoPageData(videoId).then((d) => d.info)
}

// Format chain tried by yt-dlp itself, in order, via its built-in '/' fallback syntax:
//   1. b[ext=mp4]                  - progressive mp4 (one file, video+audio) — ideal, simplest to proxy
//   2. b                            - progressive, any container
//   3. bv*[ext=mp4]+ba[ext=m4a]    - separate DASH video+audio (mp4/m4a) — yt-dlp prints TWO urls for this
//   4. best                         - absolute last resort, whatever's available
//
// Why this matters: the old selector was ONLY #1 with no fallback. YouTube
// has been increasingly inconsistent about handing out progressive mp4 for
// a given video/session — when it doesn't, yt-dlp errored out immediately
// ("Requested format is not available") instead of trying anything else.
// That inconsistency, not a code bug, is most of why it "works sometimes."
//
// KNOWN LIMITATION: if it falls through to #3, getYouTubeStreamUrl returns
// both a video and an audio URL, but the /youtube-stream proxy route below
// only forwards `streamUrls.video` — so on that fallback tier you'd get
// picture with no sound. Logged loudly (not silently) when it happens so
// it's visible instead of mysterious. Ask if you want the proxy extended to
// mux the two with ffmpeg on the fly; that's a separate, larger change.
const YT_FORMAT_CHAIN = 'b[height<=360][ext=mp4]/b[ext=mp4]/b/bv*[ext=mp4]+ba[ext=m4a]/best'

// Per-call timeout. With a JS runtime enabled (needed for the n-signature
// challenge), yt-dlp spawns child processes and generates PO tokens — this is
// real work that takes time, especially on a datacenter IP (production) where
// YouTube is slow to respond and the bgutil PO-token HTTP provider isn't
// reachable (no local server at 127.0.0.1:4416), forcing a slower script-based
// fallback. Override with the YT_DLP_TIMEOUT_MS env var.
const YT_DLP_TIMEOUT_MS = Number(process.env.YT_DLP_TIMEOUT_MS) || 60000

async function runYtDlpForStreamUrl(videoId, { timeout = YT_DLP_TIMEOUT_MS } = {}) {
  await acquireYtDlpSlot()
  try {
    return await new Promise((resolve, reject) => {
      const args = ['-f', YT_FORMAT_CHAIN, '-g', '--no-warnings', '--no-playlist']
      // Enable a JS runtime so yt-dlp can solve YouTube's n-signature challenge.
      // Without this, yt-dlp 2026.x returns only storyboard formats ("Requested
      // format is not available"). Only `deno` is enabled by default; node is
      // present on both dev (Node) and Render (Node) but must be opted in.
      args.push('--js-runtimes', YT_JS_RUNTIME)
      if (COOKIES_PATH) args.push('--cookies', COOKIES_PATH)
      args.push(`https://www.youtube.com/watch?v=${videoId}`)

      execFile(
        YT_DLP,
        args,
        { maxBuffer: 10 * 1024 * 1024, timeout },
        (err, stdout, stderr) => {
          if (err) {
            const stderrMsg = (stderr || '').slice(0, 500)
            // Detect timeout vs real error. When the timeout fires, Node sends
            // SIGTERM and yt-dlp produces NO stderr — without this check the
            // logged message is the useless generic "Command failed: ..." wrapper.
            const timedOut = err.killed && err.signal === 'SIGTERM'
            if (timedOut) {
              console.error(
                `[yt-stream] yt-dlp TIMED OUT after ${timeout}ms for ${videoId} ` +
                  `(killed via ${err.signal || 'SIGTERM'}). This usually means ` +
                  `the n-challenge solve + PO-token generation is slow on this IP.`,
              )
              return reject(
                new Error(
                  `yt-dlp timed out after ${timeout}ms (JS challenge/PO token slow)`,
                ),
              )
            }
            if (stderrMsg)
              console.error(`[yt-stream] yt-dlp stderr: ${stderrMsg}`)
            return reject(new Error(stderrMsg || err.message))
          }
          const urls = stdout
            .trim()
            .split('\n')
            .filter((l) => l.startsWith('http'))
          if (urls.length === 0) return reject(new Error('No stream URL found'))
          if (urls.length > 1) {
            console.warn(
              `[yt-stream] ${videoId}: only got separate video+audio streams ` +
                `(progressive mp4 unavailable this time). Proxy currently only ` +
                `serves the video URL — audio will be missing for this request.`,
            )
          }
          resolve({ video: urls[0], audio: urls.length > 1 ? urls[1] : null })
        },
      )
    })
  } finally {
    releaseYtDlpSlot()
  }
}

// ── Format listing (for quality selector) ────────────────────────────────

const ytFormatsCache = new Map()
const ytFormatsInflight = new Map()

async function listYouTubeFormats(videoId, signal) {
  const cached = ytFormatsCache.get(videoId)
  if (cached && cached.expires > Date.now()) return cached.formats

  const existing = ytFormatsInflight.get(videoId)
  if (existing) return existing

  const promise = (async () => {
    await acquireYtDlpSlot()
    try {
      if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
      return await new Promise((resolve, reject) => {
        const child = execFile(
          YT_DLP,
          [
            '-J', '--no-warnings', '--no-playlist',
            '--js-runtimes', YT_JS_RUNTIME,
            ...(COOKIES_PATH ? ['--cookies', COOKIES_PATH] : []),
            `https://www.youtube.com/watch?v=${videoId}`,
          ],
          { maxBuffer: 10 * 1024 * 1024, timeout: 60000, signal },
          (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).slice(0, 500)))
            try {
              const data = JSON.parse(stdout.trim())
              const formats = (data.formats || []).map((f) => ({
                itag: f.format_id,
                quality: f.format_note || (f.height ? `${f.height}p` : '?'),
                ext: f.ext,
                hasVideo: f.vcodec !== 'none',
                hasAudio: f.acodec !== 'none',
                url: f.url || null,
                filesize: f.filesize || f.filesize_approx || null,
              }))
              // Deduplicate by itag
              const seen = new Set()
              const unique = formats.filter((f) => {
                if (seen.has(f.itag)) return false
                seen.add(f.itag)
                return true
              })
              ytFormatsCache.set(videoId, { formats: unique, expires: Date.now() + 15 * 60 * 1000 })
              resolve(unique)
            } catch {
              reject(new Error('Failed to parse format list'))
            }
          },
        )
      })
    } finally {
      releaseYtDlpSlot()
    }
  })()

  ytFormatsInflight.set(videoId, promise)
  promise.finally(() => ytFormatsInflight.delete(videoId))
  return promise
}

// YouTube's signature/N-challenge logic changes often; a yt-dlp binary that
// hasn't self-updated in a while is one of the most common real causes of
// sudden "Requested format is not available" / extraction failures on a
// server that isn't rebuilt regularly (unlike a dev machine you update by
// hand). We attempt this at most once per process, only when failures look
// like that specific symptom rather than an auth/cookie problem.
let ytDlpUpdateAttempted = false
function tryUpdateYtDlp() {
  if (ytDlpUpdateAttempted) return Promise.resolve(false)
  ytDlpUpdateAttempted = true
  return new Promise((resolve) => {
    console.log(
      '[yt-stream] Stale-binary symptoms detected — running yt-dlp -U once...',
    )
    execFile(YT_DLP, ['-U'], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        console.warn(
          `[yt-stream] yt-dlp self-update failed: ${(stderr || err.message).slice(0, 300)}`,
        )
        return resolve(false)
      }
      console.log(`[yt-stream] yt-dlp -U: ${stdout.trim().slice(0, 300)}`)
      resolve(true)
    })
  })
}

async function getYouTubeStreamUrl(videoId) {
  const cached = ytStreamCache.get(videoId)
  if (cached && cached.expires > Date.now()) return cached.url

  // Deduplicate: if a fetch for this video is already in flight, await the same
  // promise instead of spawning another yt-dlp process. A single video click
  // triggers pre-warm + the foreground stream request + possible browser
  // retries — without this, each one spawns its own ~100-150MB yt-dlp process
  // and OOMs a 512MB instance.
  const existing = ytStreamInflight.get(videoId)
  if (existing) {
    console.log(`[yt-stream] Reusing in-flight fetch for ${videoId}`)
    return existing
  }

  const fetchPromise = (async () => {
    const cacheAndReturn = (result) => {
      ytStreamCache.set(videoId, {
        url: result,
        expires: Date.now() + 15 * 60 * 1000,
      })
      console.log(
        `[yt-stream] Got stream URL for ${videoId}: ${result.video.slice(0, 80)}...`,
      )
      return result
    }

    let lastErr

    // Attempt 1 — android_vr direct /player call (~200-500ms, no subprocess)
    try {
      return cacheAndReturn(await runAndroidVrForStreamUrl(videoId))
    } catch (e) {
      lastErr = e
      console.warn(
        `[yt-stream] Attempt 1 (android_vr) failed for ${videoId}: ${e.message.slice(0, 200)} — falling back to yt-dlp`,
      )
    }

    // Attempt 2 — yt-dlp subprocess (slower, last resort)
    try {
      return cacheAndReturn(await runYtDlpForStreamUrl(videoId))
    } catch (e) {
      lastErr = e
      console.warn(
        `[yt-stream] Attempt 2 (yt-dlp) failed for ${videoId}: ${e.message.slice(0, 200)}`,
      )
    }

    // Attempt 3 — plain retry. Both the bot-check and format-availability
    // failures are sometimes transient per-request rather than per-video.
    try {
      return cacheAndReturn(await runYtDlpForStreamUrl(videoId))
    } catch (e) {
      lastErr = e
      console.warn(
        `[yt-stream] Attempt 3 (yt-dlp retry) failed for ${videoId}: ${e.message.slice(0, 200)}`,
      )
    }

    // Attempt 4 — if this smells like a stale-binary problem specifically
    // (not a cookie/auth problem), try updating yt-dlp once, then retry.
    const looksStale =
      /Requested format is not available|Unable to extract|unsupported url/i.test(
        lastErr.message,
      )
    if (looksStale) {
      const updated = await tryUpdateYtDlp()
      if (updated) {
        try {
          return cacheAndReturn(await runYtDlpForStreamUrl(videoId))
        } catch (e) {
          lastErr = e
          console.error(
            `[yt-stream] Still failing for ${videoId} after self-update: ${e.message.slice(0, 200)}`,
          )
        }
      }
    }

    throw lastErr
  })()

  // Register BEFORE the promise starts resolving so concurrent callers
  // always find the in-flight entry and never spawn duplicates.
  ytStreamInflight.set(videoId, fetchPromise)
  // Always clear the in-flight entry on settle so a failed fetch can be retried
  // by a later request (don't cache rejections).
  fetchPromise.finally(() => ytStreamInflight.delete(videoId))
  return fetchPromise
}

// Shared helper: cross-populate info cache from search results
function populateInfoCache(results) {
  results.forEach((r) => {
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
    const searchArgs = [
      '--dump-json',
      '--no-warnings',
      '--flat-playlist',
      '--no-check-formats',
      '--js-runtimes',
      YT_JS_RUNTIME,
    ]
    if (COOKIES_PATH) searchArgs.push('--cookies', COOKIES_PATH)
    searchArgs.push(`ytsearch30:${query}`)
    execFile(
      YT_DLP,
      searchArgs,
      { maxBuffer: 10 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => {
        if (err) return reject(new Error(`Search failed: ${err.message}`))
        const results = stdout
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try {
              const d = JSON.parse(line)
              return {
                id: d.id,
                title: d.title || 'Untitled',
                channel: d.channel || d.uploader || '',
                duration: d.duration || 0,
                thumbnail: ytThumb(d.id),
              }
            } catch {
              return null
            }
          })
          .filter(Boolean)

        populateInfoCache(results)
        const data = { results, continuationToken: null }
        ytSearchCache.set(cacheKey, {
          data,
          expires: Date.now() + 15 * 60 * 1000,
        })
        resolve(data)
      },
    )
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

function hasFaststart(videoPath) {
  return new Promise((resolve) => {
    try {
      const fd = fs.openSync(videoPath, 'r')
      const buf = Buffer.alloc(1048576) // 1 MB header scan
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const header = buf.toString('binary', 0, bytesRead)
      // If 'moov' appears in the first 1 MB, the metadata is at the front
      resolve(header.includes('moov'))
    } catch {
      resolve(false)
    }
  })
}

async function probeCodecs(videoPath) {
  const [codecInfo, faststart] = await Promise.all([
    new Promise((resolve) => {
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
    }),
    hasFaststart(videoPath),
  ])
  if (!codecInfo) return null
  return { ...codecInfo, faststart }
}

function isWebSafe(codecs) {
  if (!codecs) return true // if we can't tell, don't block playback — assume fine
  if (codecs.isFragmented) return false
  if (!codecs.faststart) return false // maat aan theend — mobile needs metadata up front
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

let movieCache = null
let movieCacheTime = 0
const MOVIE_CACHE_TTL = 60_000

async function scanMovies() {
  if (movieCache && Date.now() - movieCacheTime < MOVIE_CACHE_TTL)
    return movieCache
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
      pageUrl: `/watch/${slug}`,
    })
  }

  // Sort by title
  movies.sort((a, b) => a.title.localeCompare(b.title))
  movieCache = movies
  movieCacheTime = Date.now()
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

app.use('/favicon.ico', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico')),
)

// --- Video streaming (honors browser Range requests as-is) ---
app.get('/movies/:file', async (req, res, next) => {
  const fileName = path.basename(req.params.file)
  if (!/\.(mp4|webm|mkv)$/i.test(fileName)) return next()
  const filePath = path.join(MOVIES_DIR, fileName)
  let stat
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    return res.status(404).end()
  }

  const fileSize = stat.size
  const range = req.headers.range
  let start, end

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-')
    start = parseInt(parts[0], 10)
    end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1
    if (start >= fileSize) {
      res.status(416).set('Content-Range', `bytes */${fileSize}`).end()
      return
    }
  } else {
    start = 0
    end = fileSize - 1
  }

  const chunkSize = end - start + 1
  res.status(206).set({
    'Content-Range': `bytes ${start}-${end}/${fileSize}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': chunkSize,
    'Content-Type': 'video/mp4',
    'Cache-Control': 'public, max-age=86400',
  })

  fs.createReadStream(filePath, { start, end })
    .pipe(res)
    .on('error', (err) => {
      console.error(`Stream error for ${fileName}: ${err.message}`)
      res.end()
    })
})

app.use('/movies', express.static(MOVIES_DIR, { dotfiles: 'allow' }))

// --- YouTube HLS playlist for Rave ---
// Must be before the generic /api/hls/:slug.m3u8 route
app.get('/api/hls/youtube/:id.m3u8', async (req, res) => {
  const videoId = req.params.id
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID')
  }
  try {
    const streamUrls = await getYouTubeStreamUrl(videoId)
    const targetUrl = streamUrls.video || streamUrls
    res.set('Content-Type', 'application/vnd.apple.mpegurl')
    res.send(
      '#EXTM3U\n' +
      '#EXT-X-VERSION:3\n' +
      '#EXT-X-TARGETDURATION:10\n' +
      '#EXTINF:10.0,\n' +
      targetUrl + '\n' +
      '#EXT-X-ENDLIST\n'
    )
  } catch (e) {
    console.error(`[hls] Failed for ${videoId}: ${e.message}`)
    res.status(500).send('Failed to create HLS playlist')
  }
})

// --- HLS streaming (YouTube-style segments) ---
// Converts MP4 into tiny .ts segments via ffmpeg -c copy (remux only, no re-encode).
// The first request kicks off ffmpeg; segments are served as they're generated.
const HLS_CACHE = path.join(__dirname, '.hls-cache')
const pendingHls = new Map()
const hlsLocks = new Set()

if (!fs.existsSync(HLS_CACHE)) fs.mkdirSync(HLS_CACHE, { recursive: true })

function generateHlsSegments(slug, videoPath) {
  if (pendingHls.has(slug)) return pendingHls.get(slug)

  const slugDir = path.join(HLS_CACHE, slug)
  if (!fs.existsSync(slugDir)) fs.mkdirSync(slugDir, { recursive: true })

  const job = new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      [
        '-y',
        '-i',
        videoPath,
        '-c',
        'copy',
        '-map',
        '0',
        '-f',
        'hls',
        '-hls_time',
        '6',
        '-hls_list_size',
        '0',
        '-hls_segment_filename',
        path.join(slugDir, 'seg-%03d.ts'),
        path.join(slugDir, 'playlist.m3u8'),
      ],
      { maxBuffer: 1024 * 1024 * 100 },
      (err) => {
        pendingHls.delete(slug)
        hlsLocks.delete(slug)
        if (err) return reject(err)
        resolve()
      },
    )
  }).catch((err) =>
    console.error(`HLS generation failed for ${slug}: ${err.message}`),
  )

  pendingHls.set(slug, job)
  return job
}

app.get('/api/hls/:slug.m3u8', async (req, res) => {
  const movies = await scanMovies()
  const movie = movies.find((m) => m.slug === req.params.slug)
  if (!movie) return res.status(404).end()

  const slugDir = path.join(HLS_CACHE, req.params.slug)
  const playlistPath = path.join(slugDir, 'playlist.m3u8')
  const videoPath = path.join(MOVIES_DIR, movie.file)

  // Start generation if not already running or cached
  if (!fs.existsSync(playlistPath) && !hlsLocks.has(req.params.slug)) {
    hlsLocks.add(req.params.slug)
    generateHlsSegments(req.params.slug, videoPath)
  }

  // Wait for the playlist to appear (ffmpeg writes it immediately with 0 segments)
  for (let i = 0; i < 30; i++) {
    if (fs.existsSync(playlistPath)) break
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!fs.existsSync(playlistPath))
    return res.status(503).send('Generating playlist...')

  const playlist = fs.readFileSync(playlistPath, 'utf8')
  // Rewrite segment paths to absolute URLs through our proxy
  const base = `${getBaseUrl(req)}/api/hls/${req.params.slug}`
  const rewritten = playlist.replace(/^(.+\.ts)$/gm, `${base}/$1`)
  res.set('Content-Type', 'application/vnd.apple.mpegurl')
  res.set('Access-Control-Allow-Origin', '*')
  res.send(rewritten)
})

app.get('/api/hls/:slug/:segment', (req, res) => {
  const segPath = path.join(
    HLS_CACHE,
    req.params.slug,
    path.basename(req.params.segment),
  )
  if (!fs.existsSync(segPath)) return res.status(404).end()
  const stat = fs.statSync(segPath)
  res.set({
    'Content-Type': 'video/MP2T',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  })
  fs.createReadStream(segPath).pipe(res)
})

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
  const baseUrl = getBaseUrl(req)

  res.render('player', {
    title,
    description,
    thumb,
    pageUrl: `${baseUrl}${pageUrl}`,
    year,
    video,
    BASE_URL: baseUrl,
    slug: movie.slug,
  })
})

// --- YouTube routes ---

app.get('/youtube', async (req, res) => {
  const query = req.query.q || ''

  // If the input is a YouTube URL or an exact 11-character video ID, redirect to the player
  if (query) {
    const match = query.match(
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    )
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
  // the cache will likely already be populated (android_vr is ~0.2-0.5s).
  console.log(`[youtube/watch] Pre-warming stream for ${videoId}`)
  getYouTubeStreamUrl(videoId).catch((e) =>
    console.log(`[youtube/watch] Pre-warm failed for ${videoId}: ${e.message}`),
  )

  // Single /next call gets BOTH video info AND related videos (~0.5s)
  let info = {
    title: 'YouTube Video',
    channel: '',
    description: '',
    thumbnail: ytThumb(videoId),
  }
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
  const baseUrl = getBaseUrl(req)

  res.render('youtube-player', {
    videoId,
    title,
    thumb,
    pageUrl: `${baseUrl}/youtube/watch/${videoId}`,
    videoUrl: `/youtube-stream/${videoId}.mp4?_t=${Date.now()}`,
    description,
    channel,
    info,
    relatedVideos,
    relatedContinuation,
    formatDuration,
    BASE_URL: baseUrl,
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

app.get('/api/youtube/formats/:videoId', async (req, res) => {
  try {
    const videoId = req.params.videoId
    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return res.status(400).json({ error: 'Invalid video ID' })
    }
    const controller = new AbortController()
    req.on('close', () => controller.abort())
    
    const formats = await listYouTubeFormats(videoId, controller.signal)
    res.json({ formats })
  } catch (err) {
    if (err.name === 'AbortError') return res.end()
    res.status(500).json({ error: err.message })
  }
})

// --- YouTube stream redirect ---

app.get('/youtube-stream/:id.mp4', async (req, res) => {
  const videoId = req.params.id
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).send('Invalid video ID')
  }

  const itag = req.query.itag
  console.log(`[youtube-stream] Request for ${videoId}${itag ? ` (itag=${itag})` : ''}`)
  try {
    let targetUrl
    if (itag) {
      // Check if we already have this format's URL in the formats cache
      const cached = ytFormatsCache.get(videoId)
      if (cached && cached.expires > Date.now()) {
        const fmt = cached.formats.find(f => f.itag === itag && f.url)
        if (fmt && fmt.url) {
          console.log(`[youtube-stream] Using cached URL for ${videoId} itag=${itag}`)
          targetUrl = fmt.url
        }
      }
      if (!targetUrl) {
        // Resolve via yt-dlp — uses the global concurrency pool to prevent
        // orphaned processes from previous videos exhausting system resources.
        const controller = new AbortController()
        req.on('close', () => { if (!res.headersSent) controller.abort() })
        
        await acquireYtDlpSlot()
        try {
          if (controller.signal.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
          targetUrl = await new Promise((resolve, reject) => {
            execFile(
              YT_DLP,
              [
                '-f', itag, '-g', '--no-warnings', '--no-playlist',
                '--js-runtimes', YT_JS_RUNTIME,
                ...(COOKIES_PATH ? ['--cookies', COOKIES_PATH] : []),
                `https://www.youtube.com/watch?v=${videoId}`,
              ],
              { maxBuffer: 10 * 1024 * 1024, timeout: 60000, signal: controller.signal },
              (err, stdout, stderr) => {
                if (err) return reject(new Error((stderr || err.message).slice(0, 300)))
                const url = stdout.trim().split('\n').find((l) => l.startsWith('http'))
                if (!url) return reject(new Error('No URL for requested format'))
                resolve(url)
              },
            )
          })
        } finally {
          releaseYtDlpSlot()
        }
      }
    } else {
      const streamUrls = await getYouTubeStreamUrl(videoId)
      targetUrl = streamUrls.video
    }
    console.log(
      `[youtube-stream] Resolved ${videoId} to ${targetUrl.slice(0, 80)}...`,
    )
    if (req.query.json === '1') {
      return res.json({ url: targetUrl })
    }
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private')
    res.set('Pragma', 'no-cache')
    res.set('Expires', '0')
    return res.redirect(302, targetUrl)
  } catch (e) {
    if (e.name === 'AbortError') return res.end()
    console.error(`[youtube-stream] Failed for ${videoId}: ${e.message}`)
    if (!res.headersSent) {
      res.status(500).send(`Failed to fetch YouTube stream: ${e.message}`)
    }
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
  console.log(`Stream Server running on port ${PORT}`)
  console.log(`Serving from: ${MOVIES_DIR}`)
  const movies = await scanMovies()
  console.log(`${movies.length} movie(s) found`)
})
