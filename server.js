const express = require('express');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'change-me-in-env';

// ─── Auth middleware ───────────────────────────────────────────────
app.use((req, res, next) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', ffmpeg: checkFfmpeg() });
});

function checkFfmpeg() {
  try {
    execSync('ffmpeg -version', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ─── Main endpoint ────────────────────────────────────────────────
// POST /extract-frames
// Body: { video_url: string, duration_seconds: number (default 90), frames_count: number (default 5) }
// Returns: { frames: [ { timestamp_s: number, base64: string } ], duration_extracted: number }
app.post('/extract-frames', async (req, res) => {
  const { video_url, duration_seconds = 90, frames_count = 5 } = req.body;

  if (!video_url) return res.status(400).json({ error: 'video_url required' });

  const jobId = crypto.randomBytes(8).toString('hex');
  const tmpDir = `/tmp/hf_${jobId}`;
  const videoPath = `${tmpDir}/video.mp4`;
  const clipPath = `${tmpDir}/clip.mp4`;

  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // 1. Download video from presigned URL
    console.log(`[${jobId}] Downloading video...`);
    await downloadFile(video_url, videoPath);

    // 2. Trim to first N seconds (avoids processing huge files)
    console.log(`[${jobId}] Trimming to ${duration_seconds}s...`);
    execSync(
      `ffmpeg -i "${videoPath}" -t ${duration_seconds} -c copy "${clipPath}" -y`,
      { stdio: 'pipe' }
    );

    // 3. Extract frames at evenly spaced timestamps
    const actualDuration = getVideoDuration(clipPath);
    const timestamps = getTimestamps(actualDuration, frames_count);

    console.log(`[${jobId}] Extracting ${timestamps.length} frames at: ${timestamps.join(', ')}s`);

    const frames = [];
    for (const ts of timestamps) {
      const framePath = `${tmpDir}/frame_${ts}.jpg`;
      execSync(
        `ffmpeg -ss ${ts} -i "${clipPath}" -vframes 1 -q:v 3 -vf "scale=1280:-1" "${framePath}" -y`,
        { stdio: 'pipe' }
      );
      if (fs.existsSync(framePath)) {
        const base64 = fs.readFileSync(framePath).toString('base64');
        frames.push({ timestamp_s: ts, base64 });
        fs.unlinkSync(framePath);
      }
    }

    res.json({
      job_id: jobId,
      frames,
      duration_extracted: actualDuration,
      frames_count: frames.length,
    });

  } catch (err) {
    console.error(`[${jobId}] Error:`, err.message);
    res.status(500).json({ error: err.message, job_id: jobId });
  } finally {
    // Cleanup temp files
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
});

// ─── Helpers ──────────────────────────────────────────────────────

function getVideoDuration(filePath) {
  try {
    const out = execSync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`,
      { stdio: 'pipe' }
    ).toString().trim();
    return Math.floor(parseFloat(out));
  } catch {
    return 60; // fallback
  }
}

function getTimestamps(duration, count) {
  // Spread frames across available duration, always include second 0 and last
  const result = [];
  const step = duration / (count - 1);
  for (let i = 0; i < count; i++) {
    result.push(Math.round(i * step));
  }
  return [...new Set(result)]; // dedupe if duration is very short
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith('https') ? https : http;

    const request = client.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${response.statusCode} downloading video`));
      }
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    });

    request.on('error', (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });

    // 5 min timeout for large videos
    request.setTimeout(300000, () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}

// ─── Start ────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Hireflix video microservice running on port ${PORT}`);
  console.log(`ffmpeg available: ${checkFfmpeg()}`);
});
