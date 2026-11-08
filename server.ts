import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const TARGET_BASE = 'https://science-and-fun-bb139b66c325.herokuapp.com';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS headers for all proxy endpoints
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, HEAD');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// 1. Batches API
app.get('/batches.json', async (req: Request, res: Response) => {
  try {
    const upstreamRes = await fetch(`${TARGET_BASE}/batches.json`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    if (!upstreamRes.ok) {
      return res.status(upstreamRes.status).json({ error: 'Failed to fetch batches from upstream' });
    }
    const data = await upstreamRes.json();
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(data);
  } catch (err: any) {
    console.error('Error fetching batches:', err);
    return res.status(500).json({ error: 'Batches proxy failed', message: err.message });
  }
});

// 2. Login & OTP API
app.get('/login', async (req: Request, res: Response) => {
  try {
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const upstreamRes = await fetch(`${TARGET_BASE}/login?${query}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const data = await upstreamRes.json();
    return res.json(data);
  } catch (err: any) {
    console.error('Error in login proxy:', err);
    return res.status(500).json({ error: 'Login proxy failed', message: err.message });
  }
});

// 3. Folder Contents API (/get/*)
app.get('/get/*', async (req: Request, res: Response) => {
  try {
    const subpath = req.params[0] || '';
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${TARGET_BASE}/get/${subpath}${query ? '?' + query : ''}`;
    const upstreamRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const data = await upstreamRes.json();
    return res.json(data);
  } catch (err: any) {
    console.error('Error in folder contents proxy:', err);
    return res.status(500).json({ error: 'Folder contents proxy failed', message: err.message });
  }
});

// 4. Video Details API (/vg/*)
app.get('/vg/*', async (req: Request, res: Response) => {
  try {
    const subpath = req.params[0] || '';
    const query = new URLSearchParams(req.query as Record<string, string>).toString();
    const url = `${TARGET_BASE}/vg/${subpath}${query ? '?' + query : ''}`;
    const upstreamRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const data = await upstreamRes.json();
    return res.json(data);
  } catch (err: any) {
    console.error('Error in video details proxy:', err);
    return res.status(500).json({ error: 'Video details proxy failed', message: err.message });
  }
});

// 5. Video Stream & HLS Playlist Proxy (/video)
app.get('/video', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) {
    return res.status(400).send('Missing url query parameter');
  }

  const isM3u8 = targetUrl.toLowerCase().includes('.m3u8');

  try {
    if (isM3u8) {
      // First try fetching the m3u8 playlist through upstream proxy
      let playlistText = '';
      let upstreamM3u8 = await fetch(`${TARGET_BASE}/video?url=${encodeURIComponent(targetUrl)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });

      if (upstreamM3u8.ok) {
        playlistText = await upstreamM3u8.text();
      } else {
        // Fallback: fetch directly and rewrite lines
        const directRes = await fetch(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            'Referer': 'https://appx-play.akamai.net.in/'
          }
        });
        if (!directRes.ok) {
          return res.status(directRes.status).send('Failed to fetch m3u8 playlist');
        }
        playlistText = await directRes.text();
      }

      // Rewrite segment lines and keys to point back to /video?url=...
      const lines = playlistText.split('\n');
      const rewrittenLines = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return line;
        if (trimmed.startsWith('#')) {
          return line.replace(/URI="([^"]+)"/g, (_, uri) => {
            const resolved = new URL(uri, targetUrl).href;
            return `URI="/video?url=${encodeURIComponent(resolved)}"`;
          });
        }
        // If line is already a /video?url= link, keep as is
        if (trimmed.startsWith('/video?url=')) {
          return trimmed;
        }
        const resolved = new URL(trimmed, targetUrl).href;
        return `/video?url=${encodeURIComponent(resolved)}`;
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.send(rewrittenLines.join('\n'));
    }

    // Media segment (.ts, .mp4, key, etc.)
    const rangeHeader = req.headers.range;
    const reqHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Referer': 'https://appx-play.akamai.net.in/'
    };
    if (rangeHeader) {
      reqHeaders['Range'] = rangeHeader;
    }

    let mediaRes = await fetch(targetUrl, { headers: reqHeaders });
    if (!mediaRes.ok && mediaRes.status !== 206) {
      // Fallback via upstream proxy
      mediaRes = await fetch(`${TARGET_BASE}/video?url=${encodeURIComponent(targetUrl)}`, { headers: reqHeaders });
    }

    res.status(mediaRes.status);
    const passHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
    for (const [k, v] of mediaRes.headers.entries()) {
      if (passHeaders.includes(k.toLowerCase())) {
        res.setHeader(k, v);
      }
    }
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (mediaRes.body) {
      Readable.fromWeb(mediaRes.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('Error in video proxy:', err);
    if (!res.headersSent) {
      res.status(500).send('Video streaming error: ' + err.message);
    }
  }
});

// 6. MPD Proxy (/mpd)
app.get('/mpd', async (req: Request, res: Response) => {
  const targetUrl = req.query.url as string;
  if (!targetUrl) return res.status(400).send('Missing url parameter');

  try {
    const upstreamRes = await fetch(`${TARGET_BASE}/mpd?url=${encodeURIComponent(targetUrl)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const text = await upstreamRes.text();
    res.setHeader('Content-Type', 'application/dash+xml; charset=utf-8');
    return res.send(text);
  } catch (err: any) {
    return res.status(500).send('MPD proxy error: ' + err.message);
  }
});

// 7. DRM License Proxy (/license-proxy)
app.all('/license-proxy', async (req: Request, res: Response) => {
  try {
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };
    if (req.headers['pallycon-customdata-v2']) {
      headers['pallycon-customdata-v2'] = req.headers['pallycon-customdata-v2'] as string;
    }
    if (req.headers['content-type']) {
      headers['content-type'] = req.headers['content-type'] as string;
    }

    const upstreamRes = await fetch(`${TARGET_BASE}/license-proxy`, {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined
    });

    res.status(upstreamRes.status);
    for (const [k, v] of upstreamRes.headers.entries()) {
      res.setHeader(k, v);
    }

    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    res.status(500).send('License proxy error: ' + err.message);
  }
});

// 8. PDF Proxy & Viewer (/pdf)
app.get('/pdf', async (req: Request, res: Response) => {
  const pdfUrl = req.query.url as string;
  if (!pdfUrl) {
    return res.status(400).send('Missing url parameter');
  }

  try {
    // Upstream server decrypts the PDF and serves valid application/pdf
    const upstreamRes = await fetch(`${TARGET_BASE}/pdf?url=${encodeURIComponent(pdfUrl)}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Accept': 'application/pdf, text/html, */*'
      }
    });

    if (!upstreamRes.ok) {
      // Direct fetch fallback
      const directRes = await fetch(pdfUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      });
      if (directRes.ok && directRes.body) {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'inline; filename="study-material.pdf"');
        return Readable.fromWeb(directRes.body as any).pipe(res);
      }
      return res.status(upstreamRes.status).send('Unable to load PDF from server');
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="study-material.pdf"');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (upstreamRes.body) {
      Readable.fromWeb(upstreamRes.body as any).pipe(res);
    } else {
      res.end();
    }
  } catch (err: any) {
    console.error('Error fetching PDF:', err);
    res.status(500).send('Error loading PDF: ' + err.message);
  }
});

// Initialize Vite in dev or static files in production
async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const root = process.cwd();

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'custom'
    });

    app.use(vite.middlewares);

    // Serve HTML files with Vite transformation
    app.get('/', async (req, res, next) => {
      try {
        const template = fs.readFileSync(path.resolve(root, 'index.html'), 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        next(e);
      }
    });

    app.get('/content.html', async (req, res, next) => {
      try {
        const template = fs.readFileSync(path.resolve(root, 'content.html'), 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        next(e);
      }
    });

    app.get('/play.html', async (req, res, next) => {
      try {
        const template = fs.readFileSync(path.resolve(root, 'play.html'), 'utf-8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
      } catch (e) {
        next(e);
      }
    });
  } else {
    // Production: serve built static files from dist
    app.use(express.static(path.resolve(root, 'dist')));

    app.get('/', (req, res) => {
      res.sendFile(path.resolve(root, 'dist/index.html'));
    });
    app.get('/content.html', (req, res) => {
      res.sendFile(path.resolve(root, 'dist/content.html'));
    });
    app.get('/play.html', (req, res) => {
      res.sendFile(path.resolve(root, 'dist/play.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GB STUDY server listening on port ${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
